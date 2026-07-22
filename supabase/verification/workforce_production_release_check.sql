-- Phase 1 production-release gate.
-- Read-only: every blocker count must be zero and all required capabilities
-- must be present before the Workforce foundation is accepted for production.

with active_profiles as (
  select profile.*
  from public.profiles profile
  where profile.employment_status in ('active', 'on_leave')
    and profile.onboarding_status = 'active'
    and profile.account_deleted_at is null
),
permission_matrix as (
  select
    profile.user_id,
    profile.base_role,
    profile.is_agent,
    profile.is_system_admin,
    coalesce(bool_or(permission.permission_key = 'manage_employees' and permission.is_granted), false) as manage_employees,
    coalesce(bool_or(permission.permission_key = 'manage_schedules' and permission.is_granted), false) as manage_schedules,
    coalesce(bool_or(permission.permission_key = 'view_team_attendance' and permission.is_granted), false) as view_team_attendance,
    coalesce(bool_or(permission.permission_key = 'correct_attendance' and permission.is_granted), false) as correct_attendance,
    coalesce(bool_or(permission.permission_key = 'approve_attendance' and permission.is_granted), false) as approve_attendance,
    coalesce(bool_or(permission.permission_key = 'approve_leave' and permission.is_granted), false) as approve_leave,
    coalesce(bool_or(permission.permission_key = 'edit_articles' and permission.is_granted), false) as edit_articles,
    coalesce(bool_or(permission.permission_key = 'manage_payroll' and permission.is_granted), false) as manage_payroll,
    exists (
      select 1
      from public.teams team
      where team.supervisor_id = profile.user_id
        and team.is_active
    ) as supervises_active_team
  from active_profiles profile
  left join public.user_permissions permission on permission.user_id = profile.user_id
  group by profile.user_id, profile.base_role, profile.is_agent, profile.is_system_admin
),
category_coverage as (
  select count(*) filter (where candidate_count > 0) as covered
  from (
    select count(*) as candidate_count
    from permission_matrix
    where base_role = 'agent' and is_agent and not is_system_admin
      and not edit_articles and not manage_payroll
      and not manage_schedules and not view_team_attendance
    union all
    select count(*) from permission_matrix
    where base_role = 'agent' and is_agent and not is_system_admin
      and edit_articles and not manage_payroll
    union all
    select count(*) from permission_matrix where base_role = 'admin' and is_agent
    union all
    select count(*) from permission_matrix where base_role = 'admin' and not is_agent
    union all
    select count(*) from permission_matrix
    where base_role = 'agent' and is_agent and not is_system_admin
      and supervises_active_team and manage_schedules and view_team_attendance
      and approve_leave and not manage_employees and not correct_attendance
      and not approve_attendance and not manage_payroll
    union all
    select count(*) from permission_matrix where manage_payroll
  ) categories
)
select jsonb_build_object(
  'active_employees', (select count(*) from active_profiles),
  'active_without_auth_identity', (
    select count(*)
    from active_profiles profile
    where not exists (
      select 1 from auth.users auth_user where auth_user.id = profile.user_id
    )
  ),
  'required_access_categories_covered', (select covered from category_coverage),
  'attendance_rls_enabled', (
    select relrowsecurity from pg_class where oid = 'public.attendance'::regclass
  ),
  'leave_requests_rls_enabled', (
    select relrowsecurity from pg_class where oid = 'public.leave_requests'::regclass
  ),
  'correction_rpc_exists', to_regprocedure(
    'public.workforce_correct_attendance(uuid,timestamp with time zone,timestamp with time zone,text,uuid,text,text,text)'
  ) is not null,
  'approval_rpc_exists', to_regprocedure(
    'public.workforce_review_attendance(uuid,text,text)'
  ) is not null,
  'leave_review_rpc_exists', to_regprocedure(
    'public.workforce_review_leave_request(uuid,text,text)'
  ) is not null,
  'team_attendance_rpc_exists', to_regprocedure(
    'public.workforce_list_team_attendance(date,date)'
  ) is not null,
  'orphaned_corrections', (
    select count(*)
    from public.attendance_corrections correction
    left join public.attendance attendance_row on attendance_row.id = correction.attendance_id
    where attendance_row.id is null
  ),
  'invalid_attendance_totals', (
    select count(*)
    from public.attendance
    where coalesce(pre_shift_overtime_minutes, 0) < 0
       or coalesce(regular_minutes, 0) < 0
       or coalesce(post_shift_overtime_minutes, 0) < 0
       or coalesce(total_overtime_minutes, 0) < 0
       or coalesce(total_worked_minutes, 0) < 0
       or total_overtime_minutes is distinct from
          coalesce(pre_shift_overtime_minutes, 0)
          + coalesce(post_shift_overtime_minutes, 0)
          + coalesce(rest_day_overtime_minutes, 0)
          + coalesce(holiday_overtime_minutes, 0)
  ),
  'payroll_readiness_mismatches', (
    select count(*)
    from public.workforce_attendance_payroll_readiness
    where is_payroll_ready is distinct from
      (cardinality(payroll_readiness_blockers) = 0)
  ),
  'july_1_15_payroll_blockers', (
    select count(*)
    from public.workforce_attendance_payroll_readiness
    where work_date between date '2026-07-01' and date '2026-07-15'
      and not is_payroll_ready
  ),
  'approved_leave_inconsistencies', (
    select count(*)
    from public.attendance attendance_row
    join public.work_schedules schedule on schedule.id = attendance_row.schedule_id
    join public.leave_requests request
      on request.user_id = attendance_row.user_id
     and schedule.shift_date between request.start_date and request.end_date
    where request.status = 'approved'
      and schedule.status in ('published', 'changed')
      and not schedule.is_rest_day
      and not schedule.is_holiday
      and attendance_row.attendance_status <> 'on_leave'
      and attendance_row.clock_in is null
      and attendance_row.clock_out is null
  ),
  'active_recurring_assignments', (
    select count(*)
    from public.work_schedule_template_assignments
    where is_active
  )
) as phase1_production_gate;
