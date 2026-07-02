-- Phase 3 Step 10: make Supabase reporting and sync observability Google Sheet only.
-- Existing Zendesk tables and historical records remain untouched for rollback.

begin;

alter table public.sheet_sync_runs
  add column if not exists reporting_source text not null default 'google_sheet',
  add column if not exists quality_status text not null default 'pending';

alter table public.sheet_sync_runs
  drop constraint if exists sheet_sync_runs_reporting_source_check;

alter table public.sheet_sync_runs
  add constraint sheet_sync_runs_reporting_source_check
  check (reporting_source = 'google_sheet');

alter table public.sheet_sync_runs
  drop constraint if exists sheet_sync_runs_quality_status_check;

alter table public.sheet_sync_runs
  add constraint sheet_sync_runs_quality_status_check
  check (quality_status = any (array['pending', 'pass', 'warning', 'fail']));

create table if not exists public.agent_dimension_metrics (
  report_date date not null,
  agent_key text not null,
  agent_name text not null,
  dimension_type text not null,
  dimension_key text not null,
  dimension_label text not null,
  ticket_count bigint not null,
  updated_at timestamptz not null default now(),
  primary key (
    report_date,
    agent_key,
    dimension_type,
    dimension_key
  )
);

create index if not exists agent_dimension_metrics_date_idx
  on public.agent_dimension_metrics (report_date desc);

create index if not exists agent_dimension_metrics_agent_idx
  on public.agent_dimension_metrics (agent_key, report_date desc);

alter table public.agent_dimension_metrics enable row level security;

revoke all privileges
on table public.agent_dimension_metrics
from anon, authenticated;

grant select
on table public.agent_dimension_metrics
to authenticated;

grant select, insert, update, delete
on table public.agent_dimension_metrics
to service_role;

drop policy if exists
  "Authenticated users can read agent dimension metrics"
on public.agent_dimension_metrics;

create policy
  "Authenticated users can read agent dimension metrics"
on public.agent_dimension_metrics
for select
to authenticated
using (true);

create table if not exists public.dashboard_data_quality_results (
  id bigserial primary key,
  sync_run_id text not null,
  check_key text not null,
  status text not null,
  observed_value jsonb not null default '{}'::jsonb,
  details text,
  checked_at timestamptz not null default now(),
  unique (sync_run_id, check_key)
);

alter table public.dashboard_data_quality_results
  drop constraint if exists dashboard_data_quality_results_status_check;

alter table public.dashboard_data_quality_results
  add constraint dashboard_data_quality_results_status_check
  check (status = any (array['pass', 'warning', 'fail']));

create index if not exists dashboard_data_quality_results_run_idx
  on public.dashboard_data_quality_results (sync_run_id, checked_at desc);

create index if not exists dashboard_data_quality_results_status_idx
  on public.dashboard_data_quality_results (status, checked_at desc);

alter table public.dashboard_data_quality_results enable row level security;

revoke all privileges
on table public.dashboard_data_quality_results
from anon, authenticated;

grant select
on table public.dashboard_data_quality_results
to authenticated;

grant select, insert, update, delete
on table public.dashboard_data_quality_results
to service_role;

grant usage, select
on sequence public.dashboard_data_quality_results_id_seq
to service_role;

drop policy if exists
  "Authenticated users can read dashboard data quality results"
on public.dashboard_data_quality_results;

create policy
  "Authenticated users can read dashboard data quality results"
on public.dashboard_data_quality_results
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

create or replace function public.record_sheet_sync_quality_results()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sync_run_id text := new.id::text;
  v_daily_count bigint;
  v_distribution_count bigint;
  v_productivity_count bigint;
  v_driver_count bigint;
  v_daily_latest date;
  v_distribution_latest date;
  v_productivity_latest date;
  v_driver_latest date;
  v_quality_status text;
