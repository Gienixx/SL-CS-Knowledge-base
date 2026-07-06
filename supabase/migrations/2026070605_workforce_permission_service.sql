-- Workforce central permission service
--
-- Returns the authenticated user's active profile and effective, explicitly
-- granted permissions through one security-definer RPC. Existing public.login
-- fields remain available for compatibility while older pages are migrated.

create or replace function public.workforce_get_current_access()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_is_active boolean;
  v_permissions jsonb;
  v_legacy_is_admin boolean := false;
  v_legacy_can_edit boolean := false;
begin
  if v_user_id is null then
    return null;
  end if;

  select *
  into v_profile
  from public.profiles
  where user_id = v_user_id;

  if not found then
    return null;
  end if;

  v_is_active := v_profile.employment_status in ('active', 'on_leave');

  select jsonb_build_object(
    'manage_employees',
      v_is_active and coalesce(bool_or(
        permission_key = 'manage_employees' and is_granted
      ), false),
    'manage_schedules',
      v_is_active and coalesce(bool_or(
        permission_key = 'manage_schedules' and is_granted
      ), false),
    'view_team_attendance',
      v_is_active and coalesce(bool_or(
        permission_key = 'view_team_attendance' and is_granted
      ), false),
    'approve_leave',
      v_is_active and coalesce(bool_or(
        permission_key = 'approve_leave' and is_granted
      ), false),
    'view_workforce_reports',
      v_is_active and coalesce(bool_or(
        permission_key = 'view_workforce_reports' and is_granted
      ), false),
    'edit_articles',
      v_is_active and coalesce(bool_or(
        permission_key = 'edit_articles' and is_granted
      ), false),
    'manage_payroll',
      v_is_active and coalesce(bool_or(
        permission_key = 'manage_payroll' and is_granted
      ), false)
  )
  into v_permissions
  from public.user_permissions
  where user_id = v_user_id;

  select
    coalesce(login_user.is_admin, false),
    coalesce(login_user.can_edit_articles, false)
  into
    v_legacy_is_admin,
    v_legacy_can_edit
  from public.login login_user
  where lower(login_user.email) = lower(v_profile.email)
  limit 1;

  return jsonb_build_object(
    'user_id', v_profile.user_id,
    'full_name', v_profile.full_name,
    'email', lower(v_profile.email),
    'employee_id', v_profile.employee_id,
    'employment_status', v_profile.employment_status,
    'is_active', v_is_active,
    'base_role', v_profile.base_role,
    'is_admin', v_is_active and v_profile.base_role = 'admin',
    'is_agent', v_is_active and v_profile.is_agent,
    'team_id', v_profile.team_id,
    'supervisor_id', v_profile.supervisor_id,
    'timezone', v_profile.timezone,
    'permissions', v_permissions,
    'can_edit_articles',
      coalesce((v_permissions ->> 'edit_articles')::boolean, false),
    'can_manage_payroll',
      coalesce((v_permissions ->> 'manage_payroll')::boolean, false),
    'legacy', jsonb_build_object(
      'is_admin', v_legacy_is_admin,
      'can_edit_articles', v_legacy_can_edit
    )
  );
end;
$$;

comment on function public.workforce_get_current_access() is
  'Returns the authenticated workforce profile and effective explicit permissions for shared browser and server authorization.';

revoke all on function public.workforce_get_current_access() from public;
grant execute on function public.workforce_get_current_access() to authenticated;
