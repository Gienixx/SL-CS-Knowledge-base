-- Phase 2 Step 12 acceptance verification.
-- This script is read-only. It does not create, update, or delete data.
--
-- PASS means the live Supabase state satisfies the automated acceptance check.
-- REVIEW means a person must confirm an external system, such as Apps Script.
-- FAIL means Phase 2 should not be accepted until the reported issue is fixed.

with metric_health as (
  select
    'daily_ticket_metrics'::text as dataset,
    count(*)::bigint as total_rows,
    count(distinct report_date)::bigint as distinct_keys,
    count(*) filter (
      where new_tickets < 0
         or unsolved_tickets < 0
         or solved_tickets < 0
         or one_touch_resolution not between 0 and 1
         or reopened_rate not between 0 and 1
    )::bigint as invalid_rows,
    max(report_date) as latest_report_date
  from public.daily_ticket_metrics

  union all

  select
    'daily_distribution_metrics',
    count(*)::bigint,
    count(distinct (report_date, dimension_type, dimension_key))::bigint,
    count(*) filter (where ticket_count < 0)::bigint,
    max(report_date)
  from public.daily_distribution_metrics

  union all

  select
    'agent_productivity',
    count(*)::bigint,
    count(distinct (report_date, agent_key))::bigint,
    count(*) filter (
      where solved_tickets < 0
         or open_tickets < 0
         or aht_value < 0
         or aht_unit is distinct from 'minutes.seconds'
    )::bigint,
    max(report_date)
  from public.agent_productivity

  union all

  select
    'ticket_driver_metrics',
    count(*)::bigint,
    count(distinct (report_date, driver_key))::bigint,
    count(*) filter (where ticket_count < 0)::bigint,
    max(report_date)
  from public.ticket_driver_metrics
),
date_health as (
  select
    min(latest_report_date) as oldest_latest_date,
    max(latest_report_date) as newest_latest_date,
    count(*) filter (where latest_report_date is null) as missing_latest_dates
  from metric_health
),
security_health as (
  select
    c.relname as table_name,
    c.relrowsecurity as rls_enabled,
    has_table_privilege(
      'authenticated',
      format('%I.%I', n.nspname, c.relname),
      'SELECT'
    ) as authenticated_can_select,
    (
      has_table_privilege(
        'authenticated',
        format('%I.%I', n.nspname, c.relname),
        'INSERT'
      )
      or has_table_privilege(
        'authenticated',
        format('%I.%I', n.nspname, c.relname),
        'UPDATE'
      )
      or has_table_privilege(
        'authenticated',
        format('%I.%I', n.nspname, c.relname),
        'DELETE'
      )
    ) as authenticated_can_write
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = any (array[
      'daily_ticket_metrics',
      'daily_distribution_metrics',
      'agent_productivity',
      'ticket_driver_metrics'
    ])
),
policy_health as (
  select
    tablename as table_name,
    count(*) filter (
      where cmd = 'SELECT'
        and 'authenticated'::name = any (roles)
    ) as authenticated_select_policies,
    count(*) filter (
      where cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE')
        and 'authenticated'::name = any (roles)
    ) as authenticated_write_policies
  from pg_policies
  where schemaname = 'public'
    and tablename = any (array[
      'daily_ticket_metrics',
      'daily_distribution_metrics',
      'agent_productivity',
      'ticket_driver_metrics'
    ])
  group by tablename
),
index_health as (
  select
    count(*) filter (
      where indexname = 'daily_ticket_metrics_report_date_uidx'
    ) as daily_ticket_unique_index,
    count(*) filter (
      where indexname = 'daily_distribution_metrics_key_uidx'
    ) as distribution_unique_index,
    count(*) filter (
      where indexname = 'agent_productivity_key_uidx'
    ) as agent_unique_index,
    count(*) filter (
      where indexname = 'ticket_driver_metrics_key_uidx'
    ) as driver_unique_index
  from pg_indexes
  where schemaname = 'public'
),
latest_apps_script_sync as (
  select
    latest.started_at,
    latest.completed_at,
    latest.status,
    latest.report_date,
    latest.rows_imported,
    latest.error_message
  from (values (1)) as seed(value)
  left join lateral (
    select
      started_at,
      completed_at,
      status,
      report_date,
      rows_imported,
      error_message
    from public.sheet_sync_runs
    where sync_source = 'apps_script'
    order by started_at desc
    limit 1
  ) as latest on true
),
acceptance_checks as (
  select
    10 as sort_order,
    'metric_data_integrity'::text as check_name,
    case
      when count(*) = 4
       and bool_and(total_rows > 0)
       and bool_and(total_rows = distinct_keys)
       and bool_and(invalid_rows = 0)
      then 'PASS'
      else 'FAIL'
    end as status,
    jsonb_agg(
      jsonb_build_object(
        'dataset', dataset,
        'total_rows', total_rows,
        'duplicate_rows', total_rows - distinct_keys,
        'invalid_rows', invalid_rows,
        'latest_report_date', latest_report_date
      )
      order by dataset
    ) as details
  from metric_health

  union all

  select
    20,
    'cross_table_date_consistency',
    case
      when missing_latest_dates = 0
       and oldest_latest_date = newest_latest_date
      then 'PASS'
      else 'FAIL'
    end,
    jsonb_build_object(
      'oldest_latest_date', oldest_latest_date,
      'newest_latest_date', newest_latest_date,
      'missing_latest_dates', missing_latest_dates
    )
  from date_health

  union all

  select
    30,
    'unique_indexes',
    case
      when daily_ticket_unique_index = 1
       and distribution_unique_index = 1
       and agent_unique_index = 1
       and driver_unique_index = 1
      then 'PASS'
      else 'FAIL'
    end,
    jsonb_build_object(
      'daily_ticket_metrics', daily_ticket_unique_index = 1,
      'daily_distribution_metrics', distribution_unique_index = 1,
      'agent_productivity', agent_unique_index = 1,
      'ticket_driver_metrics', driver_unique_index = 1
    )
  from index_health

  union all

  select
    40,
    'authenticated_read_only_access',
    case
      when count(*) = 4
       and bool_and(rls_enabled)
       and bool_and(authenticated_can_select)
       and bool_and(not authenticated_can_write)
      then 'PASS'
      else 'FAIL'
    end,
    jsonb_agg(
      jsonb_build_object(
        'table', table_name,
        'rls_enabled', rls_enabled,
        'can_select', authenticated_can_select,
        'can_write', authenticated_can_write
      )
      order by table_name
    )
  from security_health

  union all

  select
    50,
    'authenticated_policies',
    case
      when count(*) = 4
       and bool_and(authenticated_select_policies >= 1)
       and bool_and(authenticated_write_policies = 0)
      then 'PASS'
      else 'FAIL'
    end,
    jsonb_agg(
      jsonb_build_object(
        'table', table_name,
        'select_policies', authenticated_select_policies,
        'write_policies', authenticated_write_policies
      )
      order by table_name
    )
  from policy_health

  union all

  select
    60,
    'latest_apps_script_sync',
    case
      when status = 'success'
       and completed_at is not null
       and error_message is null
       and completed_at >= now() - interval '36 hours'
      then 'PASS'
      when status = 'success'
       and completed_at is not null
       and error_message is null
      then 'REVIEW'
      else 'FAIL'
    end,
    jsonb_build_object(
      'started_at', started_at,
      'completed_at', completed_at,
      'status', status,
      'report_date', report_date,
      'rows_imported', rows_imported,
      'error_message', error_message,
      'age_hours',
        round(
          extract(epoch from (now() - completed_at))::numeric / 3600,
          2
        )
    )
  from latest_apps_script_sync

  union all

  select
    70,
    'apps_script_trigger_configuration',
    'REVIEW',
    jsonb_build_object(
      'action', 'Run inspectDashboardSyncTriggers in Apps Script',
      'expected_valid', true,
      'expected_currentTriggerCount', 1,
      'expected_legacyTriggerCount', 0,
      'expected_handler', 'syncAllDashboardData',
      'expected_schedule', 'Daily around 12 PM America/New_York'
    )
)
select
  check_name,
  status,
  details
from acceptance_checks
order by sort_order;
