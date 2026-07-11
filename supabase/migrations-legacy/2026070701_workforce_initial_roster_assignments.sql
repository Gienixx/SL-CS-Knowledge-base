-- Phase 1 Step 3: assign the five-person internal test roster
-- and add a hidden system-administrator capability.
--
-- Test roster:
--   * Almar: Admin and Agent
--   * Arby: Regular Agent in the visible access model, hidden System Administrator
--   * Arez: Agent with Article Editor access
--   * Gen: Agent with Article Editor access
--   * Jean: Regular Agent
--
-- The existing dummy account and the six organizational-chart members who have
-- not yet been added to the site are intentionally left unchanged.

begin;

-- ---------------------------------------------------------------------------
-- Hidden system-administrator capability
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists is_system_admin boolean not null default false;

comment on column public.profiles.is_system_admin is
  'Hidden site-owner capability. Grants effective administrator scope without changing the visible base role or agent access type.';

create or replace function public.workforce_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.workforce_current_user_is_active()
    and (
      exists (
        select 1
        from public.profiles profile
        where profile.user_id = auth.uid()
          and (
            profile.base_role = 'admin'
            or profile.is_system_admin is true
          )
      )
      or exists (
        select 1
        from public.login login_user
        where lower(login_user.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
          and login_user.is_admin is true
      )
    );
$$;

revoke all on function public.workforce_is_admin() from public;
grant execute on function public.workforce_is_admin() to authenticated;

-- Keep login compatibility for older pages and Functions while preserving an
-- agent base role for a hidden system administrator.
create or replace function public.workforce_sync_login_record()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user_id uuid;
  v_email text;
  v_name text;
  v_is_admin boolean;
  v_can_edit boolean;
  v_permission text;
begin
  if tg_op = 'DELETE' then
    update public.profiles
    set employment_status = 'inactive', updated_at = now()
    where lower(email) = lower(old.email);

    update public.user_permissions
    set is_granted = false,
        reason = 'Revoked because the compatibility login record was deleted',
        updated_at = now()
    where user_id in (
      select user_id
      from public.profiles
      where lower(email) = lower(old.email)
    )
    and permission_key in (
      'manage_employees',
      'manage_schedules',
      'view_team_attendance',
      'approve_leave',
      'view_workforce_reports',
      'edit_articles'
    );

    return old;
  end if;

  v_email := lower(trim(new.email));
  v_name := coalesce(nullif(trim(new.name), ''), split_part(v_email, '@', 1));
  v_is_admin := coalesce(new.is_admin, false);
  v_can_edit := coalesce(new.can_edit_articles, false);

  select id
  into v_user_id
  from auth.users
  where lower(email) = v_email
  limit 1;

  if v_user_id is null and tg_op = 'UPDATE' then
    select user_id
    into v_user_id
    from public.profiles
    where lower(email) in (lower(old.email), v_email)
    limit 1;
  end if;

  if v_user_id is null then
    return new;
  end if;

  insert into public.profiles (
    user_id,
    full_name,
    email,
    employee_id,
    employment_status,
    base_role,
    is_agent,
    is_system_admin,
    can_edit_articles,
    can_manage_payroll
  ) values (
    v_user_id,
    v_name,
    v_email,
    'SL-' || upper(substr(replace(v_user_id::text, '-', ''), 1, 8)),
    'active',
    case when v_is_admin then 'admin' else 'agent' end,
    true,
    false,
    v_can_edit,
    false
  )
  on conflict (user_id) do update
  set full_name = excluded.full_name,
      email = excluded.email,
      employment_status = case
        when public.profiles.employment_status in ('inactive', 'terminated')
          then 'active'
        else public.profiles.employment_status
      end,
      base_role = case
        when public.profiles.is_system_admin is true
          then public.profiles.base_role
        else excluded.base_role
      end,
      can_edit_articles = excluded.can_edit_articles,
      updated_at = now();

  foreach v_permission in array array[
    'manage_employees',
    'manage_schedules',
    'view_team_attendance',
    'approve_leave',
    'view_workforce_reports'
  ] loop
    insert into public.user_permissions (
      user_id,
      permission_key,
      is_granted,
      reason
    ) values (
      v_user_id,
      v_permission,
      v_is_admin,
      'Synchronized from public.login.is_admin'
    )
    on conflict (user_id, permission_key) do update
    set is_granted = excluded.is_granted,
        reason = excluded.reason,
        updated_at = now();
  end loop;

  insert into public.user_permissions (
    user_id,
    permission_key,
    is_granted,
    reason
  ) values (
    v_user_id,
    'edit_articles',
    v_can_edit,
    'Synchronized from public.login.can_edit_articles'
  )
  on conflict (user_id, permission_key) do update
  set is_granted = excluded.is_granted,
      reason = excluded.reason,
      updated_at = now();

  return new;
end;
$$;

-- Whenever a profile changes, keep old login-based authorization compatible.
-- For Arby this stores is_admin=true internally while his visible profile stays
-- base_role=agent and is_agent=true.
create or replace function public.workforce_sync_profile_compatibility()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.login
  set is_admin = (new.base_role = 'admin' or new.is_system_admin is true),
      can_edit_articles = new.can_edit_articles,
      name = coalesce(nullif(trim(name), ''), new.full_name)
  where lower(email) = lower(new.email)
    and (
      is_admin is distinct from (new.base_role = 'admin' or new.is_system_admin is true)
      or can_edit_articles is distinct from new.can_edit_articles
      or nullif(trim(name), '') is null
    );

  return new;
end;
$$;

drop trigger if exists profiles_login_compatibility_sync on public.profiles;
create trigger profiles_login_compatibility_sync
after insert or update of base_role, is_system_admin, can_edit_articles, email
on public.profiles
for each row execute function public.workforce_sync_profile_compatibility();

-- Effective access reports system administrators as administrators for security
-- checks while retaining the underlying agent base role for visible role labels.
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
      v_is_active and coalesce(bool_or(permission_key = 'manage_employees' and is_granted), false),
    'manage_schedules',
      v_is_active and coalesce(bool_or(permission_key = 'manage_schedules' and is_granted), false),
    'view_team_attendance',
      v_is_active and coalesce(bool_or(permission_key = 'view_team_attendance' and is_granted), false),
    'approve_leave',
      v_is_active and coalesce(bool_or(permission_key = 'approve_leave' and is_granted), false),
    'view_workforce_reports',
      v_is_active and coalesce(bool_or(permission_key = 'view_workforce_reports' and is_granted), false),
    'edit_articles',
      v_is_active and coalesce(bool_or(permission_key = 'edit_articles' and is_granted), false),
    'manage_payroll',
      v_is_active and coalesce(bool_or(permission_key = 'manage_payroll' and is_granted), false)
  )
  into v_permissions
  from public.user_permissions
  where user_id = v_user_id;

  select
    coalesce((
      select login_user.is_admin
      from public.login login_user
      where lower(login_user.email) = lower(v_profile.email)
      limit 1
    ), false),
    coalesce((
      select login_user.can_edit_articles
      from public.login login_user
      where lower(login_user.email) = lower(v_profile.email)
      limit 1
    ), false)
  into v_legacy_is_admin, v_legacy_can_edit;

  return jsonb_build_object(
    'user_id', v_profile.user_id,
    'full_name', v_profile.full_name,
    'email', lower(v_profile.email),
    'employee_id', v_profile.employee_id,
    'employment_status', v_profile.employment_status,
    'is_active', v_is_active,
    'base_role', v_profile.base_role,
    'is_admin', v_is_active and (
      v_profile.base_role = 'admin'
      or v_profile.is_system_admin is true
    ),
    'is_system_admin', v_is_active and v_profile.is_system_admin,
    'is_agent', v_is_active and v_profile.is_agent,
    'team_id', v_profile.team_id,
    'supervisor_id', v_profile.supervisor_id,
    'timezone', v_profile.timezone,
    'permissions', v_permissions,
    'can_edit_articles', coalesce((v_permissions ->> 'edit_articles')::boolean, false),
    'can_manage_payroll', coalesce((v_permissions ->> 'manage_payroll')::boolean, false),
    'legacy', jsonb_build_object(
      'is_admin', v_legacy_is_admin,
      'can_edit_articles', v_legacy_can_edit
    )
  );
