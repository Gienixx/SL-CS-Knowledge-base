begin;

insert into public.zendesk_sync_state (stream_key)
values ('ticket_metric_events')
on conflict (stream_key) do nothing;

create or replace function public.get_sla_response_dashboard(
  p_start_date date,
  p_end_date date,
  p_app_key text default null,
  p_platform_key text default null,
  p_country_key text default null,
  p_driver_key text default null,
  p_agent_key text default null,
  p_priority text default null,
  p_channel text default null,
  p_time_zone text default 'America/New_York'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_time_zone text;
begin
  if p_start_date is null or p_end_date is null then
    raise exception 'sla_response_dates_required';
  end if;

  if p_start_date > p_end_date then
    raise exception 'sla_response_date_range_invalid';
  end if;

  if p_end_date - p_start_date > 366 then
    raise exception 'sla_response_date_range_too_large';
  end if;

  v_time_zone := nullif(btrim(p_time_zone), '');
  if v_time_zone is null then
    raise exception 'sla_response_time_zone_required';
  end if;
  perform now() at time zone v_time_zone;

  with
  bounds as materialized (
    select
      p_start_date::timestamp at time zone v_time_zone as range_start,
      (p_end_date + 1)::timestamp at time zone v_time_zone as range_end
  ),
  sla_state as materialized (
    select last_success_at
    from public.zendesk_sync_state
    where stream_key = 'ticket_metric_events'
  ),
  created_tickets as materialized (
    select ticket_id, min(event_timestamp) as created_at
    from public.ticket_events
    where event_type = 'created'
    group by ticket_id
  ),
  event_dimensions as materialized (
    select
      event.ticket_id,
      (array_agg(
        event.agent_key
        order by event.event_timestamp desc, event.source_event_id desc
      ) filter (
        where event.agent_key is not null
          and event.event_type in ('created', 'assigned')
      ))[1] as agent_key,
      (array_agg(
        event.priority
        order by event.event_timestamp desc, event.source_event_id desc
      ) filter (
        where event.priority is not null
          and event.event_type in ('created', 'priority_changed')
      ))[1] as priority,
      (array_agg(
        event.channel
        order by event.event_timestamp desc, event.source_event_id desc
      ) filter (
        where event.channel is not null
          and event.event_type = 'created'
      ))[1] as channel
    from public.ticket_events as event
    cross join bounds
    where event.event_timestamp < bounds.range_end
    group by event.ticket_id
  ),
  eligible_tickets as materialized (
    select
      created.ticket_id,
      created.created_at,
      dimensions.agent_key,
      profile.app_key,
      profile.platform_key,
      profile.country_key,
      profile.driver_key,
      dimensions.priority,
      dimensions.channel
    from created_tickets as created
    cross join bounds
    left join public.ticket_dimension_profiles as profile
      on profile.ticket_id = created.ticket_id
    left join event_dimensions as dimensions
      on dimensions.ticket_id = created.ticket_id
    where created.created_at < bounds.range_end
  ),
  selected_tickets as materialized (
    select *
    from eligible_tickets
    where (
      nullif(btrim(p_app_key), '') is null or
      app_key = lower(btrim(p_app_key))
    )
      and (
        nullif(btrim(p_platform_key), '') is null or
        platform_key = lower(btrim(p_platform_key))
      )
      and (
        nullif(btrim(p_country_key), '') is null or
        country_key = lower(btrim(p_country_key))
      )
      and (
        nullif(btrim(p_driver_key), '') is null or
        driver_key = lower(btrim(p_driver_key))
      )
      and (
        nullif(btrim(p_agent_key), '') is null or
        agent_key = lower(btrim(p_agent_key))
      )
      and (
        nullif(btrim(p_priority), '') is null or
        priority = lower(btrim(p_priority))
      )
      and (
        nullif(btrim(p_channel), '') is null or
        channel = lower(btrim(p_channel))
      )
  ),
  period_created as materialized (
    select selected.*
    from selected_tickets as selected
    cross join bounds
    where selected.created_at >= bounds.range_start
      and selected.created_at < bounds.range_end
  ),
  response_events as materialized (
    select
      event.ticket_id,
      event.event_timestamp,
      case
        when event.metadata ->> 'calendar_minutes'
          ~ '^[0-9]+([.][0-9]+)?$'
        then (event.metadata ->> 'calendar_minutes')::numeric
        else null
      end as calendar_minutes,
      case
        when event.metadata ->> 'business_minutes'
          ~ '^[0-9]+([.][0-9]+)?$'
        then (event.metadata ->> 'business_minutes')::numeric
        else null
      end as business_minutes
    from public.ticket_events as event
    join selected_tickets as selected using (ticket_id)
    cross join bounds
    where event.event_type = 'first_response'
      and event.event_timestamp >= bounds.range_start
      and event.event_timestamp < bounds.range_end
  ),
  lifecycle_events as materialized (
    select
      event.ticket_id,
      event.source_event_id,
      event.event_timestamp,
      event.event_type in ('solved', 'closed') as is_terminal,
      case event.event_type
        when 'status_changed' then 1
        when 'reopened' then 2
        when 'solved' then 3
        when 'closed' then 4
        else 0
      end as state_order
    from public.ticket_events as event
    join selected_tickets as selected using (ticket_id)
    cross join bounds
    where event.event_type in (
      'status_changed',
      'reopened',
      'solved',
      'closed'
    )
      and event.event_timestamp < bounds.range_end
  ),
  current_state as materialized (
    select distinct on (selected.ticket_id)
      selected.ticket_id,
      selected.created_at,
      lifecycle.event_timestamp,
      coalesce(lifecycle.is_terminal, false) as is_terminal
    from selected_tickets as selected
    left join lifecycle_events as lifecycle using (ticket_id)
    order by
      selected.ticket_id,
      lifecycle.event_timestamp desc nulls last,
      lifecycle.state_order desc nulls last,
      lifecycle.source_event_id desc nulls last
  ),
  resolved_tickets as materialized (
    select
      ticket_id,
      event_timestamp as resolution_at,
      round(
        extract(epoch from (event_timestamp - created_at))::numeric / 60.0,
        2
      ) as resolution_minutes
    from current_state
    cross join bounds
    where is_terminal = true
      and event_timestamp >= bounds.range_start
      and event_timestamp < bounds.range_end
      and event_timestamp >= created_at
  ),
  sla_events as materialized (
    select
      event.ticket_id,
      event.event_timestamp,
      coalesce(nullif(event.metadata ->> 'metric', ''), 'unknown') as metric
    from public.ticket_events as event
    join selected_tickets as selected using (ticket_id)
    cross join bounds
    where event.event_type = 'sla_breached'
      and event.event_timestamp >= bounds.range_start
      and event.event_timestamp < bounds.range_end
  ),
  date_spine as materialized (
    select day_value::date as report_date
    from generate_series(
      p_start_date::timestamp,
      p_end_date::timestamp,
      interval '1 day'
    ) as day_value
  ),
  trend_rows as materialized (
    select
      dates.report_date,
      (
        select round(avg(response.calendar_minutes), 2)
        from response_events as response
        where (response.event_timestamp at time zone v_time_zone)::date =
          dates.report_date
      ) as first_response_minutes,
      (
        select round(avg(resolved.resolution_minutes), 2)
        from resolved_tickets as resolved
        where (resolved.resolution_at at time zone v_time_zone)::date =
          dates.report_date
      ) as resolution_minutes,
      case
        when exists (
          select 1 from sla_state where last_success_at is not null
        ) then (
          select count(*)::bigint
          from sla_events as breach
          where (breach.event_timestamp at time zone v_time_zone)::date =
            dates.report_date
        )
        else null::bigint
      end as sla_breaches
    from date_spine as dates
  ),
  response_bucket_rows as materialized (
    select bucket_key, bucket_label, bucket_order, count(*)::bigint as ticket_count
    from (
      select
        case
          when calendar_minutes < 15 then 'under_15m'
          when calendar_minutes < 60 then '15m_to_1h'
          when calendar_minutes < 240 then '1h_to_4h'
          when calendar_minutes < 1440 then '4h_to_24h'
          else 'over_24h'
        end as bucket_key,
        case
          when calendar_minutes < 15 then 'Under 15 minutes'
          when calendar_minutes < 60 then '15 minutes to 1 hour'
          when calendar_minutes < 240 then '1 to 4 hours'
          when calendar_minutes < 1440 then '4 to 24 hours'
          else 'Over 24 hours'
        end as bucket_label,
        case
          when calendar_minutes < 15 then 1
          when calendar_minutes < 60 then 2
          when calendar_minutes < 240 then 3
          when calendar_minutes < 1440 then 4
          else 5
        end as bucket_order
      from response_events
      where calendar_minutes is not null
    ) as bucketed
    group by bucket_key, bucket_label, bucket_order
  ),
  resolution_bucket_rows as materialized (
    select bucket_key, bucket_label, bucket_order, count(*)::bigint as ticket_count
    from (
      select
        case
          when resolution_minutes < 60 then 'under_1h'
          when resolution_minutes < 240 then '1h_to_4h'
          when resolution_minutes < 1440 then '4h_to_24h'
          when resolution_minutes < 2880 then '1d_to_2d'
          else 'over_2d'
        end as bucket_key,
        case
          when resolution_minutes < 60 then 'Under 1 hour'
          when resolution_minutes < 240 then '1 to 4 hours'
          when resolution_minutes < 1440 then '4 to 24 hours'
          when resolution_minutes < 2880 then '1 to 2 days'
          else 'Over 2 days'
        end as bucket_label,
        case
          when resolution_minutes < 60 then 1
          when resolution_minutes < 240 then 2
          when resolution_minutes < 1440 then 3
          when resolution_minutes < 2880 then 4
          else 5
        end as bucket_order
      from resolved_tickets
    ) as bucketed
    group by bucket_key, bucket_label, bucket_order
  ),
  sla_metric_rows as materialized (
    select
      metric as metric_key,
      initcap(replace(metric, '_', ' ')) as metric_label,
      count(*)::bigint as breach_count
    from sla_events
    group by metric
  ),
  option_source as materialized (
    select 'app'::text as dimension_type, app_key as dimension_key,
      initcap(replace(app_key, '_', ' ')) as dimension_label, ticket_id
    from eligible_tickets where app_key is not null
    union all
    select 'platform', platform_key,
      initcap(replace(platform_key, '_', ' ')), ticket_id
    from eligible_tickets where platform_key is not null
    union all
    select 'country', country_key, upper(country_key), ticket_id
    from eligible_tickets where country_key is not null
    union all
    select 'driver', driver_key,
      initcap(replace(driver_key, '_', ' ')), ticket_id
    from eligible_tickets where driver_key is not null
    union all
    select 'agent', agent_key,
      'Agent ' || replace(agent_key, 'zendesk:', ''), ticket_id
    from eligible_tickets where agent_key is not null
    union all
    select 'priority', priority,
      initcap(replace(priority, '_', ' ')), ticket_id
    from eligible_tickets where priority is not null
    union all
    select 'channel', channel,
      initcap(replace(channel, '_', ' ')), ticket_id
    from eligible_tickets where channel is not null
  ),
  option_rows as materialized (
    select
      dimension_type,
      dimension_key,
      dimension_label,
      count(distinct ticket_id)::bigint as ticket_count
    from option_source
    group by dimension_type, dimension_key, dimension_label
  ),
  option_json as (
    select coalesce(jsonb_object_agg(dimension_type, items), '{}'::jsonb) as data
    from (
      select
        dimension_type,
        jsonb_agg(
          jsonb_build_object(
            'key', dimension_key,
            'label', dimension_label,
            'ticket_count', ticket_count
          )
          order by dimension_label
        ) as items
      from option_rows
      group by dimension_type
    ) as grouped
  )
  select jsonb_build_object(
    'range', jsonb_build_object(
      'startDate', p_start_date,
      'endDate', p_end_date,
      'timeZone', v_time_zone
    ),
    'readiness', jsonb_build_object(
      'slaAvailable', exists (
        select 1 from sla_state where last_success_at is not null
      ),
      'slaLastSyncAt', (
        select last_success_at from sla_state limit 1
      )
    ),
    'summary', jsonb_build_object(
      'tickets_created', (select count(*)::bigint from period_created),
      'responded_tickets', (
        select count(distinct ticket_id)::bigint from response_events
        where calendar_minutes is not null
      ),
      'avg_first_response_calendar_minutes', (
        select round(avg(calendar_minutes), 2) from response_events
      ),
      'median_first_response_calendar_minutes', (
        select round((percentile_cont(0.5) within group (
          order by calendar_minutes
        ))::numeric, 2)
        from response_events
        where calendar_minutes is not null
      ),
      'p90_first_response_calendar_minutes', (
        select round((percentile_cont(0.9) within group (
          order by calendar_minutes
        ))::numeric, 2)
        from response_events
        where calendar_minutes is not null
      ),
      'avg_first_response_business_minutes', (
        select round(avg(business_minutes), 2) from response_events
      ),
      'resolved_tickets', (
        select count(*)::bigint from resolved_tickets
      ),
      'avg_resolution_minutes', (
        select round(avg(resolution_minutes), 2) from resolved_tickets
      ),
      'median_resolution_minutes', (
        select round((percentile_cont(0.5) within group (
          order by resolution_minutes
        ))::numeric, 2)
        from resolved_tickets
      ),
      'p90_resolution_minutes', (
        select round((percentile_cont(0.9) within group (
          order by resolution_minutes
        ))::numeric, 2)
        from resolved_tickets
      ),
      'sla_breaches', case
        when exists (
          select 1 from sla_state where last_success_at is not null
        ) then (select count(*)::bigint from sla_events)
        else null::bigint
      end,
      'sla_breached_tickets', case
        when exists (
          select 1 from sla_state where last_success_at is not null
        ) then (select count(distinct ticket_id)::bigint from sla_events)
        else null::bigint
      end
    ),
    'trend', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'report_date', report_date,
          'first_response_minutes', first_response_minutes,
          'resolution_minutes', resolution_minutes,
          'sla_breaches', sla_breaches
        )
        order by report_date
      )
      from trend_rows
    ), '[]'::jsonb),
    'responseBuckets', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'key', bucket_key,
          'label', bucket_label,
          'ticket_count', ticket_count
        )
        order by bucket_order
      )
      from response_bucket_rows
    ), '[]'::jsonb),
    'resolutionBuckets', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'key', bucket_key,
          'label', bucket_label,
          'ticket_count', ticket_count
        )
        order by bucket_order
      )
      from resolution_bucket_rows
    ), '[]'::jsonb),
    'slaMetrics', case
      when exists (
        select 1 from sla_state where last_success_at is not null
      ) then coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'key', metric_key,
            'label', metric_label,
            'breach_count', breach_count
          )
          order by breach_count desc, metric_label
        )
        from sla_metric_rows
      ), '[]'::jsonb)
      else '[]'::jsonb
    end,
    'options', jsonb_build_object(
      'app', '[]'::jsonb,
      'platform', '[]'::jsonb,
      'country', '[]'::jsonb,
      'driver', '[]'::jsonb,
      'agent', '[]'::jsonb,
      'priority', '[]'::jsonb,
      'channel', '[]'::jsonb
    ) || (select data from option_json)
  )
  into v_result;

  return coalesce(v_result, '{}'::jsonb);
end;
$$;

revoke all
on function public.get_sla_response_dashboard(
  date,
  date,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text
)
from public, anon;

grant execute
on function public.get_sla_response_dashboard(
  date,
  date,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text
)
to authenticated, service_role;

comment on function public.get_sla_response_dashboard(
  date,
  date,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text
) is
  'Returns filtered Zendesk first-response, resolution-time, and trusted SLA-breach reporting.';

notify pgrst, 'reload schema';

commit;
