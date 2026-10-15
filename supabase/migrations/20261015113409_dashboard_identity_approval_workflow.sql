-- Add a dedicated permission and an authenticated, auditable identity approval
-- workflow. This migration intentionally does not grant the permission or
-- approve any mapping.
begin;

alter table public.user_permissions
  drop constraint user_permissions_permission_key_check;

alter table public.user_permissions
  add constraint user_permissions_permission_key_check check (
    permission_key = any (array[
      'manage_employees'::text,
      'manage_schedules'::text,
      'view_team_attendance'::text,
      'correct_attendance'::text,
      'approve_attendance'::text,
      'approve_leave'::text,
      'view_workforce_reports'::text,
      'manage_announcements'::text,
      'edit_articles'::text,
      'manage_agent_rates'::text,
      'create_payroll'::text,
      'review_payroll'::text,
      'finalize_payroll'::text,
      'view_all_payslips'::text,
      'view_own_payslips'::text,
      'export_payslips'::text,
      'reopen_payroll'::text,
      'manage_payroll'::text,
      'approve_dashboard_identities'::text
    ])
  );

comment on constraint user_permissions_permission_key_check
on public.user_permissions is
  'Canonical workforce permissions. approve_dashboard_identities is independently granted and is not implied by administrator status or report-view access.';

-- Keep the existing Workforce editor as the explicit grant path. The new
-- permission is persisted from its checkbox exactly as submitted; it is never
-- implied by system-administrator status or by legacy administrator access.
do $migration$
declare
  v_oid oid;
  v_definition text;
  v_old text := $old$'reopen_payroll'
  ] loop$old$;
  v_new text := $new$'reopen_payroll',
    'approve_dashboard_identities'
  ] loop$new$;
begin
  select function_row.oid, pg_catalog.pg_get_functiondef(function_row.oid)
  into v_oid, v_definition
  from pg_catalog.pg_proc function_row
  join pg_catalog.pg_namespace schema_row on schema_row.oid = function_row.pronamespace
  where schema_row.nspname = 'public'
    and function_row.proname = 'workforce_admin_save_employee'
    and pg_catalog.pg_get_function_identity_arguments(function_row.oid) =
      'p_user_id uuid, p_full_name text, p_employee_id text, p_employment_status text, p_access_type text, p_team_id uuid, p_supervisor_id uuid, p_timezone text, p_permissions jsonb, p_reason text';

  if v_oid is null then
    raise exception 'Expected workforce_admin_save_employee RPC is missing.';
  end if;

  if pg_catalog.strpos(v_definition, v_new) > 0 then
    return;
  end if;

  if pg_catalog.strpos(v_definition, v_old) = 0 then
    raise exception 'Workforce permission-save implementation differs from the verified baseline; no function was changed.';
  end if;

  v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  execute v_definition;
end;
$migration$;

-- Expose the permission only when explicitly granted in user_permissions.
do $migration$
declare
  v_oid oid;
  v_definition text;
  v_old text := $old$'reopen_payroll',
      v_is_active and coalesce(bool_or(permission_key = 'reopen_payroll' and is_granted), false)$old$;
  v_new text := $new$'reopen_payroll',
      v_is_active and coalesce(bool_or(permission_key = 'reopen_payroll' and is_granted), false),
    'approve_dashboard_identities',
      v_is_active and coalesce(bool_or(permission_key = 'approve_dashboard_identities' and is_granted), false)$new$;
begin
  select function_row.oid, pg_catalog.pg_get_functiondef(function_row.oid)
  into v_oid, v_definition
  from pg_catalog.pg_proc function_row
  join pg_catalog.pg_namespace schema_row on schema_row.oid = function_row.pronamespace
  where schema_row.nspname = 'public'
    and function_row.proname = 'workforce_get_current_access'
    and pg_catalog.pg_get_function_identity_arguments(function_row.oid) = '';

  if v_oid is null then
    raise exception 'Expected workforce_get_current_access RPC is missing.';
  end if;

  if pg_catalog.strpos(v_definition, v_new) > 0 then
    return;
  end if;

  if pg_catalog.strpos(v_definition, v_old) = 0 then
    raise exception 'Workforce access implementation differs from the verified baseline; no function was changed.';
  end if;

  v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  execute v_definition;
end;
$migration$;

create table public.dashboard_identity_approval_audit (
  id uuid primary key default gen_random_uuid(),
  agent_key text not null,
  actor_user_id uuid not null,
  approved_at timestamptz not null default now(),
  reason text not null check (length(btrim(reason)) > 0),
  source_evidence_reference text not null check (length(btrim(source_evidence_reference)) > 0),
  source_authorized boolean not null check (source_authorized is true),
  october_11_blank_metrics_verified boolean not null check (october_11_blank_metrics_verified is true),
  before_state jsonb not null,
  after_state jsonb not null,
  constraint dashboard_identity_approval_audit_agent_key_fk
    foreign key (agent_key) references public.agent_identity_map(agent_key),
  constraint dashboard_identity_approval_audit_before_state_check
    check (before_state ? 'dashboard_sync_approved' and before_state ->> 'dashboard_sync_approved' = 'false'),
  constraint dashboard_identity_approval_audit_after_state_check
    check (after_state ? 'dashboard_sync_approved' and after_state ->> 'dashboard_sync_approved' = 'true')
);

comment on table public.dashboard_identity_approval_audit is
  'Append-only evidence for individually authorized dashboard identity approvals.';

create index dashboard_identity_approval_audit_agent_time_idx
  on public.dashboard_identity_approval_audit (agent_key, approved_at desc);

