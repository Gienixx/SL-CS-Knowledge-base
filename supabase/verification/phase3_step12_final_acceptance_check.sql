-- Phase 3 Step 12 final acceptance verification. Read-only.

with checks as (
  select
    'audit_events_table'::text as check_key,
    case when to_regclass('public.dashboard_audit_events') is not null then 'PASS' else 'FAIL' end as status,
    'Reporting audit history storage exists.'::text as details

  union all

  select
    'alert_events_table',
    case when to_regclass('public.dashboard_alert_events') is not null then 'PASS' else 'FAIL' end,
    'Stored reporting alert history exists.'

  union all

  select
    'active_alerts_view',
    case when to_regclass('public.dashboard_active_alerts') is not null then 'PASS' else 'FAIL' end,
    'Current alerts include stored alerts and computed synchronization freshness.'

  union all

  select
    'audit_events_rls',
    case when coalesce((
      select relrowsecurity
      from pg_class
      where oid = to_regclass('public.dashboard_audit_events')
    ), false) then 'PASS' else 'FAIL' end,
    'Audit history is protected by row-level security.'

  union all

  select
    'alert_events_rls',
    case when coalesce((
      select relrowsecurity
      from pg_class
      where oid = to_regclass('public.dashboard_alert_events')
    ), false) then 'PASS' else 'FAIL' end,
    'Alert history is protected by row-level security.'

  union all

  select
    'sync_operations_trigger',
    case when exists (
      select 1
      from pg_trigger
      where tgname = 'dashboard_sync_operations_trigger'
        and not tgisinternal
    ) then 'PASS' else 'FAIL' end,
    'Synchronization completion and failure events are audited.'

  union all

  select
    'quality_operations_trigger',
    case when exists (
      select 1
      from pg_trigger
      where tgname = 'dashboard_quality_operations_trigger'
        and not tgisinternal
    ) then 'PASS' else 'FAIL' end,
    'Data-quality results create audit and alert history.'

  union all

  select
    'csv_export_audit_rpc',
    case when to_regprocedure(
      'public.record_dashboard_export(text,integer,date,date)'
    ) is not null then 'PASS' else 'FAIL' end,
    'Authenticated CSV exports can be recorded in audit history.'

  union all

  select
    'active_dashboard_rpc_sheet_only',
    case when lower(pg_get_functiondef(
      'public.get_dashboard_filtered_data(date,date,text,text,text,text,text,text,text,text)'::regprocedure
    )) !~ 'ticket_events|ticket_dimension_profiles|agent_identity_map|zendesk_agent_directory'
      then 'PASS' else 'FAIL' end,
    'The active detailed dashboard RPC remains Google Sheet-only.'

  union all

  select
    'active_agent_rpc_sheet_only',
    case when lower(pg_get_functiondef(
      'public.get_agent_analytics_dashboard(date,date,text,text)'::regprocedure
    )) !~ 'ticket_events|ticket_dimension_profiles|agent_identity_map|zendesk_agent_directory'
      then 'PASS' else 'FAIL' end,
    'The active agent analytics RPC remains Google Sheet-only.'

  union all

  select
    'latest_sync_available',
    case when exists (select 1 from public.dashboard_sync_runs)
      then 'PASS' else 'REVIEW' end,
    'At least one Google Sheet synchronization is available for operations monitoring.'

  union all

  select
    'latest_sync_quality',
    coalesce((
      select case quality_status
        when 'pass' then 'PASS'
        when 'warning' then 'REVIEW'
        when 'fail' then 'FAIL'
        else 'REVIEW'
      end
      from public.dashboard_sync_runs
      order by started_at desc
      limit 1
    ), 'REVIEW'),
    coalesce((
      select concat('Latest synchronization quality status: ', quality_status, '.')
      from public.dashboard_sync_runs
      order by started_at desc
      limit 1
    ), 'No synchronization has completed yet.')
)
select check_key, status, details
from checks
order by check_key;
