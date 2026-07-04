-- Phase 3 Step 10: replace the filtered dashboard RPC with a sheet-only implementation.

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

  if nullif(btrim(p_app_key), '') is not null
    or nullif(btrim(p_platform_key), '') is not null
    or nullif(btrim(p_country_key), '') is not null
    or nullif(btrim(p_driver_key), '') is not null
    or nullif(btrim(p_agent_key), '') is not null
    or nullif(btrim(p_priority), '') is not null
    or nullif(btrim(p_channel), '') is not null then
    raise exception 'sheet_only_dimension_filters_unavailable';
  end if;

  with
  metric_rows as materialized (
    select *
    from public.daily_ticket_metrics
    where report_date between p_start_date and p_end_date
  ),
  latest_metric as materialized (
    select *
    from metric_rows
    order by report_date desc
    limit 1
  ),
  trend_rows as materialized (
    select
      report_date,
      new_tickets::bigint as tickets_created,
      solved_tickets::bigint as tickets_solved
    from metric_rows
  ),
  breakdown_rows as materialized (
    select
      dimension_type,
      dimension_key,
      dimension_label,
      sum(ticket_count)::bigint as ticket_count
    from public.daily_distribution_metrics
    where report_date between p_start_date and p_end_date
    group by dimension_type, dimension_key, dimension_label

    union all

    select
      'driver'::text,
      driver_key,
      max(driver_label),
      sum(ticket_count)::bigint
    from public.ticket_driver_metrics
    where report_date between p_start_date and p_end_date
    group by driver_key
  ),
  breakdown_json as (
    select coalesce(
      jsonb_object_agg(dimension_type, items),
      '{}'::jsonb
    ) as data
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
  agent_rows as materialized (
    select
      agent_key,
      max(agent_name) as agent_name,
      sum(solved_tickets)::bigint as solved_tickets,
      (array_agg(
        open_tickets
        order by report_date desc
      ) filter (where open_tickets is not null))[1]::numeric as open_tickets,
      round(
        case
          when sum(solved_tickets) filter (
            where aht_value is not null and solved_tickets > 0
          ) > 0
          then sum(aht_value * solved_tickets) filter (
            where aht_value is not null and solved_tickets > 0
          ) / nullif(sum(solved_tickets) filter (
            where aht_value is not null and solved_tickets > 0
          ), 0)
          else avg(aht_value)
        end::numeric,
        2
      ) as avg_aht_minutes
    from public.agent_productivity
    where report_date between p_start_date and p_end_date
    group by agent_key
  ),
  agent_options as materialized (
    select
      agent_key,
      max(agent_name) as agent_name,
      sum(solved_tickets)::bigint as solved_tickets
    from public.agent_productivity
    group by agent_key
  ),
  option_rows as materialized (
    select
      dimension_type,
      dimension_key,
      dimension_label,
      sum(ticket_count)::bigint as ticket_count
    from public.daily_distribution_metrics
    group by dimension_type, dimension_key, dimension_label

    union all

    select
      'driver'::text,
      driver_key,
      max(driver_label),
      sum(ticket_count)::bigint
    from public.ticket_driver_metrics
    group by driver_key
  ),
  option_json as (
    select coalesce(
      jsonb_object_agg(dimension_type, items),
      '{}'::jsonb
    ) as data
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
    'source', jsonb_build_object(
      'reportingSource', 'google_sheet',
      'dateFiltersAvailable', true,
      'dimensionFiltersAvailable', false
    ),
    'summary', jsonb_build_object(
      'tickets_created', coalesce((select sum(new_tickets)::bigint from metric_rows), 0),
      'tickets_solved', coalesce((select sum(solved_tickets)::bigint from metric_rows), 0),
      'backlog_open', (select unsolved_tickets::bigint from latest_metric),
      'backlog_over_24h', null,
      'backlog_over_48h', null,
      'first_response_minutes', null,
      'resolution_minutes', null,
      'reopened_tickets', null
    ),
    'trend', coalesce((
      select jsonb_agg(to_jsonb(trend_rows) order by report_date)
      from trend_rows
    ), '[]'::jsonb),
    'breakdowns', jsonb_build_object(
      'app', '[]'::jsonb,
      'platform', '[]'::jsonb,
      'country', '[]'::jsonb,
      'driver', '[]'::jsonb,
      'priority', '[]'::jsonb,
      'channel', '[]'::jsonb
    ) || (select data from breakdown_json),
    'agents', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'agent_key', agent_key,
          'agent_name', agent_name,
          'solved_tickets', solved_tickets,
          'open_tickets', open_tickets,
          'avg_aht_minutes', avg_aht_minutes
        )
        order by solved_tickets desc, agent_name
      )
      from agent_rows
    ), '[]'::jsonb),
    'options', jsonb_build_object(
      'app', '[]'::jsonb,
      'platform', '[]'::jsonb,
      'country', '[]'::jsonb,
      'driver', '[]'::jsonb,
      'agent', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'key', agent_key,
            'label', agent_name,
            'ticket_count', solved_tickets
          )
          order by agent_name
        )
        from agent_options
      ), '[]'::jsonb),
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
  date, date, text, text, text, text, text, text, text, text
)
from public, anon;

grant execute
on function public.get_dashboard_filtered_data(
  date, date, text, text, text, text, text, text, text, text
)
to authenticated, service_role;

comment on function public.get_dashboard_filtered_data(
  date, date, text, text, text, text, text, text, text, text
) is
  'Returns date-bounded dashboard data from Google Sheet reporting tables only. Dimension intersections are unavailable in the current workbook.';

notify pgrst, 'reload schema';

commit;
