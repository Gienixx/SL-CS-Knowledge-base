-- Phase 3 Step 12: reporting operations, audit history, in-app alerts, and export auditing.
-- Active reporting remains Google Sheet-only. Historical Zendesk storage is not queried or modified.

begin;

create table if not exists public.dashboard_audit_events (
  id bigserial primary key,
  event_key text unique,
  event_type text not null,
  severity text not null default 'info',
  title text not null,
  details text,
  sync_run_id text,
  actor_email text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.dashboard_audit_events
  drop constraint if exists dashboard_audit_events_severity_check;

alter table public.dashboard_audit_events
  add constraint dashboard_audit_events_severity_check
  check (severity = any (array['info', 'warning', 'error']));

alter table public.dashboard_audit_events
  drop constraint if exists dashboard_audit_events_type_check;

alter table public.dashboard_audit_events
  add constraint dashboard_audit_events_type_check
  check (event_type = any (array[
    'sync_success',
    'sync_failure',
    'quality_check',
    'csv_export'
  ]));

create index if not exists dashboard_audit_events_created_idx
  on public.dashboard_audit_events (created_at desc);

create index if not exists dashboard_audit_events_sync_idx
  on public.dashboard_audit_events (sync_run_id, created_at desc);

create table if not exists public.dashboard_alert_events (
  id bigserial primary key,
  alert_key text not null unique,
  alert_type text not null,
  severity text not null,
  status text not null default 'open',
  title text not null,
  message text not null,
  sync_run_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

alter table public.dashboard_alert_events
  drop constraint if exists dashboard_alert_events_severity_check;

alter table public.dashboard_alert_events
  add constraint dashboard_alert_events_severity_check
  check (severity = any (array['warning', 'error']));

alter table public.dashboard_alert_events
  drop constraint if exists dashboard_alert_events_status_check;

alter table public.dashboard_alert_events
  add constraint dashboard_alert_events_status_check
  check (status = any (array['open', 'resolved']));

alter table public.dashboard_alert_events
  drop constraint if exists dashboard_alert_events_type_check;

alter table public.dashboard_alert_events
  add constraint dashboard_alert_events_type_check
  check (alert_type = any (array['sync_failure', 'quality_check']));

create index if not exists dashboard_alert_events_status_idx
  on public.dashboard_alert_events (status, created_at desc);

create index if not exists dashboard_alert_events_sync_idx
  on public.dashboard_alert_events (sync_run_id, created_at desc);

alter table public.dashboard_audit_events enable row level security;
alter table public.dashboard_alert_events enable row level security;

revoke all privileges
on table
  public.dashboard_audit_events,
  public.dashboard_alert_events
from anon, authenticated;

grant select
on table
  public.dashboard_audit_events,
  public.dashboard_alert_events
to authenticated;

grant select, insert, update, delete
on table
  public.dashboard_audit_events,
  public.dashboard_alert_events
to service_role;

grant usage, select
on sequence
  public.dashboard_audit_events_id_seq,
  public.dashboard_alert_events_id_seq
to service_role;

drop policy if exists
  "Authenticated users can read dashboard audit events"
on public.dashboard_audit_events;

create policy
  "Authenticated users can read dashboard audit events"
on public.dashboard_audit_events
for select
to authenticated
using (true);

drop policy if exists
  "Authenticated users can read dashboard alert events"
on public.dashboard_alert_events;

create policy
  "Authenticated users can read dashboard alert events"
on public.dashboard_alert_events
for select
to authenticated
using (true);

create or replace function public.record_dashboard_sync_operations()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id text := new.id::text;
  v_success boolean := new.status = 'success';
begin
  if new.status not in ('success', 'failed') then
    return new;
  end if;

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
    'sync:' || v_run_id || ':' || new.status,
    case when v_success then 'sync_success' else 'sync_failure' end,
    case when v_success then 'info' else 'error' end,
    case when v_success
      then 'Google Sheet synchronization completed'
      else 'Google Sheet synchronization failed'
    end,
    case when v_success
      then concat(coalesce(new.rows_imported, 0), ' reporting rows were imported.')
      else coalesce(new.error_message, 'The synchronization failed without an error message.')
    end,
    v_run_id,
    jsonb_build_object(
      'status', new.status,
      'reportDate', new.report_date,
      'rowsImported', coalesce(new.rows_imported, 0),
      'qualityStatus', new.quality_status,
      'syncSource', new.sync_source,
      'reportingSource', new.reporting_source
    ),
    coalesce(new.completed_at, now())
  )
  on conflict (event_key) do nothing;

  if v_success then
    update public.dashboard_alert_events
    set status = 'resolved',
        resolved_at = coalesce(new.completed_at, now())
    where alert_type = 'sync_failure'
      and status = 'open';
  else
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
      'sync_failure:' || v_run_id,
      'sync_failure',
      'error',
      'open',
      'Dashboard synchronization failed',
      coalesce(new.error_message, 'The synchronized Google Sheet import failed.'),
      v_run_id,
      jsonb_build_object(
        'reportDate', new.report_date,
        'syncSource', new.sync_source,
        'reportingSource', new.reporting_source
      ),
      coalesce(new.completed_at, now())
    )
    on conflict (alert_key) do update
    set status = 'open',
        resolved_at = null,
        message = excluded.message,
        metadata = excluded.metadata;
  end if;

  return new;
