-- Phase 3 Step 10 sheet-only reporting verification.
-- Read-only: this query does not create, update, or delete data.

with required_objects as (
  select
    to_regclass('public.daily_ticket_metrics') is not null as daily_metrics_exists,
    to_regclass('public.daily_distribution_metrics') is not null as distribution_metrics_exists,
    to_regclass('public.agent_productivity') is not null as productivity_exists,
    to_regclass('public.ticket_driver_metrics') is not null as driver_metrics_exists,
    to_regclass('public.agent_dimension_metrics') is not null as agent_dimensions_exists,
    to_regclass('public.dashboard_sync_runs') is not null as sync_view_exists,
    to_regclass('public.dashboard_data_quality_results') is not null as quality_table_exists
),
function_definitions as (
  select
    lower(pg_get_functiondef(
      'public.get_dashboard_filtered_data(date,date,text,text,text,text,text,text,text,text)'::regprocedure
    )) as dashboard_definition,
    lower(pg_get_functiondef(
      'public.get_agent_analytics_dashboard(date,date,text,text)'::regprocedure
    )) as agent_definition
),
function_health as (
  select
    dashboard_definition like '%public.daily_ticket_metrics%' as dashboard_uses_daily_metrics,
    dashboard_definition like '%public.daily_distribution_metrics%' as dashboard_uses_distributions,
    dashboard_definition like '%public.agent_productivity%' as dashboard_uses_productivity,
    dashboard_definition like '%public.ticket_driver_metrics%' as dashboard_uses_drivers,
    dashboard_definition not like '%ticket_events%' as dashboard_avoids_ticket_events,
    dashboard_definition not like '%ticket_dimension_profiles%' as dashboard_avoids_ticket_profiles,
    dashboard_definition not like '%agent_identity_map%' as dashboard_avoids_agent_map,
    dashboard_definition not like '%zendesk_agent_directory%' as dashboard_avoids_zendesk_directory,
    agent_definition like '%public.agent_productivity%' as agent_uses_productivity,
    agent_definition like '%public.daily_ticket_metrics%' as agent_uses_daily_metrics,
    agent_definition not like '%ticket_events%' as agent_avoids_ticket_events,
    agent_definition not like '%ticket_dimension_profiles%' as agent_avoids_ticket_profiles,
    agent_definition not like '%agent_identity_map%' as agent_avoids_agent_map,
    agent_definition not like '%zendesk_agent_directory%' as agent_avoids_zendesk_directory
  from function_definitions
),
latest_dates as (
  select
    (select max(report_date) from public.daily_ticket_metrics) as daily_latest,
    (select max(report_date) from public.daily_distribution_metrics) as distribution_latest,
    (select max(report_date) from public.agent_productivity) as productivity_latest,
    (select max(report_date) from public.ticket_driver_metrics) as driver_latest
),
latest_run as (
  select *
  from public.dashboard_sync_runs
  order by started_at desc
  limit 1
),
quality_health as (
  select
    count(*)::integer as total_checks,
    count(*) filter (where status = 'fail')::integer as failed_checks,
    count(*) filter (where status = 'warning')::integer as warning_checks
  from public.dashboard_data_quality_results
  where sync_run_id = (select id::text from latest_run)
),
checks as (
  select
    10 as sort_order,
    'required_sheet_reporting_objects'::text as check_name,
    case when
      daily_metrics_exists
      and distribution_metrics_exists
      and productivity_exists
      and driver_metrics_exists
      and agent_dimensions_exists
      and sync_view_exists
      and quality_table_exists
    then 'PASS' else 'FAIL' end as status,
    to_jsonb(required_objects) as details
  from required_objects

  union all

  select
    20,
    'active_rpcs_are_sheet_only',
    case when
      dashboard_uses_daily_metrics
      and dashboard_uses_distributions
      and dashboard_uses_productivity
      and dashboard_uses_drivers
      and dashboard_avoids_ticket_events
      and dashboard_avoids_ticket_profiles
      and dashboard_avoids_agent_map
      and dashboard_avoids_zendesk_directory
      and agent_uses_productivity
      and agent_uses_daily_metrics
      and agent_avoids_ticket_events
      and agent_avoids_ticket_profiles
      and agent_avoids_agent_map
      and agent_avoids_zendesk_directory
    then 'PASS' else 'FAIL' end,
    to_jsonb(function_health)
  from function_health

  union all

  select
    30,
    'latest_google_sheet_sync',
    case
      when not exists (select 1 from latest_run) then 'REVIEW'
      when (select status from latest_run) <> 'success' then 'FAIL'
      when (select reporting_source from latest_run) <> 'google_sheet' then 'FAIL'
      when (select quality_status from latest_run) = 'pending' then 'REVIEW'
      when (select quality_status from latest_run) = 'fail' then 'FAIL'
      else 'PASS'
    end,
    coalesce((select to_jsonb(latest_run) from latest_run), '{}'::jsonb)

  union all

  select
    40,
    'latest_sync_quality_checks',
    case
      when total_checks = 0 then 'REVIEW'
      when failed_checks > 0 then 'FAIL'
      else 'PASS'
    end,
    jsonb_build_object(
      'total_checks', total_checks,
      'failed_checks', failed_checks,
      'warning_checks', warning_checks
    )
  from quality_health

  union all

  select
    50,
    'sheet_reporting_latest_dates',
    case
      when daily_latest is null
        or distribution_latest is null
        or productivity_latest is null
        or driver_latest is null
      then 'FAIL'
      when daily_latest = distribution_latest
        and daily_latest = productivity_latest
        and daily_latest = driver_latest
      then 'PASS'
      else 'REVIEW'
    end,
    to_jsonb(latest_dates)
  from latest_dates
)
select check_name, status, details
from checks
order by sort_order;
