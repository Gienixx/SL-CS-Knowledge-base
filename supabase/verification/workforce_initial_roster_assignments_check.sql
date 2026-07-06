-- Phase 1 Step 3 initial-roster verification
-- Run after 2026070701_workforce_initial_roster_assignments.sql.
-- Queries marked "should return 0 rows" are deployment blockers.

begin;

create temporary table workforce_expected_roster (
  member_key text primary key,
  lookup_name text not null,
  expected_base_role text not null,
  expected_is_agent boolean not null,
  expected_team_name text,
  expected_supervisor_key text,
  manage_employees boolean not null,
  manage_schedules boolean not null,
  view_team_attendance boolean not null,
  approve_leave boolean not null,
  view_workforce_reports boolean not null,
  manage_payroll boolean not null
) on commit drop;

insert into workforce_expected_roster values
  ('kirby',   'kirby',   'admin', false, null,           null,    true,  true,  true,  true,  true,  true),
  ('tommy',   'tommy',   'admin', false, null,           null,    true,  true,  true,  true,  true,  true),
  ('almar',   'almar',   'admin', true,  'Leadership',   'kirby', true,  true,  true,  true,  true,  false),
  ('arez',    'arez',    'agent', true,  'Cashout Team', 'almar', false, false, false, false, false, false),
  ('jerson',  'jerson',  'agent', true,  'Cashout Team', 'almar', false, false, false, false, false, false),
  ('tristan', 'tristan', 'agent', true,  'Cashout Team', 'almar', false, false, false, false, false, false),
  ('amora',   'amora',   'agent', true,  'Support Team', 'almar', false, false, false, false, false, false),
  ('arby',    'arby',    'agent', true,  'Support Team', 'almar', false, false, false, false, false, false),
  ('ford',    'ford',    'agent', true,  'Support Team', 'almar', false, false, false, false, false, false),
  ('gen',     'gen',     'agent', true,  'Support Team', 'almar', false, false, false, false, false, false),
  ('jean',    'jean',    'agent', true,  'Support Team', 'almar', false, false, false, false, false, false);

create temporary table workforce_roster_resolution on commit drop as
select
  expected.member_key,
  count(distinct profile.user_id)::integer as candidate_count,
  array_remove(array_agg(distinct profile.user_id), null) as candidate_ids,
  string_agg(distinct profile.email, ', ' order by profile.email) as candidate_emails
from workforce_expected_roster expected
left join public.profiles profile
  on lower(trim(profile.full_name)) = expected.lookup_name
  or lower(split_part(trim(profile.full_name), ' ', 1)) = expected.lookup_name
  or lower(split_part(profile.email, '@', 1)) = expected.lookup_name
  or lower(split_part(profile.email, '@', 1)) ~ ('^' || expected.lookup_name || '[._-]')
  or exists (
    select 1
    from public.login login_user
    where lower(login_user.email) = lower(profile.email)
      and (
        lower(trim(coalesce(login_user.name, ''))) = expected.lookup_name
        or lower(split_part(trim(coalesce(login_user.name, '')), ' ', 1)) = expected.lookup_name
      )
  )
group by expected.member_key;

create temporary table workforce_resolved_roster on commit drop as
select
  expected.*,
  resolution.candidate_count,
  resolution.candidate_emails,
  resolution.candidate_ids[1] as user_id
from workforce_expected_roster expected
join workforce_roster_resolution resolution using (member_key);

-- 1. Alias resolution blockers: should return 0 rows.
select
  member_key,
  candidate_count,
  candidate_emails
from workforce_resolved_roster
where candidate_count <> 1
order by member_key;

-- 2. Review the complete 11-person access matrix: should return 11 rows.
select
  resolved.member_key,
  profile.full_name,
  profile.email,
  profile.employee_id,
  profile.employment_status,
  case
    when profile.base_role = 'admin' and profile.is_agent is true then 'Admin and Agent'
    when profile.base_role = 'admin' and profile.is_agent is false then 'Admin'
    when profile.base_role = 'agent' and profile.is_agent is true and profile.can_edit_articles is true
      then 'Agent with Article Editor access'
    when profile.base_role = 'agent' and profile.is_agent is true then 'Regular Agent'
    else 'Review required'
  end as access_type,
  team.name as team_name,
  supervisor.full_name as supervisor_name,
  profile.can_edit_articles,
  profile.can_manage_payroll
from workforce_resolved_roster resolved
join public.profiles profile on profile.user_id = resolved.user_id
left join public.teams team on team.id = profile.team_id
left join public.profiles supervisor on supervisor.user_id = profile.supervisor_id
order by case resolved.member_key
  when 'kirby' then 1
  when 'tommy' then 2
  when 'almar' then 3
  when 'arez' then 4
  when 'jerson' then 5
  when 'tristan' then 6
  when 'amora' then 7
  when 'arby' then 8
  when 'ford' then 9
  when 'gen' then 10
  when 'jean' then 11
  else 99
end;

