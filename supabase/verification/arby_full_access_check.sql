-- Verify the Arby project-owner full-access assignment.
-- Run after 2026070704_arby_full_access.sql.
-- Queries marked "should return 0 rows" are deployment blockers.

begin;

create temporary table arby_access_resolution on commit drop as
select
  count(distinct profile.user_id)::integer as candidate_count,
  array_remove(array_agg(distinct profile.user_id), null) as candidate_ids,
  string_agg(distinct profile.full_name, ', ' order by profile.full_name) as candidate_names
from public.profiles profile
where lower(trim(profile.full_name)) = 'arby'
   or lower(split_part(trim(profile.full_name), ' ', 1)) = 'arby'
   or lower(split_part(profile.email, '@', 1)) = 'arby'
   or lower(split_part(profile.email, '@', 1)) ~ '^arby[._-]'
   or exists (
     select 1
     from public.login login_user
     where lower(login_user.email) = lower(profile.email)
       and (
         lower(trim(coalesce(login_user.name, ''))) = 'arby'
         or lower(split_part(trim(coalesce(login_user.name, '')), ' ', 1)) = 'arby'
       )
   );

create temporary table arby_access_target on commit drop as
select candidate_ids[1] as user_id
from arby_access_resolution
where candidate_count = 1;

-- 1. Identity resolution blocker: should return 0 rows.
select candidate_count, candidate_names
from arby_access_resolution
where candidate_count <> 1;

-- 2. Effective profile snapshot: should return exactly 1 row.
select
  profile.full_name,
  profile.employee_id,
  profile.employment_status,
  case
    when profile.is_system_admin is true then 'Regular Agent'
    when profile.base_role = 'admin' and profile.is_agent is true then 'Admin and Agent'
    when profile.base_role = 'admin' then 'Admin'
    else 'Regular Agent'
  end as visible_access_type,
  profile.base_role,
  profile.is_agent,
  profile.is_system_admin,
  profile.can_edit_articles,
  profile.can_manage_payroll,
  profile.timezone,
  team.name as team_name,
  supervisor.full_name as supervisor_name
from arby_access_target target
join public.profiles profile on profile.user_id = target.user_id
left join public.teams team on team.id = profile.team_id
left join public.profiles supervisor on supervisor.user_id = profile.supervisor_id;

-- 3. Profile attribute blocker: should return 0 rows.
select
  profile.full_name,
  profile.employment_status,
  profile.base_role,
  profile.is_agent,
  profile.is_system_admin,
  profile.can_edit_articles,
  profile.can_manage_payroll,
  profile.timezone
from arby_access_target target
join public.profiles profile on profile.user_id = target.user_id
where profile.employment_status <> 'active'
   or profile.base_role <> 'agent'
   or profile.is_agent is not true
   or profile.is_system_admin is not true
   or profile.can_edit_articles is not true
   or profile.can_manage_payroll is not true
   or profile.timezone <> 'Asia/Manila';

-- 4. Permission blocker: should return 0 rows.
with expected_permissions(permission_key) as (
  values
    ('manage_employees'::text),
    ('manage_schedules'::text),
    ('view_team_attendance'::text),
    ('approve_leave'::text),
    ('view_workforce_reports'::text),
    ('edit_articles'::text),
    ('manage_payroll'::text)
)
select
  expected.permission_key,
  permission.is_granted,
  permission.reason
from arby_access_target target
cross join expected_permissions expected
left join public.user_permissions permission
  on permission.user_id = target.user_id
 and permission.permission_key = expected.permission_key
where permission.id is null
   or permission.is_granted is not true
order by expected.permission_key;

-- 5. Login compatibility blocker: should return 0 rows.
select
  profile.full_name,
  login_user.is_admin,
  login_user.can_edit_articles
from arby_access_target target
join public.profiles profile on profile.user_id = target.user_id
left join public.login login_user on lower(login_user.email) = lower(profile.email)
where login_user.email is null
   or login_user.is_admin is not true
   or login_user.can_edit_articles is not true;

-- 6. Confirm exactly seven granted current permissions: expected count = 7.
select count(*) as granted_permission_count
from arby_access_target target
join public.user_permissions permission on permission.user_id = target.user_id
where permission.permission_key in (
    'manage_employees',
    'manage_schedules',
    'view_team_attendance',
    'approve_leave',
    'view_workforce_reports',
    'edit_articles',
    'manage_payroll'
  )
  and permission.is_granted is true;

-- 7. Confirm the latest assignment audit entry exists.
select
  action,
  entity_type,
  after_data ->> 'visible_access_type' as visible_access_type,
  after_data ->> 'effective_administrator' as effective_administrator,
  reason,
  created_at
from public.workforce_audit_logs
where action = 'arby_full_access_assignment'
  and entity_type = 'workforce_profile'
order by created_at desc
limit 5;

rollback;