end;
$$;

revoke execute on function public.workforce_get_current_access() from anon;
revoke all on function public.workforce_get_current_access() from public;
grant execute on function public.workforce_get_current_access() to authenticated;

-- Protect the hidden site owner from losing access through the ordinary employee
-- editor. The hidden flag itself remains migration/service-role controlled.
create or replace function public.workforce_admin_save_employee(
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
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_base_role text;
  v_is_agent boolean;
  v_can_edit_articles boolean;
  v_can_manage_payroll boolean;
  v_permission_key text;
  v_is_granted boolean;
  v_permissions jsonb := '{}'::jsonb;
  v_normalized_name text := nullif(trim(coalesce(p_full_name, '')), '');
  v_normalized_employee_id text := nullif(trim(coalesce(p_employee_id, '')), '');
  v_normalized_timezone text := coalesce(nullif(trim(coalesce(p_timezone, '')), ''), 'Asia/Manila');
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if auth.uid() is null
     or not public.workforce_is_admin()
     or not public.workforce_has_permission('manage_employees') then
    raise exception 'You do not have permission to manage employees.' using errcode = '42501';
  end if;

  if p_user_id is null then
    raise exception 'Employee user ID is required.';
  end if;

  select *
  into v_profile
  from public.profiles
  where user_id = p_user_id
  for update;

  if not found then
    raise exception 'Employee profile not found.';
  end if;

  if v_normalized_name is null then
    raise exception 'Full name is required.';
  end if;

  if v_normalized_employee_id is null then
    raise exception 'Employee ID is required.';
  end if;

  if p_employment_status not in ('active', 'on_leave', 'inactive', 'terminated') then
    raise exception 'Invalid employment status.';
  end if;

  if v_profile.is_system_admin is true then
    v_base_role := 'agent';
    v_is_agent := true;
    v_can_edit_articles := true;
    v_can_manage_payroll := true;
  else
    case p_access_type
      when 'admin_agent' then
        v_base_role := 'admin';
        v_is_agent := true;
        v_can_edit_articles := coalesce((p_permissions ->> 'edit_articles')::boolean, false);
      when 'admin' then
        v_base_role := 'admin';
        v_is_agent := false;
        v_can_edit_articles := coalesce((p_permissions ->> 'edit_articles')::boolean, false);
      when 'agent_editor' then
        v_base_role := 'agent';
        v_is_agent := true;
        v_can_edit_articles := true;
      when 'regular_agent' then
        v_base_role := 'agent';
        v_is_agent := true;
        v_can_edit_articles := false;
      else
        raise exception 'Invalid access type.';
    end case;

    v_can_manage_payroll := coalesce((p_permissions ->> 'manage_payroll')::boolean, false);
  end if;

  if p_team_id is not null and not exists (
    select 1 from public.teams team where team.id = p_team_id
  ) then
    raise exception 'Selected team does not exist.';
  end if;

  if p_supervisor_id = p_user_id then
    raise exception 'An employee cannot supervise their own profile.';
  end if;

  if p_supervisor_id is not null and not exists (
    select 1
    from public.profiles supervisor
    where supervisor.user_id = p_supervisor_id
      and supervisor.employment_status in ('active', 'on_leave')
  ) then
    raise exception 'Selected supervisor is not an active workforce user.';
  end if;

  if p_user_id = auth.uid() and (
    (v_base_role <> 'admin' and v_profile.is_system_admin is not true)
    or p_employment_status not in ('active', 'on_leave')
    or (
      v_profile.is_system_admin is not true
      and coalesce((p_permissions ->> 'manage_employees')::boolean, false) is false
    )
  ) then
    raise exception 'You cannot remove your own active administrator and employee-management access.';
  end if;

  update public.profiles
  set full_name = v_normalized_name,
      employee_id = v_normalized_employee_id,
      employment_status = p_employment_status,
      base_role = v_base_role,
      is_agent = v_is_agent,
      team_id = p_team_id,
      supervisor_id = p_supervisor_id,
      can_edit_articles = v_can_edit_articles,
      can_manage_payroll = v_can_manage_payroll,
      timezone = v_normalized_timezone,
      updated_at = now()
  where user_id = p_user_id
  returning * into v_profile;

  foreach v_permission_key in array array[
    'manage_employees',
    'manage_schedules',
    'view_team_attendance',
    'approve_leave',
    'view_workforce_reports',
    'edit_articles',
    'manage_payroll'
  ] loop
    if v_profile.is_system_admin is true then
      v_is_granted := true;
    elsif v_permission_key = 'edit_articles' then
      v_is_granted := v_can_edit_articles;
    elsif v_permission_key = 'manage_payroll' then
      v_is_granted := v_can_manage_payroll;
    else
      v_is_granted := coalesce((p_permissions ->> v_permission_key)::boolean, false);
    end if;

    insert into public.user_permissions (
      user_id,
      permission_key,
      is_granted,
      granted_by,
      reason
    ) values (
      p_user_id,
      v_permission_key,
      v_is_granted,
      auth.uid(),
      coalesce(v_reason, 'Updated through workforce employee administration')
    )
    on conflict (user_id, permission_key) do update
    set is_granted = excluded.is_granted,
        granted_by = excluded.granted_by,
        reason = excluded.reason,
        updated_at = now();

    v_permissions := v_permissions || jsonb_build_object(v_permission_key, v_is_granted);
  end loop;

  return jsonb_build_object(
    'profile', to_jsonb(v_profile),
    'permissions', v_permissions,
    'access_type', case
      when v_profile.is_system_admin then 'regular_agent'
      else p_access_type
    end
  );
end;
$$;

revoke execute on function public.workforce_admin_save_employee(
  uuid, text, text, text, text, uuid, uuid, text, jsonb, text
) from anon;
revoke all on function public.workforce_admin_save_employee(
  uuid, text, text, text, text, uuid, uuid, text, jsonb, text
) from public;
grant execute on function public.workforce_admin_save_employee(
  uuid, text, text, text, text, uuid, uuid, text, jsonb, text
) to authenticated;

-- ---------------------------------------------------------------------------
-- Five-person test roster
-- ---------------------------------------------------------------------------

create temporary table workforce_test_roster (
  member_key text primary key,
  expected_base_role text not null,
  expected_is_agent boolean not null,
  expected_is_system_admin boolean not null,
  team_name text,
  supervisor_key text,
  manage_employees boolean not null,
  manage_schedules boolean not null,
  view_team_attendance boolean not null,
  approve_leave boolean not null,
  view_workforce_reports boolean not null,
  edit_articles boolean not null,
  manage_payroll boolean not null
) on commit drop;

insert into workforce_test_roster values
  ('almar', 'admin', true,  false, null,           null,    true,  true,  true,  true,  true,  false, false),
  ('arby',  'agent', true,  true,  'Support Team', 'almar', true,  true,  true,  true,  true,  true,  true),
  ('arez',  'agent', true,  false, 'Cashout Team', 'almar', false, false, false, false, false, true,  false),
  ('gen',   'agent', true,  false, 'Support Team', 'almar', false, false, false, false, false, true,  false),
  ('jean',  'agent', true,  false, 'Support Team', 'almar', false, false, false, false, false, false, false);

create temporary table workforce_test_candidates on commit drop as
select
  roster.member_key,
  count(distinct profile.user_id)::integer as candidate_count,
  array_remove(array_agg(distinct profile.user_id), null) as candidate_ids
from workforce_test_roster roster
left join public.profiles profile
  on lower(trim(profile.full_name)) = roster.member_key
  or lower(split_part(trim(profile.full_name), ' ', 1)) = roster.member_key
  or lower(split_part(profile.email, '@', 1)) = roster.member_key
  or lower(split_part(profile.email, '@', 1)) ~ ('^' || roster.member_key || '[._-]')
  or exists (
    select 1
    from public.login login_user
    where lower(login_user.email) = lower(profile.email)
      and (
        lower(trim(coalesce(login_user.name, ''))) = roster.member_key
        or lower(split_part(trim(coalesce(login_user.name, '')), ' ', 1)) = roster.member_key
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
  from workforce_test_candidates
  where candidate_count <> 1;

  if v_resolution_errors is not null then
    raise exception 'Five-person workforce test roster could not be resolved safely: %', v_resolution_errors;
  end if;
end;
$$;

create temporary table workforce_test_matches on commit drop as
select
  roster.*,
  candidates.candidate_ids[1] as user_id
from workforce_test_roster roster
join workforce_test_candidates candidates using (member_key);

alter table workforce_test_matches add primary key (member_key);

-- All five named testers must already have compatibility login records. Other
-- profiles, including the dummy account, are allowed and are not modified.
do $$
declare
  v_missing_logins text;
begin
  select string_agg(matches.member_key, ', ' order by matches.member_key)
  into v_missing_logins
  from workforce_test_matches matches
  join public.profiles profile on profile.user_id = matches.user_id
  left join public.login login_user on lower(login_user.email) = lower(profile.email)
  where login_user.email is null;

  if v_missing_logins is not null then
    raise exception 'Test roster profiles without public.login records: %', v_missing_logins;
  end if;
end;
$$;

insert into public.teams (name, description, is_active)
select seed.name, seed.description, true
from (
  values
    ('Cashout Team'::text, 'Cashout support operations'::text),
    ('Support Team'::text, 'General customer support operations'::text)
) as seed(name, description)
where not exists (
  select 1
  from public.teams existing
  where lower(existing.name) = lower(seed.name)
);

update public.teams team
set description = case lower(team.name)
      when 'cashout team' then 'Cashout support operations'
      when 'support team' then 'General customer support operations'
      else team.description
    end,
    supervisor_id = (
      select user_id from workforce_test_matches where member_key = 'almar'
    ),
    is_active = true,
    updated_at = now()
where lower(team.name) in ('cashout team', 'support team');

update public.profiles profile
set employment_status = 'active',
    base_role = matches.expected_base_role,
    is_agent = matches.expected_is_agent,
    is_system_admin = matches.expected_is_system_admin,
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
        from workforce_test_matches supervisor
        where supervisor.member_key = matches.supervisor_key
      )
    end,
    can_edit_articles = matches.edit_articles,
    can_manage_payroll = matches.manage_payroll,
    timezone = 'Asia/Manila',
    updated_at = now()
from workforce_test_matches matches
where profile.user_id = matches.user_id;

-- The profile compatibility trigger sets public.login.is_admin=true for Almar
-- and for hidden system administrator Arby, while preserving their visible roles.
update public.login login_user
set is_admin = (
      matches.expected_base_role = 'admin'
      or matches.expected_is_system_admin is true
    ),
    can_edit_articles = matches.edit_articles
from workforce_test_matches matches
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
      when 'edit_articles' then matches.edit_articles
      when 'manage_payroll' then matches.manage_payroll
      else false
    end as is_granted
  from workforce_test_matches matches
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
  'Phase 1 Step 3 five-person internal test assignment'
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
  'internal_test_roster_assignment',
  'workforce_rollout',
  jsonb_build_object(
    'member_count', count(*),
    'members', jsonb_agg(
      jsonb_build_object(
        'member_key', matches.member_key,
        'user_id', matches.user_id,
        'base_role', matches.expected_base_role,
        'is_agent', matches.expected_is_agent,
        'is_system_admin', matches.expected_is_system_admin,
        'team', matches.team_name,
        'supervisor', matches.supervisor_key,
        'edit_articles', matches.edit_articles,
        'manage_payroll', matches.manage_payroll
      ) order by matches.member_key
    )
  ),
  'Assigned the five-person internal workforce test roster; non-test users were left unchanged'
from workforce_test_matches matches;

-- Transactional assertions. Any mismatch rolls back the complete migration.
do $$
begin
  if (select count(*) from workforce_test_matches) <> 5 then
    raise exception 'Expected exactly five resolved test-roster users.';
  end if;

  if exists (
    select 1
    from workforce_test_matches matches
    join public.profiles profile on profile.user_id = matches.user_id
    left join public.teams team on team.id = profile.team_id
    left join workforce_test_matches supervisor
      on supervisor.user_id = profile.supervisor_id
    where profile.employment_status <> 'active'
       or profile.base_role is distinct from matches.expected_base_role
       or profile.is_agent is distinct from matches.expected_is_agent
       or profile.is_system_admin is distinct from matches.expected_is_system_admin
       or lower(coalesce(team.name, '')) is distinct from lower(coalesce(matches.team_name, ''))
       or coalesce(supervisor.member_key, '') is distinct from coalesce(matches.supervisor_key, '')
       or profile.can_edit_articles is distinct from matches.edit_articles
       or profile.can_manage_payroll is distinct from matches.manage_payroll
  ) then
    raise exception 'A test-roster profile assignment did not match the approved access matrix.';
  end if;

  if exists (
    select 1
    from workforce_test_matches matches
    join public.profiles profile on profile.user_id = matches.user_id
    join public.login login_user on lower(login_user.email) = lower(profile.email)
    where login_user.is_admin is distinct from (
            matches.expected_base_role = 'admin'
            or matches.expected_is_system_admin is true
          )
       or login_user.can_edit_articles is distinct from matches.edit_articles
  ) then
    raise exception 'Login compatibility did not match the approved test-roster access matrix.';
  end if;
end;
$$;

commit;
