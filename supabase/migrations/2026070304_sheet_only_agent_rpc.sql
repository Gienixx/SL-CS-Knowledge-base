-- Phase 3 Step 10: replace agent analytics and add sheet sync status reporting.

begin;

create or replace function public.get_agent_analytics_dashboard(
  p_start_date date,
  p_end_date date,
  p_agent_key text default null,
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
    raise exception 'agent_analytics_dates_required';
  end if;

  if p_start_date > p_end_date then
    raise exception 'agent_analytics_date_range_invalid';
  end if;

  if p_end_date - p_start_date > 366 then
    raise exception 'agent_analytics_date_range_too_large';
  end if;

  v_time_zone := nullif(btrim(p_time_zone), '');
  if v_time_zone is null then
    raise exception 'agent_analytics_time_zone_required';
  end if;
  perform now() at time zone v_time_zone;

  with
  productivity_rows as materialized (
    select
      report_date,
      agent_key,
      agent_name,
      solved_tickets,
      open_tickets,
      aht_value
    from public.agent_productivity
    where report_date between p_start_date and p_end_date
      and (
        nullif(btrim(p_agent_key), '') is null
        or agent_key = lower(btrim(p_agent_key))
      )
  ),
  all_team_rows as materialized (
    select
      report_date,
      agent_key,
      agent_name,
      solved_tickets,
      open_tickets,
      aht_value
    from public.agent_productivity
    where report_date between p_start_date and p_end_date
  ),
  agent_rows as materialized (
    select
      agent_key,
      max(agent_name) as agent_name,
      null::text as zendesk_agent_key,
      false as zendesk_mapped,
      sum(solved_tickets)::bigint as solved_tickets,
      (array_agg(
        open_tickets
        order by report_date desc
      ) filter (where open_tickets is not null))[1]::numeric
        as latest_open_tickets,
      round(avg(open_tickets)::numeric, 2) as avg_open_tickets,
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
      ) as avg_aht_minutes,
      round((percentile_cont(0.5) within group (
        order by aht_value
      ) filter (where aht_value is not null))::numeric, 2)
        as median_aht_minutes,
      count(distinct report_date)::integer as reporting_days,
      null::bigint as responded_tickets,
      null::numeric as avg_first_response_minutes,
      null::numeric as median_first_response_minutes,
      null::bigint as resolved_tickets,
      null::bigint as reopened_tickets,
      null::numeric as avg_resolution_minutes,
      null::numeric as median_resolution_minutes
    from productivity_rows
    group by agent_key
  ),
  team_totals as materialized (
    select
      coalesce(sum(solved_tickets), 0)::numeric as solved_tickets,
      coalesce(sum(avg_open_tickets), 0)::numeric as avg_open_tickets,
      coalesce(sum(latest_open_tickets), 0)::numeric as latest_open_tickets
    from (
      select
        agent_key,
        sum(solved_tickets)::numeric as solved_tickets,
        round(avg(open_tickets)::numeric, 2) as avg_open_tickets,
        (array_agg(
          open_tickets
          order by report_date desc
        ) filter (where open_tickets is not null))[1]::numeric
          as latest_open_tickets
      from all_team_rows
      group by agent_key
    ) as totals
  ),
  enriched_agents as materialized (
    select
      agent_rows.*,
      round(
        case
          when team_totals.solved_tickets > 0
          then agent_rows.solved_tickets::numeric / team_totals.solved_tickets
          else null
        end,
        4
      ) as team_output_share,
      round(
        case
          when team_totals.avg_open_tickets > 0
          then agent_rows.avg_open_tickets / team_totals.avg_open_tickets
          else null
        end,
        4
      ) as workload_share,
      round(
        case
          when team_totals.solved_tickets > 0
            and team_totals.avg_open_tickets > 0
            and agent_rows.avg_open_tickets > 0
          then (
            agent_rows.solved_tickets::numeric / team_totals.solved_tickets
          ) / (
            agent_rows.avg_open_tickets / team_totals.avg_open_tickets
          ) * 100
          else null
        end,
        1
      ) as workload_adjusted_index,
      null::numeric as reopen_rate
    from agent_rows
    cross join team_totals
  ),
  trend_rows as materialized (
    select
      report_date,
      sum(solved_tickets)::bigint as solved_tickets,
      sum(open_tickets)::bigint as open_tickets,
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
    from productivity_rows
    group by report_date
  ),
  agent_options as materialized (
    select
      agent_key,
      max(agent_name) as agent_name
    from public.agent_productivity
    group by agent_key
  ),
  team_one_touch as materialized (
    select round(
      case
        when sum(solved_tickets) filter (
          where one_touch_resolution is not null and solved_tickets > 0
        ) > 0
        then sum(one_touch_resolution * solved_tickets) filter (
          where one_touch_resolution is not null and solved_tickets > 0
        ) / nullif(sum(solved_tickets) filter (
          where one_touch_resolution is not null and solved_tickets > 0
        ), 0)
        else avg(one_touch_resolution)
      end::numeric,
      4
    ) as rate
    from public.daily_ticket_metrics
    where report_date between p_start_date and p_end_date
  )
  select jsonb_build_object(
    'range', jsonb_build_object(
      'startDate', p_start_date,
      'endDate', p_end_date,
      'timeZone', v_time_zone
    ),
    'source', jsonb_build_object(
      'reportingSource', 'google_sheet',
      'availableMetrics', jsonb_build_array(
        'solved_tickets',
        'open_tickets',
        'aht',
        'one_touch_resolution'
      )
    ),
    'readiness', jsonb_build_object(
      'reportingSource', 'google_sheet',
      'mappedAgents', 0,
      'unmappedAgents', '[]'::jsonb,
      'eventMetricsAvailable', false
    ),
    'summary', jsonb_build_object(
      'scope_solved_tickets', coalesce((
        select sum(solved_tickets)::bigint from enriched_agents
      ), 0),
      'scope_latest_open_tickets', coalesce((
        select sum(latest_open_tickets)::numeric from enriched_agents
      ), 0),
      'team_solved_tickets', (select solved_tickets from team_totals),
      'team_latest_open_tickets', (select latest_open_tickets from team_totals),
      'avg_aht_minutes', (
        select round(
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
        )
        from productivity_rows
      ),
      'median_aht_minutes', (
        select round((percentile_cont(0.5) within group (
          order by aht_value
        ))::numeric, 2)
        from productivity_rows
        where aht_value is not null
      ),
      'avg_first_response_minutes', null,
      'avg_resolution_minutes', null,
      'reopen_rate', null,
      'team_one_touch_resolution_rate', (select rate from team_one_touch)
    ),
    'agents', coalesce((
      select jsonb_agg(
        to_jsonb(enriched_agents)
        order by solved_tickets desc, agent_name
      )
      from enriched_agents
    ), '[]'::jsonb),
    'trend', coalesce((
      select jsonb_agg(
        to_jsonb(trend_rows)
        order by report_date
      )
      from trend_rows
    ), '[]'::jsonb),
    'options', jsonb_build_object(
      'agents', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'key', agent_key,
            'label', agent_name,
            'mapped', false
          )
          order by agent_name
        )
        from agent_options
      ), '[]'::jsonb)
    )
  )
  into v_result;

  return coalesce(v_result, '{}'::jsonb);