create function public.reject_dashboard_identity_approval_audit_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Dashboard identity approval audit is append-only.' using errcode = '42501';
end;
$$;

create trigger dashboard_identity_approval_audit_no_update_delete
before update or delete on public.dashboard_identity_approval_audit
for each row execute function public.reject_dashboard_identity_approval_audit_mutation();

alter table public.dashboard_identity_approval_audit enable row level security;
revoke all on public.dashboard_identity_approval_audit from public, anon, authenticated, service_role;
grant select on public.dashboard_identity_approval_audit to authenticated;

create policy dashboard_identity_approval_audit_reporting_admin_read
on public.dashboard_identity_approval_audit
for select to authenticated
using (
  public.workforce_current_user_is_active()
  and public.workforce_is_admin()
  and public.workforce_has_permission('view_workforce_reports')
);

create function public.approve_dashboard_agent_identity(
  p_agent_key text,
  p_expected_agent_name text,
  p_expected_zendesk_agent_key text,
  p_expected_updated_at timestamptz,
  p_reason text,
  p_source_evidence_reference text,
  p_source_authorized boolean,
  p_october_11_blank_metrics_verified boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mapping public.agent_identity_map%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_approved_at timestamptz := pg_catalog.clock_timestamp();
begin
  if auth.uid() is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_is_admin()
     or not public.workforce_has_permission('view_workforce_reports')
     or not public.workforce_has_permission('approve_dashboard_identities') then
    raise exception 'An active reporting administrator with dashboard identity approval permission is required.'
      using errcode = '42501';
  end if;

  if p_source_authorized is distinct from true
     or p_october_11_blank_metrics_verified is distinct from true then
    raise exception 'Source authorization and October 11 blank-metric verification are required.'
      using errcode = '22023';
  end if;

  if p_agent_key is null or length(btrim(p_agent_key)) = 0
     or p_expected_agent_name is null or length(btrim(p_expected_agent_name)) = 0
     or p_expected_updated_at is null
     or p_reason is null or length(btrim(p_reason)) < 10 or length(btrim(p_reason)) > 2000
     or p_source_evidence_reference is null
     or length(btrim(p_source_evidence_reference)) < 3
     or length(btrim(p_source_evidence_reference)) > 1000 then
    raise exception 'Expected mapping values, a specific approval reason, and source evidence reference are required.'
      using errcode = '22023';
  end if;

  select mapping.*
  into v_mapping
  from public.agent_identity_map mapping
  where mapping.agent_key = p_agent_key
  for update;

  if not found
     or v_mapping.active is not true
     or v_mapping.agent_name is distinct from p_expected_agent_name
     or v_mapping.zendesk_agent_key is distinct from p_expected_zendesk_agent_key
     or v_mapping.updated_at is distinct from p_expected_updated_at
     or v_mapping.dashboard_sync_approved is distinct from false then
    raise exception 'The identity mapping is missing, inactive, approved already, or changed since review. Refresh and review it again.'
      using errcode = '40001';
  end if;

  v_before := pg_catalog.jsonb_build_object(
    'agent_key', v_mapping.agent_key,
    'agent_name', v_mapping.agent_name,
    'zendesk_agent_key', v_mapping.zendesk_agent_key,
    'active', v_mapping.active,
    'dashboard_sync_approved', v_mapping.dashboard_sync_approved,
    'updated_at', v_mapping.updated_at
  );

  update public.agent_identity_map mapping
  set dashboard_sync_approved = true,
      updated_at = v_approved_at
  where mapping.agent_key = p_agent_key
    and mapping.agent_name = p_expected_agent_name
    and mapping.zendesk_agent_key is not distinct from p_expected_zendesk_agent_key
    and mapping.active is true
    and mapping.dashboard_sync_approved is false
    and mapping.updated_at = p_expected_updated_at;

  if not found then
    raise exception 'The identity mapping changed during approval. Refresh and review it again.'
      using errcode = '40001';
  end if;

  select pg_catalog.jsonb_build_object(
    'agent_key', mapping.agent_key,
    'agent_name', mapping.agent_name,
    'zendesk_agent_key', mapping.zendesk_agent_key,
    'active', mapping.active,
    'dashboard_sync_approved', mapping.dashboard_sync_approved,
    'updated_at', mapping.updated_at
  )
  into v_after
  from public.agent_identity_map mapping
  where mapping.agent_key = p_agent_key;

  insert into public.dashboard_identity_approval_audit (
    agent_key, actor_user_id, approved_at, reason, source_evidence_reference,
    source_authorized, october_11_blank_metrics_verified, before_state, after_state
  ) values (
    p_agent_key, auth.uid(), v_approved_at, btrim(p_reason),
    btrim(p_source_evidence_reference), p_source_authorized,
    p_october_11_blank_metrics_verified, v_before, v_after
  );

  return pg_catalog.jsonb_build_object(
    'agent_key', p_agent_key,
    'approved_at', v_approved_at,
    'audit_recorded', true
  );
end;
$$;

revoke all on function public.approve_dashboard_agent_identity(
  text, text, text, timestamptz, text, text, boolean, boolean
) from public, anon, service_role;
grant execute on function public.approve_dashboard_agent_identity(
  text, text, text, timestamptz, text, text, boolean, boolean
) to authenticated;

comment on function public.approve_dashboard_agent_identity(
  text, text, text, timestamptz, text, text, boolean, boolean
) is 'Approves one existing dashboard identity after explicit reporting-admin authorization, source evidence, and blank-metric verification; mapping change and append-only audit commit atomically.';

commit;
