-- Phase 1 Step 3 five-person internal test-roster verification
-- Run after 2026070701_workforce_initial_roster_assignments.sql.
-- Queries marked "should return 0 rows" are deployment blockers.
-- Other profiles, including the dummy account, are intentionally allowed.

begin;

create temporary table workforce_expected_test_roster (
  member_key text primary key,
  expected_base_role text not null,
  expected_is_agent boolean not null,
  expected_is_system_admin boolean not null,
  expected_team_name text,
  expected_supervisor_key text,
  manage_employees boolean not null,
  manage_schedules boolean not null,
  view_team_attendance boolean not null,
  approve_leave boolean not null,
  view_workforce_reports boolean not null,
  edit_articles boolean not null,
  manage_payroll boolean not null
) on commit drop;

insert into workforce_expected_test_roster values
  ('almar', 'admin', true,  false, null,           null,    true,  true,  true,  true,  true,  false, false),
  ('arby',  'agent', true,  true,  'Support Team', 'almar', true,  true,  true,  true,  true,  true,  true),
  ('arez',  'agent', true,  false, 'Cashout Team', 'almar', false, false, false, false, false, true,  false),
  ('gen',   'agent', true,  false, 'Support Team', 'almar', false, false, false, false, false, true,  false),
  ('jean',  'agent', true,  false, 'Support Team', 'almar', false, false, false, false, false, false, false);

create temporary table workforce_test_resolution on commit drop as
select
  expected.member_key,
  count(distinct profile.user_id)::integer as candidate_count,
  array_remove(array_agg(distinct profile.user_id), null) as candidate_ids,
  string_agg(distinct profile.email, ', ' order by profile.email) as candidate_emails
from workforce_expected_test_roster expected
left join public.profiles profile
  on lower(trim(profile.full_name)) = expected.member_key
  or lower(split_part(trim(profile.full_name), ' ', 1)) = expected.member_key
  or lower(split_part(profile.email, '@', 1)) = expected.member_key
  or lower(split_part(profile.email, '@', 1)) ~ ('^' || expected.member_key || '[._-]')
  or exists (
    select 1
    from public.login login_user
    where lower(login_user.email) = lower(profile.email)
      and (
        lower(trim(coalesce(login_user.name, ''))) = expected.member_key
        or lower(split_part(trim(coalesce(login_user.name, '')), ' ', 1)) = expected.member_key
      )
  )
group by expected.member_key;

create temporary table workforce_resolved_test_roster on commit drop as
select
  expected.*,
  resolution.candidate_count,
  resolution.candidate_emails,
  resolution.candidate_ids[1] as user_id
from workforce_expected_test_roster expected
join workforce_test_resolution resolution using (member_key);

-- 1. Alias resolution blockers: should return 0 rows.
select
  member_key,
  candidate_count,
  candidate_emails
from workforce_resolved_test_roster
where candidate_count <> 1
order by member_key;

-- 2. Review the complete five-person test matrix: should return 5 rows.
select
  resolved.member_key,
  profile.full_name,
  profile.email,
  profile.employee_id,
  profile.employment_status,
  case
    when profile.is_system_admin is true then 'Regular Agent'
    when profile.base_role = 'admin' and profile.is_agent is true then 'Admin and Agent'
    when profile.base_role = 'admin' and profile.is_agent is false then 'Admin'
    when profile.base_role = 'agent' and profile.is_agent is true and profile.can_edit_articles is true
      then 'Agent with Article Editor access'
    when profile.base_role = 'agent' and profile.is_agent is true then 'Regular Agent'
    else 'Review required'
  end as visible_access_type,
  profile.is_system_admin,
  team.name as team_name,
  supervisor.full_name as supervisor_name,
  profile.can_edit_articles,
  profile.can_manage_payroll
from workforce_resolved_test_roster resolved
join public.profiles profile on profile.user_id = resolved.user_id
left join public.teams team on team.id = profile.team_id
left join public.profiles supervisor on supervisor.user_id = profile.supervisor_id
order by case resolved.member_key
  when 'almar' then 1
  when 'arby' then 2
  when 'arez' then 3
  when 'gen' then 4
  when 'jean' then 5
  else 99
end;

-- 3. Role, team, supervisor, article, payroll, and hidden-role mismatches:
-- should return 0 rows.
select
  resolved.member_key,
  profile.email,
  resolved.expected_base_role,
  profile.base_role as actual_base_role,
  resolved.expected_is_agent,
  profile.is_agent as actual_is_agent,
  resolved.expected_is_system_admin,
  profile.is_system_admin as actual_is_system_admin,
  resolved.expected_team_name,
  actual_team.name as actual_team_name,
  resolved.expected_supervisor_key,
  actual_supervisor.full_name as actual_supervisor_name,
  resolved.edit_articles as expected_article_editor,
  profile.can_edit_articles as actual_article_editor,
  resolved.manage_payroll as expected_payroll,
  profile.can_manage_payroll as actual_payroll,
  profile.employment_status,
  profile.timezone
from workforce_resolved_test_roster resolved
join public.profiles profile on profile.user_id = resolved.user_id
left join public.teams actual_team on actual_team.id = profile.team_id
left join public.profiles actual_supervisor on actual_supervisor.user_id = profile.supervisor_id
left join workforce_resolved_test_roster expected_supervisor
  on expected_supervisor.member_key = resolved.expected_supervisor_key
