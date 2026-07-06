-- Workforce central permission service verification
-- Run after 2026070605_workforce_permission_service.sql in the target project.

begin;

do $$
begin
  if to_regprocedure('public.workforce_get_current_access()') is null then
    raise exception 'workforce_get_current_access() is missing';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.workforce_get_current_access()',
    'EXECUTE'
  ) then
    raise exception 'authenticated cannot execute workforce_get_current_access()';
  end if;

  if has_function_privilege(
    'anon',
    'public.workforce_get_current_access()',
    'EXECUTE'
  ) then
    raise exception 'anon must not execute workforce_get_current_access()';
  end if;
end
$$;

do $$
begin
  if exists (
    select 1
    from public.login login_user
    join public.profiles profile
      on lower(profile.email) = lower(login_user.email)
    where login_user.is_admin is true
      and not exists (
        select 1
        from public.user_permissions permission
        where permission.user_id = profile.user_id
          and permission.permission_key = 'manage_employees'
          and permission.is_granted is true
      )
  ) then
    raise exception 'An existing administrator is missing manage_employees';
  end if;

  if exists (
    select 1
    from public.login login_user
    join public.profiles profile
      on lower(profile.email) = lower(login_user.email)
    where login_user.can_edit_articles is true
      and not exists (
        select 1
        from public.user_permissions permission
        where permission.user_id = profile.user_id
          and permission.permission_key = 'edit_articles'
          and permission.is_granted is true
      )
  ) then
    raise exception 'An existing article editor is missing edit_articles';
  end if;

  if exists (
    select 1
    from public.profiles profile
    where profile.base_role = 'admin'
      and profile.employment_status in ('active', 'on_leave')
      and not exists (
        select 1
        from public.login login_user
        where lower(login_user.email) = lower(profile.email)
          and login_user.is_admin is true
      )
  ) then
    raise exception 'An active workforce administrator is out of sync with public.login';
  end if;
end
$$;

select
  profile.email,
  profile.base_role,
  profile.is_agent,
  profile.employment_status,
  coalesce(permission.permission_key, 'no elevated permission') as permission_key,
  coalesce(permission.is_granted, false) as is_granted
from public.profiles profile
left join public.user_permissions permission
  on permission.user_id = profile.user_id
order by profile.email, permission.permission_key;

rollback;
