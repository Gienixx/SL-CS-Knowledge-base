-- Phase 1 Step 3: assign the initial 11-person workforce roster
--
-- Role model derived from the current organizational chart:
--   * Kirby and Tommy: admin-only co-owners with payroll access
--   * Almar: admin + agent, workforce administrator, and team supervisor
--   * Remaining eight members: agents assigned to Cashout or Support
--
-- Existing article-editor access is intentionally preserved from profiles/login.
-- The migration is fail-closed: every roster alias must resolve to exactly one
-- approved workforce profile before any assignment is committed.

begin;

create temporary table workforce_rollout_roster (
  member_key text primary key,
  lookup_name text not null,
  expected_base_role text not null,
  expected_is_agent boolean not null,
  team_name text,
  supervisor_key text,
  manage_employees boolean not null,
  manage_schedules boolean not null,
  view_team_attendance boolean not null,
  approve_leave boolean not null,
  view_workforce_reports boolean not null,
  manage_payroll boolean not null
) on commit drop;

insert into workforce_rollout_roster (
  member_key,
  lookup_name,
  expected_base_role,
  expected_is_agent,
  team_name,
  supervisor_key,
  manage_employees,
  manage_schedules,
  view_team_attendance,
  approve_leave,
  view_workforce_reports,
  manage_payroll
) values
  ('kirby',   'kirby',   'admin', false, null,            null,    true,  true,  true,  true,  true,  true),
  ('tommy',   'tommy',   'admin', false, null,            null,    true,  true,  true,  true,  true,  true),
  ('almar',   'almar',   'admin', true,  'Leadership',    'kirby', true,  true,  true,  true,  true,  false),
  ('arez',    'arez',    'agent', true,  'Cashout Team',  'almar', false, false, false, false, false, false),
  ('jerson',  'jerson',  'agent', true,  'Cashout Team',  'almar', false, false, false, false, false, false),
  ('tristan', 'tristan', 'agent', true,  'Cashout Team',  'almar', false, false, false, false, false, false),
  ('amora',   'amora',   'agent', true,  'Support Team',  'almar', false, false, false, false, false, false),
  ('arby',    'arby',    'agent', true,  'Support Team',  'almar', false, false, false, false, false, false),
  ('ford',    'ford',    'agent', true,  'Support Team',  'almar', false, false, false, false, false, false),
  ('gen',     'gen',     'agent', true,  'Support Team',  'almar', false, false, false, false, false, false),
  ('jean',    'jean',    'agent', true,  'Support Team',  'almar', false, false, false, false, false, false);

create temporary table workforce_rollout_candidates on commit drop as
select
  roster.member_key,
  count(distinct profile.user_id)::integer as candidate_count,
  array_remove(array_agg(distinct profile.user_id), null) as candidate_ids
from workforce_rollout_roster roster
left join public.profiles profile
  on lower(trim(profile.full_name)) = roster.lookup_name
  or lower(split_part(trim(profile.full_name), ' ', 1)) = roster.lookup_name
  or lower(split_part(profile.email, '@', 1)) = roster.lookup_name
  or lower(split_part(profile.email, '@', 1)) ~ ('^' || roster.lookup_name || '[._-]')
  or exists (
    select 1
    from public.login login_user
    where lower(login_user.email) = lower(profile.email)
      and (
        lower(trim(coalesce(login_user.name, ''))) = roster.lookup_name
        or lower(split_part(trim(coalesce(login_user.name, '')), ' ', 1)) = roster.lookup_name
      )
  )
group by roster.member_key;

do $$
declare
  v_resolution_errors text;
begin
  select string_agg(
    format('%s resolved to %s profile(s)', member_key, candidate_count),
    '; ' order by member_key
  )
  into v_resolution_errors
  from workforce_rollout_candidates
  where candidate_count <> 1;

  if v_resolution_errors is not null then
    raise exception 'Initial workforce roster could not be resolved safely: %', v_resolution_errors;
  end if;
end;
$$;

create temporary table workforce_rollout_matches on commit drop as
select
  roster.*,
  candidates.candidate_ids[1] as user_id
from workforce_rollout_roster roster
join workforce_rollout_candidates candidates using (member_key);

alter table workforce_rollout_matches
  add primary key (member_key);

-- Every roster member must remain connected to the compatibility login table.
do $$
declare
  v_missing_logins text;
begin
  select string_agg(matches.member_key, ', ' order by matches.member_key)
  into v_missing_logins
  from workforce_rollout_matches matches
  join public.profiles profile on profile.user_id = matches.user_id
  left join public.login login_user on lower(login_user.email) = lower(profile.email)
  where login_user.email is null;

  if v_missing_logins is not null then
    raise exception 'Roster profiles without public.login records: %', v_missing_logins;
  end if;
