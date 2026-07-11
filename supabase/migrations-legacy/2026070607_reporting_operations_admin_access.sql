-- Restrict Reporting Operations to active administrators who retain the
-- explicit view_workforce_reports permission.
--
-- Regular reporting dashboards remain available to approved users. This
-- migration protects only synchronization history, quality results, alerts,
-- audit history, and the export-audit RPC used by Reporting Operations.

begin;

alter table public.dashboard_audit_events enable row level security;
alter table public.dashboard_alert_events enable row level security;
alter table public.dashboard_data_quality_results enable row level security;
alter table public.sheet_sync_runs enable row level security;

-- Replace the former authenticated-user policies with administrator-scoped
-- policies. The views dashboard_sync_runs and dashboard_active_alerts are
-- security-invoker views, so these underlying policies also protect the views.
drop policy if exists
  "Authenticated users can read dashboard audit events"
on public.dashboard_audit_events;

drop policy if exists
  "Reporting administrators can read dashboard audit events"
on public.dashboard_audit_events;

create policy
  "Reporting administrators can read dashboard audit events"
on public.dashboard_audit_events
for select
to authenticated
using (
  public.workforce_is_admin()
  and public.workforce_has_permission('view_workforce_reports')
);

drop policy if exists
  "Authenticated users can read dashboard alert events"
on public.dashboard_alert_events;

drop policy if exists
  "Reporting administrators can read dashboard alert events"
on public.dashboard_alert_events;

create policy
  "Reporting administrators can read dashboard alert events"
on public.dashboard_alert_events
for select
to authenticated
using (
  public.workforce_is_admin()
  and public.workforce_has_permission('view_workforce_reports')
);

drop policy if exists
  "Authenticated users can read dashboard data quality results"
on public.dashboard_data_quality_results;

drop policy if exists
  "Reporting administrators can read dashboard data quality results"
on public.dashboard_data_quality_results;

create policy
  "Reporting administrators can read dashboard data quality results"
on public.dashboard_data_quality_results
for select
to authenticated
using (
  public.workforce_is_admin()
  and public.workforce_has_permission('view_workforce_reports')
);

drop policy if exists
  "Authenticated users can read sheet synchronization runs"
on public.sheet_sync_runs;

drop policy if exists
  "Reporting administrators can read sheet synchronization runs"
on public.sheet_sync_runs;

create policy
  "Reporting administrators can read sheet synchronization runs"
on public.sheet_sync_runs
for select
to authenticated
using (
  public.workforce_is_admin()
  and public.workforce_has_permission('view_workforce_reports')
);

-- record_dashboard_export is security-definer because it appends to the audit
-- table. Enforce administrator scope inside the function so direct RPC calls
-- cannot bypass the browser access gate or RLS.
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
  if coalesce(auth.role(), '') <> 'service_role'
    and (
      auth.uid() is null
      or not public.workforce_is_admin()
      or not public.workforce_has_permission('view_workforce_reports')
    ) then
    raise exception 'reporting_operations_admin_required'
      using errcode = '42501';
  end if;

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

  if p_start_date is not null
    and p_end_date is not null
    and p_start_date > p_end_date then
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
on function public.record_dashboard_export(text, integer, date, date)
from public, anon;

grant execute
on function public.record_dashboard_export(text, integer, date, date)
to authenticated, service_role;

comment on policy
  "Reporting administrators can read dashboard audit events"
on public.dashboard_audit_events is
  'Restricts Reporting Operations audit history to active administrators with view_workforce_reports.';

comment on policy
  "Reporting administrators can read dashboard alert events"
on public.dashboard_alert_events is
  'Restricts Reporting Operations alerts to active administrators with view_workforce_reports.';

comment on policy
  "Reporting administrators can read dashboard data quality results"
on public.dashboard_data_quality_results is
  'Restricts Reporting Operations quality results to active administrators with view_workforce_reports.';

comment on policy
  "Reporting administrators can read sheet synchronization runs"
on public.sheet_sync_runs is
  'Restricts synchronization history to active administrators with view_workforce_reports.';

comment on function public.record_dashboard_export(text, integer, date, date) is
  'Records a Reporting Operations CSV export after verifying administrator scope and view_workforce_reports.';

notify pgrst, 'reload schema';

commit;