where resolved.candidate_count <> 1
   or profile.employment_status <> 'active'
   or profile.base_role is distinct from resolved.expected_base_role
   or profile.is_agent is distinct from resolved.expected_is_agent
   or profile.is_system_admin is distinct from resolved.expected_is_system_admin
   or lower(coalesce(actual_team.name, '')) is distinct from lower(coalesce(resolved.expected_team_name, ''))
   or profile.supervisor_id is distinct from expected_supervisor.user_id
   or profile.can_edit_articles is distinct from resolved.edit_articles
   or profile.can_manage_payroll is distinct from resolved.manage_payroll
   or profile.timezone <> 'Asia/Manila'
order by resolved.member_key;

-- 4. Explicit permission mismatches: should return 0 rows.
with permission_keys(permission_key) as (
  values
    ('manage_employees'::text),
    ('manage_schedules'::text),
    ('view_team_attendance'::text),
    ('approve_leave'::text),
    ('view_workforce_reports'::text),
    ('edit_articles'::text),
    ('manage_payroll'::text)
), expected_permissions as (
  select
    resolved.member_key,
    resolved.user_id,
    keys.permission_key,
    case keys.permission_key
      when 'manage_employees' then resolved.manage_employees
      when 'manage_schedules' then resolved.manage_schedules
      when 'view_team_attendance' then resolved.view_team_attendance
      when 'approve_leave' then resolved.approve_leave
      when 'view_workforce_reports' then resolved.view_workforce_reports
      when 'edit_articles' then resolved.edit_articles
      when 'manage_payroll' then resolved.manage_payroll
      else false
    end as expected_is_granted
  from workforce_resolved_test_roster resolved
  cross join permission_keys keys
)
select
  expected.member_key,
  expected.permission_key,
  expected.expected_is_granted,
  permission.is_granted as actual_is_granted,
  permission.reason
from expected_permissions expected
left join public.user_permissions permission
  on permission.user_id = expected.user_id
 and permission.permission_key = expected.permission_key
where permission.id is null
   or permission.is_granted is distinct from expected.expected_is_granted
order by expected.member_key, expected.permission_key;

-- 5. Login compatibility mismatches: should return 0 rows.
-- Arby is internally is_admin=true for legacy site maintenance while remaining
-- base_role=agent in the visible workforce model.
select
  resolved.member_key,
  profile.email,
  profile.base_role,
  profile.is_system_admin,
  login_user.is_admin,
  profile.can_edit_articles,
  login_user.can_edit_articles
from workforce_resolved_test_roster resolved
join public.profiles profile on profile.user_id = resolved.user_id
left join public.login login_user on lower(login_user.email) = lower(profile.email)
where login_user.email is null
   or login_user.is_admin is distinct from (
        resolved.expected_base_role = 'admin'
        or resolved.expected_is_system_admin is true
      )
   or login_user.can_edit_articles is distinct from resolved.edit_articles
order by resolved.member_key;

-- 6. Hidden system administrator constraints: should return 0 rows.
select
  profile.full_name,
  profile.email,
  profile.base_role,
  profile.is_agent,
  profile.is_system_admin,
  permission.permission_key,
  permission.is_granted
from public.profiles profile
left join public.user_permissions permission
  on permission.user_id = profile.user_id
where profile.is_system_admin is true
  and (
    lower(split_part(profile.email, '@', 1)) <> 'arby'
    or profile.base_role <> 'agent'
    or profile.is_agent is not true
    or permission.permission_key is null
    or permission.is_granted is not true
  )
order by profile.email, permission.permission_key;

-- 7. Confirm exactly one hidden system administrator exists and it is Arby.
select
  count(*) as system_administrator_count,
  string_agg(full_name, ', ' order by full_name) as system_administrators
from public.profiles
where is_system_admin is true;

-- 8. Operational team totals for the named test roster: expected Cashout 1,
-- Support 3, and Unassigned 1. The dummy account is excluded from these totals.
select
  coalesce(team.name, 'Unassigned') as team_name,
  count(*) as test_roster_members
from workforce_resolved_test_roster resolved
join public.profiles profile on profile.user_id = resolved.user_id
left join public.teams team on team.id = profile.team_id
group by coalesce(team.name, 'Unassigned')
order by team_name;

-- 9. Team supervisors: expected Almar for Cashout Team and Support Team.
select
  team.name,
  supervisor.full_name as supervisor_name,
  supervisor.email as supervisor_email,
  team.is_active
from public.teams team
left join public.profiles supervisor on supervisor.user_id = team.supervisor_id
where lower(team.name) in ('cashout team', 'support team')
order by team.name;

-- 10. Profiles outside the five-person test roster are listed for confirmation.
-- The dummy account should appear here and should remain unchanged.
select
  profile.full_name,
  profile.email,
  profile.employee_id,
  profile.base_role,
  profile.is_agent,
  profile.is_system_admin,
  profile.employment_status
from public.profiles profile
where profile.user_id not in (
  select user_id
  from workforce_resolved_test_roster
  where candidate_count = 1
)
order by profile.email;

-- 11. The rollout audit entry should exist.
select
  action,
  entity_type,
  after_data ->> 'member_count' as member_count,
  reason,
  created_at
from public.workforce_audit_logs
where action = 'internal_test_roster_assignment'
  and entity_type = 'workforce_rollout'
order by created_at desc
limit 5;

rollback;
