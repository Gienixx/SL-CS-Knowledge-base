-- Ensure the Arby workforce account has the project owner's complete effective
-- access while remaining a Regular Agent in the visible workforce role model.
--
-- This migration intentionally does not hard-code an email address or Auth UUID.
-- It resolves exactly one existing profile using the approved Arby identity aliases
-- and aborts without changes if the match is missing or ambiguous.

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

do $$
declare
  v_candidate_count integer;
  v_candidate_names text;
begin
  select candidate_count, candidate_names
  into v_candidate_count, v_candidate_names
  from arby_access_resolution;

  if v_candidate_count <> 1 then
    raise exception
      'Arby full-access assignment requires exactly one profile; resolved % candidate(s): %',
      v_candidate_count,
      coalesce(v_candidate_names, 'none');
  end if;
end;
$$;

create temporary table arby_access_target on commit drop as
select candidate_ids[1] as user_id
from arby_access_resolution;

alter table arby_access_target add primary key (user_id);

-- Keep the visible workforce role as Regular Agent while activating the hidden
-- site-owner capability used by authorization checks throughout the application.
update public.profiles profile
set employment_status = 'active',
    base_role = 'agent',
    is_agent = true,
    is_system_admin = true,
    can_edit_articles = true,
    can_manage_payroll = true,
    timezone = 'Asia/Manila',
    updated_at = now()
from arby_access_target target
where profile.user_id = target.user_id;

-- Preserve compatibility with older pages and Cloudflare Functions that still
-- consult public.login.is_admin and public.login.can_edit_articles.
update public.login login_user
set is_admin = true,
    can_edit_articles = true,
    name = coalesce(nullif(trim(login_user.name), ''), profile.full_name)
from arby_access_target target
join public.profiles profile on profile.user_id = target.user_id
where lower(login_user.email) = lower(profile.email);

-- Grant every current workforce capability explicitly. The hidden system-admin
-- flag supplies administrator scope, while these rows make each capability
-- independently visible to permission-aware pages and server functions.
with permission_keys(permission_key) as (
  values
    ('manage_employees'::text),
    ('manage_schedules'::text),
    ('view_team_attendance'::text),
    ('approve_leave'::text),
    ('view_workforce_reports'::text),
    ('edit_articles'::text),
    ('manage_payroll'::text)
)
insert into public.user_permissions (
  user_id,
  permission_key,
  is_granted,
  reason
)
select
  target.user_id,
  keys.permission_key,
  true,
  'Arby project-owner full-access assignment'
from arby_access_target target
cross join permission_keys keys
on conflict (user_id, permission_key) do update
set is_granted = true,
    reason = excluded.reason,
    updated_at = now();

insert into public.workforce_audit_logs (
  action,
  entity_type,
  after_data,
  reason
)
select
  'arby_full_access_assignment',
  'workforce_profile',
  jsonb_build_object(
    'user_id', profile.user_id,
    'visible_access_type', 'regular_agent',
    'effective_administrator', true,
    'is_agent', profile.is_agent,
    'is_system_admin', profile.is_system_admin,
    'permissions', jsonb_build_array(
      'manage_employees',
      'manage_schedules',
      'view_team_attendance',
      'approve_leave',
      'view_workforce_reports',
      'edit_articles',
      'manage_payroll'
    )
  ),
  'Aligned the Arby account with the project owner full-access policy'
from arby_access_target target
join public.profiles profile on profile.user_id = target.user_id;

-- Transactional deployment assertions. Any mismatch rolls back every change.
do $$
declare
  v_user_id uuid;
  v_permission_count integer;
begin
  select user_id into v_user_id from arby_access_target;

  if not exists (
    select 1
    from public.profiles profile
    where profile.user_id = v_user_id
      and profile.employment_status = 'active'
      and profile.base_role = 'agent'
      and profile.is_agent is true
      and profile.is_system_admin is true
      and profile.can_edit_articles is true
      and profile.can_manage_payroll is true
      and profile.timezone = 'Asia/Manila'
  ) then
    raise exception 'Arby profile did not receive the required full-access attributes.';
  end if;

  if not exists (
    select 1
    from public.profiles profile
    join public.login login_user on lower(login_user.email) = lower(profile.email)
    where profile.user_id = v_user_id
      and login_user.is_admin is true
      and login_user.can_edit_articles is true
  ) then
    raise exception 'Arby login compatibility did not receive administrator and article-editor access.';
  end if;

  select count(*)
  into v_permission_count
  from public.user_permissions permission
  where permission.user_id = v_user_id
    and permission.permission_key in (
      'manage_employees',
      'manage_schedules',
      'view_team_attendance',
      'approve_leave',
      'view_workforce_reports',
      'edit_articles',
      'manage_payroll'
    )
    and permission.is_granted is true;

  if v_permission_count <> 7 then
    raise exception 'Arby must have all seven workforce permissions; found %.', v_permission_count;
  end if;
end;
$$;

commit;