-- 3. Role, employment, team, supervisor, timezone, and payroll mismatches:
-- should return 0 rows.
select
  resolved.member_key,
  profile.email,
  resolved.expected_base_role,
  profile.base_role as actual_base_role,
  resolved.expected_is_agent,
  profile.is_agent as actual_is_agent,
  resolved.expected_team_name,
  actual_team.name as actual_team_name,
  resolved.expected_supervisor_key,
  actual_supervisor.full_name as actual_supervisor_name,
  resolved.manage_payroll as expected_payroll,
  profile.can_manage_payroll as actual_payroll,
  profile.employment_status,
  profile.timezone
from workforce_resolved_roster resolved
join public.profiles profile on profile.user_id = resolved.user_id
left join public.teams actual_team on actual_team.id = profile.team_id
left join public.profiles actual_supervisor on actual_supervisor.user_id = profile.supervisor_id
left join workforce_resolved_roster expected_supervisor
  on expected_supervisor.member_key = resolved.expected_supervisor_key
where resolved.candidate_count <> 1
   or profile.employment_status <> 'active'
   or profile.base_role is distinct from resolved.expected_base_role
   or profile.is_agent is distinct from resolved.expected_is_agent
   or lower(coalesce(actual_team.name, '')) is distinct from lower(coalesce(resolved.expected_team_name, ''))
   or profile.supervisor_id is distinct from expected_supervisor.user_id
   or profile.can_manage_payroll is distinct from resolved.manage_payroll
   or profile.timezone <> 'Asia/Manila'
order by resolved.member_key;

-- 4. Explicit workforce-permission mismatches: should return 0 rows.
with permission_keys(permission_key) as (
  values
    ('manage_employees'::text),
    ('manage_schedules'::text),
    ('view_team_attendance'::text),
    ('approve_leave'::text),
    ('view_workforce_reports'::text),
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
      when 'manage_payroll' then resolved.manage_payroll
      else false
    end as expected_is_granted
  from workforce_resolved_roster resolved
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

-- 5. Article-editor compatibility mismatches: should return 0 rows.
select
  resolved.member_key,
  profile.email,
  profile.can_edit_articles,
  permission.is_granted as edit_articles_permission,
  login_user.can_edit_articles as login_article_editor
from workforce_resolved_roster resolved
join public.profiles profile on profile.user_id = resolved.user_id
left join public.user_permissions permission
  on permission.user_id = profile.user_id
 and permission.permission_key = 'edit_articles'
left join public.login login_user on lower(login_user.email) = lower(profile.email)
where permission.id is null
   or permission.is_granted is distinct from profile.can_edit_articles
   or login_user.email is null
   or login_user.can_edit_articles is distinct from profile.can_edit_articles
order by resolved.member_key;

-- 6. Admin compatibility mismatches: should return 0 rows.
select
  resolved.member_key,
  profile.email,
  profile.base_role,
  login_user.is_admin
from workforce_resolved_roster resolved
join public.profiles profile on profile.user_id = resolved.user_id
left join public.login login_user on lower(login_user.email) = lower(profile.email)
where login_user.email is null
   or login_user.is_admin is distinct from (profile.base_role = 'admin')
order by resolved.member_key;

-- 7. Team membership totals for the assigned roster: expected Leadership 1,
-- Cashout Team 3, Support Team 5, and Unassigned 2 admin-only co-owners.
select
  coalesce(team.name, 'Unassigned') as team_name,
  count(*) as roster_members
from workforce_resolved_roster resolved
join public.profiles profile on profile.user_id = resolved.user_id
left join public.teams team on team.id = profile.team_id
group by coalesce(team.name, 'Unassigned')
order by team_name;

-- 8. Team supervisors: expected Kirby for Leadership and Almar for both
-- operational teams.
select
  team.name,
  supervisor.full_name as supervisor_name,
  supervisor.email as supervisor_email,
  team.is_active
from public.teams team
left join public.profiles supervisor on supervisor.user_id = team.supervisor_id
where lower(team.name) in ('leadership', 'cashout team', 'support team')
order by team.name;

-- 9. Payroll grants outside Kirby and Tommy: should return 0 rows.
select
  profile.full_name,
  profile.email,
  permission.is_granted,
  permission.reason
from public.user_permissions permission
join public.profiles profile on profile.user_id = permission.user_id
where permission.permission_key = 'manage_payroll'
  and permission.is_granted is true
  and permission.user_id not in (
    select user_id
    from workforce_resolved_roster
    where member_key in ('kirby', 'tommy')
  )
order by profile.email;

-- 10. Active/on-leave workforce count. The current rollout target is 11.
select count(*) as active_workforce_users
from public.profiles
where employment_status in ('active', 'on_leave');

-- 11. The rollout audit entry should exist.
select
  action,
  entity_type,
  after_data ->> 'member_count' as member_count,
  reason,
  created_at
from public.workforce_audit_logs
where action = 'initial_roster_assignment'
  and entity_type = 'workforce_rollout'
order by created_at desc
limit 5;

rollback;