end;
$$;

insert into public.teams (name, description, is_active)
select seed.name, seed.description, true
from (
  values
    ('Leadership'::text, 'Workforce leadership and support management'),
    ('Cashout Team'::text, 'Cashout support operations'),
    ('Support Team'::text, 'General customer support operations')
) as seed(name, description)
where not exists (
  select 1
  from public.teams existing
  where lower(existing.name) = lower(seed.name)
);

update public.teams team
set description = case lower(team.name)
      when 'leadership' then 'Workforce leadership and support management'
      when 'cashout team' then 'Cashout support operations'
      when 'support team' then 'General customer support operations'
      else team.description
    end,
    supervisor_id = case lower(team.name)
      when 'leadership' then (
        select user_id from workforce_rollout_matches where member_key = 'kirby'
      )
      when 'cashout team' then (
        select user_id from workforce_rollout_matches where member_key = 'almar'
      )
      when 'support team' then (
        select user_id from workforce_rollout_matches where member_key = 'almar'
      )
      else team.supervisor_id
    end,
    is_active = true,
    updated_at = now()
where lower(team.name) in ('leadership', 'cashout team', 'support team');

update public.profiles profile
set employment_status = 'active',
    base_role = matches.expected_base_role,
    is_agent = matches.expected_is_agent,
    team_id = case
      when matches.team_name is null then null
      else (
        select team.id
        from public.teams team
        where lower(team.name) = lower(matches.team_name)
      )
    end,
    supervisor_id = case
      when matches.supervisor_key is null then null
      else (
        select supervisor.user_id
        from workforce_rollout_matches supervisor
        where supervisor.member_key = matches.supervisor_key
      )
    end,
    can_manage_payroll = matches.manage_payroll,
    timezone = 'Asia/Manila',
    updated_at = now()
from workforce_rollout_matches matches
where profile.user_id = matches.user_id;

-- Keep the existing dashboard/article compatibility source aligned. This may
-- fire the legacy synchronization trigger, so explicit permission upserts are
-- intentionally performed after this update.
update public.login login_user
set is_admin = matches.expected_base_role = 'admin',
    can_edit_articles = profile.can_edit_articles
from workforce_rollout_matches matches
join public.profiles profile on profile.user_id = matches.user_id
where lower(login_user.email) = lower(profile.email);

with permission_keys(permission_key) as (
  values
    ('manage_employees'::text),
    ('manage_schedules'::text),
    ('view_team_attendance'::text),
    ('approve_leave'::text),
    ('view_workforce_reports'::text),
    ('edit_articles'::text),
    ('manage_payroll'::text)
), resolved_permissions as (
  select
    matches.user_id,
    keys.permission_key,
    case keys.permission_key
      when 'manage_employees' then matches.manage_employees
      when 'manage_schedules' then matches.manage_schedules
      when 'view_team_attendance' then matches.view_team_attendance
      when 'approve_leave' then matches.approve_leave
      when 'view_workforce_reports' then matches.view_workforce_reports
      when 'edit_articles' then profile.can_edit_articles
      when 'manage_payroll' then matches.manage_payroll
      else false
    end as is_granted
  from workforce_rollout_matches matches
  join public.profiles profile on profile.user_id = matches.user_id
  cross join permission_keys keys
)
insert into public.user_permissions (
  user_id,
  permission_key,
  is_granted,
  reason
)
select
  resolved.user_id,
  resolved.permission_key,
  resolved.is_granted,
  'Phase 1 Step 3 initial roster assignment'
from resolved_permissions resolved
on conflict (user_id, permission_key) do update
set is_granted = excluded.is_granted,
    reason = excluded.reason,
    updated_at = now();

insert into public.workforce_audit_logs (
  action,
  entity_type,
  after_data,
  reason
)
select
  'initial_roster_assignment',
  'workforce_rollout',
  jsonb_build_object(
    'member_count', count(*),
    'members', jsonb_agg(
      jsonb_build_object(
        'member_key', matches.member_key,
        'user_id', matches.user_id,
        'base_role', matches.expected_base_role,
        'is_agent', matches.expected_is_agent,
        'team', matches.team_name,
        'supervisor', matches.supervisor_key,
        'manage_payroll', matches.manage_payroll
      ) order by matches.member_key
    )
  ),
  'Assigned the initial 11-person workforce roster for Phase 1 Step 3'
from workforce_rollout_matches matches;

commit;
