begin;

alter table public.profiles
  add column hire_date date;

comment on column public.profiles.hire_date is
  'Administrator-managed employee hire date; null when not recorded.';

-- Keep the existing profile save RPC and its authorization/audit behavior.
-- This wrapper adds Hire Date to the same Workforce Save User transaction.
create function public.workforce_admin_save_employee_with_hire_date(
  p_user_id uuid,
  p_full_name text,
  p_employee_id text,
  p_employment_status text,
  p_access_type text,
  p_hire_date date,
  p_team_id uuid default null,
  p_supervisor_id uuid default null,
  p_timezone text default 'America/New_York',
  p_permissions jsonb default '{}'::jsonb,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
  v_profile jsonb;
begin
  if auth.uid() is null
     or not public.workforce_is_admin()
     or not public.workforce_has_permission('manage_employees') then
    raise exception 'You do not have permission to manage employees.' using errcode = '42501';
  end if;

  v_result := public.workforce_admin_save_employee(
    p_user_id,
    p_full_name,
    p_employee_id,
    p_employment_status,
    p_access_type,
    p_team_id,
    p_supervisor_id,
    p_timezone,
    p_permissions,
    p_reason
  );

  update public.profiles profile
  set hire_date = p_hire_date,
      updated_at = now()
  where profile.user_id = p_user_id
  returning to_jsonb(profile) into v_profile;

  if v_profile is null then
    raise exception 'Employee profile not found.' using errcode = 'P0002';
  end if;

  return jsonb_set(v_result, '{profile}', v_profile, true);
end;
$function$;

revoke all on function public.workforce_admin_save_employee_with_hire_date(
  uuid, text, text, text, text, date, uuid, uuid, text, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.workforce_admin_save_employee_with_hire_date(
  uuid, text, text, text, text, date, uuid, uuid, text, jsonb, text
) to authenticated, service_role;

comment on function public.workforce_admin_save_employee_with_hire_date(
  uuid, text, text, text, text, date, uuid, uuid, text, jsonb, text
) is 'Updates a workforce employee profile and nullable hire date with existing admin authorization.';

-- Both existing payslip readers perform their current status/ownership checks
-- and read persisted payroll items/snapshots. The wrappers add only current
-- profile metadata after the protected persisted payslip read succeeds.
alter function public.payroll_v2_get_my_payslip(uuid)
  rename to payroll_v2_get_my_payslip_persisted_base;
alter function public.payroll_v2_get_admin_completed_payslip(uuid)
  rename to payroll_v2_get_admin_completed_payslip_persisted_base;

revoke all on function public.payroll_v2_get_my_payslip_persisted_base(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.payroll_v2_get_admin_completed_payslip_persisted_base(uuid)
  from public, anon, authenticated, service_role;

create function public.payroll_v2_get_my_payslip(p_payroll_v2_record_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_payslip jsonb;
  v_hire_date date;
begin
  v_payslip := public.payroll_v2_get_my_payslip_persisted_base(p_payroll_v2_record_id);
  if v_payslip is null then
    return null;
  end if;

  select profile.hire_date
    into v_hire_date
  from public.payroll_v2_records record
  join public.profiles profile on profile.user_id = record.employee_user_id
  where record.id = p_payroll_v2_record_id;

  if not found then
    return null;
  end if;

  return pg_catalog.jsonb_set(
    v_payslip,
    '{employee,hire_date}',
    coalesce(pg_catalog.to_jsonb(v_hire_date), 'null'::jsonb),
    true
  );
end;
$function$;

create function public.payroll_v2_get_admin_completed_payslip(p_payroll_v2_record_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_payslip jsonb;
  v_hire_date date;
begin
  v_payslip := public.payroll_v2_get_admin_completed_payslip_persisted_base(p_payroll_v2_record_id);
  if v_payslip is null then
    return null;
  end if;

  select profile.hire_date
    into v_hire_date
  from public.payroll_v2_records record
  join public.profiles profile on profile.user_id = record.employee_user_id
  where record.id = p_payroll_v2_record_id;

  if not found then
    return null;
  end if;

  return pg_catalog.jsonb_set(
    v_payslip,
    '{employee,hire_date}',
    coalesce(pg_catalog.to_jsonb(v_hire_date), 'null'::jsonb),
    true
  );
end;
$function$;

revoke all on function public.payroll_v2_get_my_payslip(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.payroll_v2_get_my_payslip(uuid)
  to authenticated, service_role;

revoke all on function public.payroll_v2_get_admin_completed_payslip(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.payroll_v2_get_admin_completed_payslip(uuid)
  to authenticated, service_role;

comment on function public.payroll_v2_get_my_payslip(uuid) is
  'Returns the caller-owned Approved or Finalized persisted Payroll V2 payslip and current profile hire date.';
comment on function public.payroll_v2_get_admin_completed_payslip(uuid) is
  'Returns an authorized admin read-only persisted Payroll V2 payslip and current profile hire date.';

notify pgrst, 'reload schema';

commit;

;