end;
$$;

create or replace function public.get_dashboard_reporting_status()
returns jsonb
language sql
security definer
set search_path = public
as $$
  with latest_run as (
    select *
    from public.dashboard_sync_runs
    order by started_at desc
    limit 1
  ),
  latest_quality as (
    select
      status,
      count(*)::integer as check_count,
      jsonb_agg(
        jsonb_build_object(
          'checkKey', check_key,
          'status', status,
          'observedValue', observed_value,
          'details', details,
          'checkedAt', checked_at
        )
        order by check_key
      ) as checks
    from public.dashboard_data_quality_results
    where sync_run_id = (
      select id::text from latest_run
    )
    group by status
  )
  select jsonb_build_object(
    'reportingSource', 'google_sheet',
    'latestRun', coalesce((
      select to_jsonb(latest_run) from latest_run
    ), '{}'::jsonb),
    'qualityChecks', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'status', status,
          'checkCount', check_count,
          'checks', checks
        )
        order by status
      )
      from latest_quality
    ), '[]'::jsonb),
    'latestReportDates', jsonb_build_object(
      'dailyTicketMetrics', (select max(report_date) from public.daily_ticket_metrics),
      'dailyDistributionMetrics', (select max(report_date) from public.daily_distribution_metrics),
      'agentProductivity', (select max(report_date) from public.agent_productivity),
      'ticketDriverMetrics', (select max(report_date) from public.ticket_driver_metrics)
    )
  );
$$;

revoke all
on function public.get_agent_analytics_dashboard(date, date, text, text)
from public, anon;

grant execute
on function public.get_agent_analytics_dashboard(date, date, text, text)
to authenticated, service_role;

revoke all
on function public.get_dashboard_reporting_status()
from public, anon;

grant execute
on function public.get_dashboard_reporting_status()
to authenticated, service_role;

comment on function public.get_agent_analytics_dashboard(date, date, text, text) is
  'Returns only the agent solved, open, AHT, and team one-touch metrics available in the synchronized Ticket Productivity and Daily Volume tabs.';

comment on function public.get_dashboard_reporting_status() is
  'Returns the latest Google Sheet synchronization and data-quality status.';

notify pgrst, 'reload schema';

commit;