begin
  if new.status not in ('success', 'failed') then
    return new;
  end if;

  delete from public.dashboard_data_quality_results
  where sync_run_id = v_sync_run_id;

  if new.status = 'failed' then
    insert into public.dashboard_data_quality_results (
      sync_run_id,
      check_key,
      status,
      observed_value,
      details
    ) values (
      v_sync_run_id,
      'sync_execution',
      'fail',
      jsonb_build_object('status', new.status),
      coalesce(new.error_message, 'The Google Sheet synchronization failed.')
    );

    update public.sheet_sync_runs
    set quality_status = 'fail',
        reporting_source = 'google_sheet'
    where id = new.id;

    return new;
  end if;

  select count(*), max(report_date)
  into v_daily_count, v_daily_latest
  from public.daily_ticket_metrics;

  select count(*), max(report_date)
  into v_distribution_count, v_distribution_latest
  from public.daily_distribution_metrics;

  select count(*), max(report_date)
  into v_productivity_count, v_productivity_latest
  from public.agent_productivity;

  select count(*), max(report_date)
  into v_driver_count, v_driver_latest
  from public.ticket_driver_metrics;

  insert into public.dashboard_data_quality_results (
    sync_run_id,
    check_key,
    status,
    observed_value,
    details
  ) values
  (
    v_sync_run_id,
    'rows_imported',
    case when coalesce(new.rows_imported, 0) > 0 then 'pass' else 'fail' end,
    jsonb_build_object('rowsImported', coalesce(new.rows_imported, 0)),
    'A successful synchronization must import at least one reporting row.'
  ),
  (
    v_sync_run_id,
    'latest_report_date',
    case when new.report_date is not null then 'pass' else 'fail' end,
    jsonb_build_object('reportDate', new.report_date),
    'A successful synchronization must identify the latest Google Sheet report date.'
  ),
  (
    v_sync_run_id,
    'source_tables_populated',
    case
      when v_daily_count > 0
       and v_distribution_count > 0
       and v_productivity_count > 0
       and v_driver_count > 0
      then 'pass'
      else 'fail'
    end,
    jsonb_build_object(
      'dailyTicketMetrics', v_daily_count,
      'dailyDistributionMetrics', v_distribution_count,
      'agentProductivity', v_productivity_count,
      'ticketDriverMetrics', v_driver_count
    ),
    'All four Google Sheet reporting tables must contain synchronized rows.'
  ),
  (
    v_sync_run_id,
    'source_table_latest_dates',
    case
      when new.report_date is not null
       and v_daily_latest = new.report_date
       and v_distribution_latest = new.report_date
       and v_productivity_latest = new.report_date
       and v_driver_latest = new.report_date
      then 'pass'
      else 'warning'
    end,
    jsonb_build_object(
      'syncReportDate', new.report_date,
      'dailyTicketMetrics', v_daily_latest,
      'dailyDistributionMetrics', v_distribution_latest,
      'agentProductivity', v_productivity_latest,
      'ticketDriverMetrics', v_driver_latest
    ),
    'The latest reporting date should match across all synchronized Google Sheet tables.'
  );

  select case
    when exists (
      select 1
      from public.dashboard_data_quality_results
      where sync_run_id = v_sync_run_id
        and status = 'fail'
    ) then 'fail'
    when exists (
      select 1
      from public.dashboard_data_quality_results
      where sync_run_id = v_sync_run_id
        and status = 'warning'
    ) then 'warning'
    else 'pass'
  end
  into v_quality_status;

  update public.sheet_sync_runs
  set quality_status = v_quality_status,
      reporting_source = 'google_sheet'
  where id = new.id;

  return new;
end;
$$;

drop trigger if exists sheet_sync_quality_results_trigger
on public.sheet_sync_runs;

create trigger sheet_sync_quality_results_trigger
after update of status, completed_at, report_date, rows_imported
on public.sheet_sync_runs
for each row
when ((new.status = 'success') or (new.status = 'failed'))
execute function public.record_sheet_sync_quality_results();

revoke all
on function public.record_sheet_sync_quality_results()
from public, anon, authenticated;

comment on table public.agent_dimension_metrics is
  'Reserved sheet-backed agent dimension table. It remains empty until the existing workbook supplies agent-level dimensions.';

comment on view public.dashboard_sync_runs is
  'Google Sheet dashboard synchronization history exposed as the Phase 3 reporting run contract.';

comment on table public.dashboard_data_quality_results is
  'Per-run validation results for the Google Sheet reporting synchronization.';

notify pgrst, 'reload schema';

commit;
