-- Phase 1 internal-test access matrix.
--
-- The active supervisor of Test Team is the scoped supervisor test identity.
-- Grant only the capabilities needed to exercise schedule, attendance, and
-- leave-review scope. Attendance correction, attendance approval, employee
-- administration, and payroll access remain explicitly separate.

do $$
declare
  v_supervisor public.profiles%rowtype;
  v_actor_user_id uuid;
  v_permission text;
  v_candidate_count integer;
begin
  select count(distinct profile.user_id)::integer
  into v_candidate_count
  from public.profiles profile
  join public.teams team on team.supervisor_id = profile.user_id
  where team.name = 'Test Team'
    and team.is_active is true
    and profile.employment_status in ('active', 'on_leave')
    and profile.onboarding_status = 'active'
    and profile.account_deleted_at is null;

  if v_candidate_count <> 1 then
    raise exception
      'Expected exactly one active Test Team supervisor, found %',
      v_candidate_count;
  end if;

  select profile.*
  into strict v_supervisor
  from public.profiles profile
  join public.teams team on team.supervisor_id = profile.user_id
  where team.name = 'Test Team'
    and team.is_active is true
    and profile.employment_status in ('active', 'on_leave')
    and profile.onboarding_status = 'active'
    and profile.account_deleted_at is null;

  if v_supervisor.base_role <> 'agent'
     or v_supervisor.is_agent is not true
     or v_supervisor.is_system_admin is true then
    raise exception
      'Test Team supervisor must remain a non-admin agent test identity';
  end if;

  select profile.user_id
  into strict v_actor_user_id
  from public.profiles profile
  where profile.is_system_admin is true
    and profile.employment_status in ('active', 'on_leave')
    and profile.onboarding_status = 'active'
    and profile.account_deleted_at is null;

  foreach v_permission in array array[
    'manage_schedules',
    'view_team_attendance',
    'approve_leave'
  ] loop
    insert into public.user_permissions (
      user_id,
      permission_key,
      is_granted,
      granted_by,
      reason
    ) values (
      v_supervisor.user_id,
      v_permission,
      true,
      v_actor_user_id,
      'Internal attendance-cycle supervisor test scope'
    )
    on conflict (user_id, permission_key) do update
    set is_granted = excluded.is_granted,
        granted_by = excluded.granted_by,
        reason = excluded.reason,
        updated_at = now();
  end loop;

  insert into public.workforce_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    after_data,
    reason
  ) values (
    v_actor_user_id,
    'internal_test_supervisor_scope_prepared',
    'profiles',
    v_supervisor.user_id,
    jsonb_build_object(
      'team', 'Test Team',
      'permissions', jsonb_build_array(
        'manage_schedules',
        'view_team_attendance',
        'approve_leave'
      ),
      'excluded_permissions', jsonb_build_array(
        'manage_employees',
        'correct_attendance',
        'approve_attendance',
        'manage_payroll'
      )
    ),
    'Prepared the scoped supervisor identity for the internal attendance cycle'
  );
end;
$$;