end;
$$;

drop trigger if exists dashboard_sync_operations_trigger
on public.sheet_sync_runs;

create trigger dashboard_sync_operations_trigger
after update of status
on public.sheet_sync_runs
for each row
when (
  new.status is distinct from old.status
  and (new.status = 'success' or new.status = 'failed')
)
execute function public.record_dashboard_sync_operations();

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
      and metadata ->> 'checkKey' = new.check_key
      and sync_run_id is distinct from new.sync_run_id;
  end if;

  return new;
end;
$$;

drop trigger if exists dashboard_quality_operations_trigger
on public.dashboard_data_quality_results;

create trigger dashboard_quality_operations_trigger
after insert
on public.dashboard_data_quality_results
for each row
execute function public.record_dashboard_quality_operations();

insert into public.dashboard_audit_events (
  event_key,
  event_type,
  severity,
  title,
  details,
  sync_run_id,
  metadata,
  created_at
)
select
  'sync:' || id::text || ':' || status,
  case when status = 'success' then 'sync_success' else 'sync_failure' end,
  case when status = 'success' then 'info' else 'error' end,
  case when status = 'success'
    then 'Google Sheet synchronization completed'
    else 'Google Sheet synchronization failed'
  end,
  case when status = 'success'
    then concat(coalesce(rows_imported, 0), ' reporting rows were imported.')
    else coalesce(error_message, 'The synchronization failed without an error message.')
  end,
  id::text,
  jsonb_build_object(
    'status', status,
    'reportDate', report_date,
    'rowsImported', coalesce(rows_imported, 0),
    'qualityStatus', quality_status,
    'syncSource', sync_source,
    'reportingSource', reporting_source
  ),
  coalesce(completed_at, started_at)
from public.sheet_sync_runs
where status in ('success', 'failed')
on conflict (event_key) do nothing;

insert into public.dashboard_audit_events (
  event_key,
  event_type,
  severity,
  title,
  details,
  sync_run_id,
  metadata,
  created_at
)
select
  'quality:' || sync_run_id || ':' || check_key,
  'quality_check',
  case
    when status = 'fail' then 'error'
    when status = 'warning' then 'warning'
    else 'info'
  end,
  'Data-quality check: ' || check_key,
  details,
  sync_run_id,
  jsonb_build_object(
    'checkKey', check_key,
    'status', status,
    'observedValue', observed_value
  ),
  checked_at
from public.dashboard_data_quality_results
on conflict (event_key) do nothing;

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
)
select
  'sync_failure:' || id::text,
  'sync_failure',
  'error',
  'open',
  'Dashboard synchronization failed',
  coalesce(error_message, 'The synchronized Google Sheet import failed.'),
  id::text,
  jsonb_build_object(
    'reportDate', report_date,
    'syncSource', sync_source,
    'reportingSource', reporting_source
  ),
  coalesce(completed_at, started_at)
from public.sheet_sync_runs
where status = 'failed'
on conflict (alert_key) do nothing;

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
)
select
  'quality:' || sync_run_id || ':' || check_key,
  'quality_check',
  case when status = 'fail' then 'error' else 'warning' end,
  'open',
  case when status = 'fail'
    then 'Data-quality check failed'
    else 'Data-quality warning'
  end,
  coalesce(details, 'A synchronized reporting quality check needs review.'),
  sync_run_id,
  jsonb_build_object(
    'checkKey', check_key,
    'status', status,
    'observedValue', observed_value
  ),
  checked_at
from public.dashboard_data_quality_results
where status in ('warning', 'fail')
on conflict (alert_key) do nothing;

