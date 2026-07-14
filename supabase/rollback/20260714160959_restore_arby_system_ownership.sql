-- Emergency rollback for 20260714160959_transfer_system_ownership_to_admin.sql.
-- Apply manually only if the dedicated admin ownership transfer must be reversed.

begin;

do $$
declare
  v_source public.profiles%rowtype;
  v_target public.profiles%rowtype;
  v_permission text;
begin
  select * into strict v_source
  from public.profiles
  where lower(email) = lower('arby@eurekasurveys.com')
    and employee_id = 'SL-F69A9E68'
  for update;

  select * into strict v_target
  from public.profiles
  where lower(email) = lower('arby.benito10@gmail.com')
    and employee_id = 'SL-7859DCC5'
  for update;

  update public.profiles
  set is_system_admin = false,
      updated_at = now()
  where user_id = v_target.user_id;

  update public.profiles
  set is_system_admin = true,
      base_role = 'agent',
      is_agent = true,
      can_edit_articles = true,
      can_manage_payroll = true,
      updated_at = now()
  where user_id = v_source.user_id;

  foreach v_permission in array array[
    'manage_employees', 'manage_schedules', 'view_team_attendance',
    'correct_attendance', 'approve_attendance', 'approve_leave',
    'view_workforce_reports', 'edit_articles', 'manage_payroll'
  ] loop
    insert into public.user_permissions (
      user_id, permission_key, is_granted, granted_by, reason
    ) values (
      v_source.user_id, v_permission, true, v_target.user_id,
      'Restored by emergency system ownership rollback'
    )
    on conflict (user_id, permission_key) do update
    set is_granted = true,
        granted_by = excluded.granted_by,
        reason = excluded.reason,
        updated_at = now();
  end loop;

  insert into public.workforce_audit_logs (
    actor_user_id, action, entity_type, entity_id, before_data, after_data, reason
  ) values (
    v_target.user_id,
    'system_ownership_transfer_rolled_back',
    'profiles',
    v_source.user_id,
    jsonb_build_object('owner_employee_id', v_target.employee_id, 'owner_email', v_target.email),
    jsonb_build_object('owner_employee_id', v_source.employee_id, 'owner_email', v_source.email),
    'Emergency rollback restored protected ownership to the employee-facing Arby profile'
  );
end;
$$;

commit;
