-- Phase 3 Step 12 hotfix: make synchronization history visible to authenticated
-- reporting users and resolve historical alerts superseded by later results.

begin;

-- dashboard_sync_runs is a security-invoker view. Authenticated users therefore
-- also need SELECT access and an RLS policy on the underlying sheet_sync_runs table.
alter table public.sheet_sync_runs enable row level security;

revoke all privileges
on table public.sheet_sync_runs
from anon, authenticated;

grant select
on table public.sheet_sync_runs
to authenticated;

grant select, insert, update, delete
on table public.sheet_sync_runs
to service_role;

drop policy if exists
  "Authenticated users can read sheet synchronization runs"
on public.sheet_sync_runs;

create policy
  "Authenticated users can read sheet synchronization runs"
on public.sheet_sync_runs
for select
to authenticated
using (true);

create or replace view public.dashboard_sync_runs
with (security_invoker = true)
as
select
  id,
  started_at,
  completed_at,
  status,
  report_date,
  rows_imported,
  error_message,
  sync_source,
  reporting_source,
  quality_status
from public.sheet_sync_runs;

revoke all privileges
on table public.dashboard_sync_runs
from anon, authenticated;

grant select
on table public.dashboard_sync_runs
to authenticated, service_role;

-- A successful run supersedes any older open synchronization-failure alert.
with latest_success as (
  select max(coalesce(completed_at, started_at)) as success_at
  from public.sheet_sync_runs
  where status = 'success'
)
update public.dashboard_alert_events as alert
set status = 'resolved',
    resolved_at = latest_success.success_at
from latest_success
where alert.alert_type = 'sync_failure'
  and alert.status = 'open'
  and latest_success.success_at is not null
  and alert.created_at <= latest_success.success_at;

-- Keep at most the alert associated with the latest result for each quality check.
-- If the newest result passes, all older alerts for that check are resolved.
with ranked_quality as (
  select
    sync_run_id,
    check_key,
    status,
    checked_at,
    row_number() over (
      partition by check_key
      order by checked_at desc, id desc
    ) as row_number
  from public.dashboard_data_quality_results
), latest_quality as (
  select sync_run_id, check_key, status, checked_at
  from ranked_quality
  where row_number = 1
)
update public.dashboard_alert_events as alert
set status = 'resolved',
    resolved_at = latest_quality.checked_at
from latest_quality
where alert.alert_type = 'quality_check'
  and alert.status = 'open'
  and alert.metadata ->> 'checkKey' = latest_quality.check_key
  and (
    latest_quality.status = 'pass'
    or alert.sync_run_id is distinct from latest_quality.sync_run_id
  );

-- Future quality results resolve the previous alert for the same check before
-- opening a new warning or failure for the latest synchronization.
create or replace function public.record_dashboard_quality_operations()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_severity text := case when new.status = 'fail' then 'error' else 'warning' end;
begin
  insert into public.dashboard_audit_events (
    event_key,
    event_type,
    severity,
    title,
    details,
    sync_run_id,
    metadata,
    created_at
  ) values (
    'quality:' || new.sync_run_id || ':' || new.check_key,
    'quality_check',
    case
      when new.status = 'fail' then 'error'
      when new.status = 'warning' then 'warning'
      else 'info'
    end,
    'Data-quality check: ' || new.check_key,
    new.details,
    new.sync_run_id,
    jsonb_build_object(
      'checkKey', new.check_key,
      'status', new.status,
      'observedValue', new.observed_value
    ),
    new.checked_at
  )
  on conflict (event_key) do nothing;

  update public.dashboard_alert_events
  set status = 'resolved',
      resolved_at = new.checked_at
  where alert_type = 'quality_check'
    and status = 'open'
    and metadata ->> 'checkKey' = new.check_key
    and sync_run_id is distinct from new.sync_run_id;

  if new.status in ('warning', 'fail') then
    insert into public.dashboard_alert_events (
      alert_key,
      alert_type,
      severity,
      status,
      title,
      message,
      sync_run_id,
      metadata,
      created_at
    ) values (
      'quality:' || new.sync_run_id || ':' || new.check_key,
      'quality_check',
      v_severity,
      'open',
      case when new.status = 'fail'
        then 'Data-quality check failed'
        else 'Data-quality warning'
      end,
      coalesce(new.details, 'A synchronized reporting quality check needs review.'),
      new.sync_run_id,
      jsonb_build_object(
        'checkKey', new.check_key,
        'status', new.status,
        'observedValue', new.observed_value
      ),
      new.checked_at
    )
    on conflict (alert_key) do update
    set severity = excluded.severity,
        status = 'open',
        resolved_at = null,
        message = excluded.message,
        metadata = excluded.metadata;
  else
    update public.dashboard_alert_events
    set status = 'resolved',
        resolved_at = new.checked_at
    where alert_type = 'quality_check'
      and status = 'open'
      and metadata ->> 'checkKey' = new.check_key;
  end if;

  return new;
end;
$$;

revoke all
on function public.record_dashboard_quality_operations()
from public, anon, authenticated;

comment on policy
  "Authenticated users can read sheet synchronization runs"
on public.sheet_sync_runs is
  'Allows the security-invoker dashboard_sync_runs view to return Google Sheet synchronization history to signed-in reporting users.';

notify pgrst, 'reload schema';

commit;