create or replace view public.dashboard_active_alerts
with (security_invoker = true)
as
with latest_success as (
  select
    id::text as sync_run_id,
    completed_at,
    report_date
  from public.dashboard_sync_runs
  where status = 'success'
  order by completed_at desc nulls last
  limit 1
), stored_alerts as (
  select
    alert_key,
    alert_type,
    severity,
    title,
    message,
    sync_run_id,
    metadata,
    created_at
  from public.dashboard_alert_events
  where status = 'open'
), stale_alert as (
  select
    'computed:stale_sync'::text as alert_key,
    'stale_sync'::text as alert_type,
    'warning'::text as severity,
    'Synchronized reporting data may be stale'::text as title,
    case
      when latest_success.completed_at is null
        then 'No completed Google Sheet synchronization is available.'
      else 'The latest successful Google Sheet synchronization completed more than 30 hours ago.'
    end::text as message,
    latest_success.sync_run_id,
    jsonb_build_object(
      'completedAt', latest_success.completed_at,
      'reportDate', latest_success.report_date,
      'thresholdHours', 30
    ) as metadata,
    coalesce(latest_success.completed_at, now()) as created_at
  from latest_success
  where latest_success.completed_at is null
     or latest_success.completed_at < now() - interval '30 hours'
), missing_success as (
  select
    'computed:stale_sync'::text as alert_key,
    'stale_sync'::text as alert_type,
    'error'::text as severity,
    'No successful Google Sheet synchronization'::text as title,
    'Run syncAllDashboardData() and verify the protected dashboard synchronization endpoint.'::text as message,
    null::text as sync_run_id,
    jsonb_build_object('thresholdHours', 30) as metadata,
    now() as created_at
  where not exists (select 1 from latest_success)
)
select * from stored_alerts
union all
select * from stale_alert
union all
select * from missing_success;

revoke all privileges
on table public.dashboard_active_alerts
from anon, authenticated;

grant select
on table public.dashboard_active_alerts
to authenticated, service_role;

create or replace function public.record_dashboard_export(
  p_dataset text,
  p_row_count integer,
  p_start_date date default null,
  p_end_date date default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id bigint;
  v_dataset text := lower(btrim(coalesce(p_dataset, '')));
  v_actor text := coalesce(auth.jwt() ->> 'email', current_user);
begin
  if v_dataset <> all (array[
    'daily_ticket_metrics',
    'daily_distribution_metrics',
    'agent_productivity',
    'ticket_driver_metrics',
    'agent_dimension_metrics',
    'dashboard_sync_runs',
    'dashboard_data_quality_results',
    'dashboard_alert_events',
    'dashboard_audit_events'
  ]) then
    raise exception 'dashboard_export_dataset_invalid';
  end if;

  if coalesce(p_row_count, -1) < 0 then
    raise exception 'dashboard_export_row_count_invalid';
  end if;

  if p_start_date is not null and p_end_date is not null and p_start_date > p_end_date then
    raise exception 'dashboard_export_date_range_invalid';
  end if;

  insert into public.dashboard_audit_events (
    event_key,
    event_type,
    severity,
    title,
    details,
    actor_email,
    metadata
  ) values (
    'export:' || md5(clock_timestamp()::text || random()::text || v_dataset),
    'csv_export',
    'info',
    'CSV export created',
    concat(coalesce(p_row_count, 0), ' rows were exported from ', v_dataset, '.'),
    v_actor,
    jsonb_build_object(
      'dataset', v_dataset,
      'rowCount', coalesce(p_row_count, 0),
      'startDate', p_start_date,
      'endDate', p_end_date,
      'reportingSource', 'google_sheet'
    )
  )
  returning id into v_event_id;

  return v_event_id;
end;
$$;

revoke all
on function public.record_dashboard_sync_operations()
from public, anon, authenticated;

revoke all
on function public.record_dashboard_quality_operations()
from public, anon, authenticated;

revoke all
on function public.record_dashboard_export(text, integer, date, date)
from public, anon;

grant execute
on function public.record_dashboard_export(text, integer, date, date)
to authenticated, service_role;

comment on table public.dashboard_audit_events is
  'Append-only operational history for Google Sheet synchronization, quality checks, and CSV exports.';

comment on table public.dashboard_alert_events is
  'Stored in-app reporting alerts generated from synchronization failures and data-quality warnings or failures.';

comment on view public.dashboard_active_alerts is
  'Open stored alerts plus a computed stale-sync alert when no successful synchronization completed within 30 hours.';

comment on function public.record_dashboard_export(text, integer, date, date) is
  'Records an authenticated CSV export in the reporting operations audit history.';

notify pgrst, 'reload schema';

commit;
