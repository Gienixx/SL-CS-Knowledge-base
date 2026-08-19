begin;

-- Attendance is part of every active workforce role. Reuse the established
-- Admin and Agent representation so administrators retain all administrative
-- permissions while also participating in schedules, attendance, and payroll.
update public.profiles
set is_agent = true,
    updated_at = now()
where (base_role = 'admin' or is_system_admin is true)
  and is_agent is not true;

-- Keep employee edits consistent: selecting Admin now produces the effective
-- Admin and Agent access type instead of recreating an attendance-ineligible
-- administrator.
alter function public.workforce_admin_save_employee(
  uuid, text, text, text, text, uuid, uuid, text, jsonb, text
) rename to workforce_admin_save_employee_attendance_role_bridge;

revoke all on function public.workforce_admin_save_employee_attendance_role_bridge(
  uuid, text, text, text, text, uuid, uuid, text, jsonb, text
) from public, anon, authenticated;

create function public.workforce_admin_save_employee(
  p_user_id uuid,
  p_full_name text,
  p_employee_id text,
  p_employment_status text,
  p_access_type text,
  p_team_id uuid default null,
  p_supervisor_id uuid default null,
  p_timezone text default 'Asia/Manila',
  p_permissions jsonb default '{}'::jsonb,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_effective_access_type text := case
    when p_access_type = 'admin' then 'admin_agent'
    else p_access_type
  end;
  v_result jsonb;
begin
  v_result := public.workforce_admin_save_employee_attendance_role_bridge(
    p_user_id,
    p_full_name,
    p_employee_id,
    p_employment_status,
    v_effective_access_type,
    p_team_id,
    p_supervisor_id,
    p_timezone,
    p_permissions,
    p_reason
  );

  return jsonb_set(
    v_result,
    '{access_type}',
    to_jsonb(v_effective_access_type),
    true
  );
end;
$$;

revoke all on function public.workforce_admin_save_employee(
  uuid, text, text, text, text, uuid, uuid, text, jsonb, text
) from public, anon;
grant execute on function public.workforce_admin_save_employee(
  uuid, text, text, text, text, uuid, uuid, text, jsonb, text
) to authenticated;

comment on function public.workforce_admin_save_employee(
  uuid, text, text, text, text, uuid, uuid, text, jsonb, text
) is
  'Updates an employee while ensuring every administrator also participates in attendance as an agent.';

-- Apply the same rule to newly invited administrators. This RPC remains
-- service-role only, matching the existing invitation security boundary.
alter function public.workforce_service_create_invitation(
  uuid, uuid, text, text, text, jsonb, uuid, uuid
) rename to workforce_service_create_invitation_attendance_role_bridge;

revoke all on function public.workforce_service_create_invitation_attendance_role_bridge(
  uuid, uuid, text, text, text, jsonb, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.workforce_service_create_invitation_attendance_role_bridge(
  uuid, uuid, text, text, text, jsonb, uuid, uuid
) to service_role;

create function public.workforce_service_create_invitation(
  p_actor_auth_user_id uuid,
  p_auth_user_id uuid,
  p_full_name text,
  p_email text,
  p_access_type text,
  p_permissions jsonb default '{}'::jsonb,
  p_team_id uuid default null,
  p_supervisor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_effective_access_type text := case
    when p_access_type = 'admin' then 'admin_agent'
    else p_access_type
  end;
  v_result jsonb;
begin
  v_result := public.workforce_service_create_invitation_attendance_role_bridge(
    p_actor_auth_user_id,
    p_auth_user_id,
    p_full_name,
    p_email,
    v_effective_access_type,
    p_permissions,
    p_team_id,
    p_supervisor_id
  );

  return jsonb_set(
    v_result,
    '{access_type}',
    to_jsonb(v_effective_access_type),
    true
  );
end;
$$;

revoke all on function public.workforce_service_create_invitation(
  uuid, uuid, text, text, text, jsonb, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.workforce_service_create_invitation(
  uuid, uuid, text, text, text, jsonb, uuid, uuid
) to service_role;

comment on function public.workforce_service_create_invitation(
  uuid, uuid, text, text, text, jsonb, uuid, uuid
) is
  'Creates workforce invitations while ensuring every administrator also participates in attendance as an agent.';

insert into public.workforce_audit_logs (
  actor_user_id,
  action,
  entity_type,
  after_data,
  reason
) values (
  null,
  'attendance_enabled_for_all_workforce_roles',
  'workforce_configuration',
  jsonb_build_object(
    'administrator_effective_access_type', 'admin_agent',
    'active_workforce_required', true,
    'own_attendance_scope_preserved', true
  ),
  'Administrators clock in and out regularly while retaining administrative access'
);

commit;
