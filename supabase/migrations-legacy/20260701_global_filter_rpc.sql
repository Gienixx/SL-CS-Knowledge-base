begin;

create or replace function public.get_dashboard_filtered_data(
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
    raise exception 'dashboard_filter_dates_required';
  end if;
  if p_start_date > p_end_date then
    raise exception 'dashboard_filter_date_range_invalid';
  end if;
  if p_end_date - p_start_date > 366 then
    raise exception 'dashboard_filter_date_range_too_large';
  end if;

  v_time_zone := nullif(btrim(p_time_zone), '');
  if v_time_zone is null then
    raise exception 'dashboard_filter_time_zone_required';
  end if;
  perform now() at time zone v_time_zone;

  with
  bounds as materialized (
    select
      p_start_date::timestamp at time zone v_time_zone as range_start,
      (p_end_date + 1)::timestamp at time zone v_time_zone as range_end
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
  period_events as materialized (
    select event.*
    from public.ticket_events as event
    join selected_tickets as selected using (ticket_id)
    cross join bounds
    where event.event_timestamp >= bounds.range_start
      and event.event_timestamp < bounds.range_end
  ),
  state_events as materialized (
    select
      event.ticket_id,
      event.source_event_id,
      event.event_timestamp,
      event.event_type not in ('solved', 'closed') as is_open,
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
      state.event_timestamp,
      coalesce(state.is_open, true) as is_open
    from selected_tickets as selected
    left join state_events as state using (ticket_id)
    order by
      selected.ticket_id,
      state.event_timestamp desc nulls last,
      state.state_order desc nulls last,
      state.source_event_id desc nulls last
  ),
  open_tickets as materialized (
    select selected.*
    from selected_tickets as selected
    join current_state as state using (ticket_id)
    where state.is_open = true
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
        select count(*)::bigint
        from period_created as created
        where (created.created_at at time zone v_time_zone)::date =
          dates.report_date
      ) as tickets_created,
      (
        select count(distinct event.ticket_id)::bigint
        from period_events as event
        where event.event_type = 'solved'
          and (event.event_timestamp at time zone v_time_zone)::date =
            dates.report_date
      ) as tickets_solved
    from date_spine as dates
  ),
  breakdown_source as materialized (
    select
      'app'::text as dimension_type,
      app_key as dimension_key,
      initcap(replace(app_key, '_', ' ')) as dimension_label,
      ticket_id
    from period_created where app_key is not null
    union all
    select
      'platform',
      platform_key,
      initcap(replace(platform_key, '_', ' ')),
      ticket_id
    from period_created where platform_key is not null
    union all
    select 'country', country_key, upper(country_key), ticket_id
    from period_created where country_key is not null
    union all
    select
      'driver',
      driver_key,
      initcap(replace(driver_key, '_', ' ')),
      ticket_id
    from period_created where driver_key is not null
    union all
    select
      'priority',
      priority,
      initcap(replace(priority, '_', ' ')),
      ticket_id
    from period_created where priority is not null
    union all
    select
      'channel',
      channel,
      initcap(replace(channel, '_', ' ')),
      ticket_id
    from period_created where channel is not null
  ),
  breakdown_rows as materialized (
    select
      dimension_type,
      dimension_key,
      dimension_label,
      count(distinct ticket_id)::bigint as ticket_count
    from breakdown_source
    group by dimension_type, dimension_key, dimension_label
  ),
  option_source as materialized (
    select
      'app'::text as dimension_type,
      app_key as dimension_key,
      initcap(replace(app_key, '_', ' ')) as dimension_label,
      ticket_id
    from eligible_tickets where app_key is not null
    union all
    select
      'platform',
      platform_key,
      initcap(replace(platform_key, '_', ' ')),
      ticket_id
    from eligible_tickets where platform_key is not null
    union all
    select 'country', country_key, upper(country_key), ticket_id
    from eligible_tickets where country_key is not null
    union all
    select
      'driver',
      driver_key,
      initcap(replace(driver_key, '_', ' ')),
      ticket_id
    from eligible_tickets where driver_key is not null
    union all
    select
      'agent',
      agent_key,
      'Agent ' || replace(agent_key, 'zendesk:', ''),
      ticket_id
    from eligible_tickets where agent_key is not null
    union all
    select
      'priority',
      priority,
      initcap(replace(priority, '_', ' ')),
      ticket_id
    from eligible_tickets where priority is not null
    union all
    select
      'channel',
      channel,
      initcap(replace(channel, '_', ' ')),
      ticket_id
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
  breakdown_json as (
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
          order by ticket_count desc, dimension_label
        ) as items
      from breakdown_rows
      group by dimension_type
    ) as grouped
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
  ),
  agent_keys as materialized (
    select distinct agent_key
    from selected_tickets
    where agent_key is not null
  ),
  agent_rows as materialized (
    select
      agents.agent_key,
      'Agent ' || replace(agents.agent_key, 'zendesk:', '') as agent_name,
      (
        select count(distinct event.ticket_id)::bigint
        from period_events as event
        join selected_tickets as selected using (ticket_id)
        where selected.agent_key = agents.agent_key
          and event.event_type = 'solved'
      ) as solved_tickets,
      (
        select count(*)::bigint
        from open_tickets
        where agent_key = agents.agent_key
      ) as open_tickets
    from agent_keys as agents
  )
  select jsonb_build_object(
    'range',
    jsonb_build_object(
      'startDate', p_start_date,
      'endDate', p_end_date,
      'timeZone', v_time_zone
    ),
    'summary',
    jsonb_build_object(
      'tickets_created',
      (select count(*)::bigint from period_created),
      'tickets_solved',
      (
        select count(distinct ticket_id)::bigint
        from period_events
        where event_type = 'solved'
      ),
      'backlog_open',
      (select count(*)::bigint from open_tickets),
      'backlog_over_24h',
      (
        select count(*)::bigint
        from open_tickets cross join bounds
        where bounds.range_end - open_tickets.created_at >= interval '24 hours'
      ),
      'backlog_over_48h',
      (
        select count(*)::bigint
        from open_tickets cross join bounds
        where bounds.range_end - open_tickets.created_at >= interval '48 hours'
      ),
      'first_response_minutes',
      (
        select round(avg(
          case
            when metadata ->> 'calendar_minutes'
              ~ '^[0-9]+([.][0-9]+)?$'
            then (metadata ->> 'calendar_minutes')::numeric
            else null
          end
        ), 2)
        from period_events
        where event_type = 'first_response'
      ),
      'resolution_minutes',
      (
        select round(avg(
          extract(epoch from (
            state.event_timestamp - selected.created_at
          )) / 60.0
        ), 2)
        from current_state as state
        join selected_tickets as selected using (ticket_id)
        cross join bounds
        where state.is_open = false
          and state.event_timestamp >= bounds.range_start
          and state.event_timestamp < bounds.range_end
          and state.event_timestamp >= selected.created_at
      ),
      'reopened_tickets',
      (
        select count(distinct ticket_id)::bigint
        from period_events
        where event_type = 'reopened'
      )
    ),
    'trend',
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'report_date', report_date,
          'tickets_created', tickets_created,
          'tickets_solved', tickets_solved
        )
        order by report_date
      )
      from trend_rows
    ), '[]'::jsonb),
    'breakdowns',
    jsonb_build_object(
      'app', '[]'::jsonb,
      'platform', '[]'::jsonb,
      'country', '[]'::jsonb,
      'driver', '[]'::jsonb,
      'priority', '[]'::jsonb,
      'channel', '[]'::jsonb
    ) || (select data from breakdown_json),
    'agents',
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'agent_key', agent_key,
          'agent_name', agent_name,
          'solved_tickets', solved_tickets,
          'open_tickets', open_tickets
        )
        order by solved_tickets desc, agent_name
      )
      from agent_rows
    ), '[]'::jsonb),
    'options',
    jsonb_build_object(
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
on function public.get_dashboard_filtered_data(
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
on function public.get_dashboard_filtered_data(
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

comment on function public.get_dashboard_filtered_data(
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
  'Returns server-filtered dashboard KPIs, trends, breakdowns, agents, and filter options.';

commit;
