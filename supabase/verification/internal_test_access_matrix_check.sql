-- Phase 1 internal-test deployment gate.
-- Every BLOCKER query must return zero rows.

begin;

create temporary table internal_test_access on commit drop as
with permission_matrix as (
  select
    profile.user_id,
    coalesce(bool_or(permission.permission_key = 'manage_employees' and permission.is_granted), false) as manage_employees,
    coalesce(bool_or(permission.permission_key = 'manage_schedules' and permission.is_granted), false) as manage_schedules,
    coalesce(bool_or(permission.permission_key = 'view_team_attendance' and permission.is_granted), false) as view_team_attendance,
    coalesce(bool_or(permission.permission_key = 'correct_attendance' and permission.is_granted), false) as correct_attendance,
    coalesce(bool_or(permission.permission_key = 'approve_attendance' and permission.is_granted), false) as approve_attendance,
    coalesce(bool_or(permission.permission_key = 'approve_leave' and permission.is_granted), false) as approve_leave,
    coalesce(bool_or(permission.permission_key = 'edit_articles' and permission.is_granted), false) as edit_articles,
    coalesce(bool_or(permission.permission_key = 'manage_payroll' and permission.is_granted), false) as manage_payroll
  from public.profiles profile
  left join public.user_permissions permission on permission.user_id = profile.user_id
  group by profile.user_id
)
select
  profile.*,
  permission_matrix.manage_employees,
  permission_matrix.manage_schedules,
  permission_matrix.view_team_attendance,
  permission_matrix.correct_attendance,
  permission_matrix.approve_attendance,
  permission_matrix.approve_leave,
  permission_matrix.edit_articles,
  permission_matrix.manage_payroll,
  exists (select 1 from auth.users auth_user where auth_user.id = profile.user_id) as has_auth_user,
  exists (
    select 1
    from public.teams team
    where team.supervisor_id = profile.user_id
      and team.is_active is true
  ) as supervises_active_team
from public.profiles profile
join permission_matrix using (user_id)
where profile.employment_status in ('active', 'on_leave')
  and profile.onboarding_status = 'active'
  and profile.account_deleted_at is null;

create temporary table internal_test_categories (
  category text primary key,
  candidate_count integer not null
) on commit drop;

insert into internal_test_categories values
  (
    'regular_agent',
    (select count(*)::integer from internal_test_access
     where base_role = 'agent' and is_agent and not is_system_admin
       and not edit_articles and not manage_payroll
       and not manage_schedules and not view_team_attendance)
  ),
  (
    'agent_editor',
    (select count(*)::integer from internal_test_access
     where base_role = 'agent' and is_agent and not is_system_admin
       and edit_articles and not manage_payroll)
  ),
  (
    'admin_agent',
    (select count(*)::integer from internal_test_access
     where base_role = 'admin' and is_agent)
  ),
  (
    'admin_only',
    (select count(*)::integer from internal_test_access
     where base_role = 'admin' and not is_agent)
  ),
  (
    'supervisor',
    (select count(*)::integer from internal_test_access
     where base_role = 'agent' and is_agent and not is_system_admin
       and supervises_active_team
       and manage_schedules and view_team_attendance and approve_leave
       and not manage_employees and not correct_attendance
       and not approve_attendance and not manage_payroll)
  ),
  (
    'payroll_authorized',
    (select count(*)::integer from internal_test_access
     where manage_payroll)
  );

-- 1. BLOCKER: all six required test-user categories must have a candidate.
select category
from internal_test_categories
where candidate_count = 0
order by category;

-- 2. Review category coverage. Expected: six rows, all counts above zero.
select category, candidate_count
from internal_test_categories
order by category;

-- 3. BLOCKER: every eligible candidate must have a Supabase Auth identity.
select full_name, base_role
from internal_test_access
where not has_auth_user
order by full_name;

-- 4. BLOCKER: the scoped supervisor must not gain payroll or clock-edit rights.
select full_name
from internal_test_access
where base_role = 'agent'
  and is_agent
  and not is_system_admin
  and supervises_active_team
  and manage_schedules
  and view_team_attendance
  and approve_leave
  and (manage_employees or correct_attendance or approve_attendance or manage_payroll)
order by full_name;

rollback;
