-- Phase 3 Step 12 synchronization-history visibility hotfix verification.
-- Read-only.

with latest_success as (
  select max(coalesce(completed_at, started_at)) as success_at
  from public.sheet_sync_runs
  where status = 'success'
), checks as (
  select
    'sheet_sync_runs_rls'::text as check_key,
    case when coalesce((
      select relrowsecurity
      from pg_class
      where oid = to_regclass('public.sheet_sync_runs')
    ), false) then 'PASS' else 'FAIL' end as status,
    'The synchronization source table is protected by row-level security.'::text as details

  union all

  select
    'authenticated_sheet_sync_select',
    case when has_table_privilege(
      'authenticated',
      'public.sheet_sync_runs',
      'SELECT'
    ) then 'PASS' else 'FAIL' end,
    'Authenticated reporting users can select the underlying synchronization rows required by the security-invoker view.'

  union all

  select
    'sheet_sync_read_policy',
    case when exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = 'sheet_sync_runs'
        and policyname = 'Authenticated users can read sheet synchronization runs'
        and 'authenticated' = any (roles)
    ) then 'PASS' else 'FAIL' end,
    'The authenticated synchronization-history RLS policy exists.'

  union all

  select
    'dashboard_sync_view_row_parity',
    case when
      (select count(*) from public.dashboard_sync_runs)
      = (select count(*) from public.sheet_sync_runs)
    then 'PASS' else 'FAIL' end,
    'The synchronization-history view exposes every source run to privileged verification.'

  union all

  select
    'superseded_sync_failures_resolved',
    case
      when latest_success.success_at is null then 'REVIEW'
      when not exists (
        select 1
        from public.dashboard_alert_events as alert
        where alert.alert_type = 'sync_failure'
          and alert.status = 'open'
          and alert.created_at <= latest_success.success_at
      ) then 'PASS'
      else 'FAIL'
    end,
    case
      when latest_success.success_at is null
        then 'No successful synchronization exists yet.'
      else 'No failure alert older than the latest successful synchronization remains open.'
    end
  from latest_success

  union all

  select
    'single_open_quality_alert_per_check',
    case when not exists (
      select 1
      from public.dashboard_alert_events
      where alert_type = 'quality_check'
        and status = 'open'
      group by metadata ->> 'checkKey'
      having count(*) > 1
    ) then 'PASS' else 'FAIL' end,
    'Only the newest warning or failure for each quality check may remain open.'
)
select check_key, status, details
from checks
order by check_key;
