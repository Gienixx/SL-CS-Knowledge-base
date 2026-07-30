-- Read-only verification for first-sign-in onboarding.

do $$
begin
  if exists (
    select 1
    from pg_trigger
    where tgrelid = 'auth.users'::regclass
      and tgname = 'auth_user_activate_invited_profile'
      and not tgisinternal
  ) then
    raise exception 'Legacy password-only onboarding trigger still exists';
  end if;

  if not exists (
    select 1
    from pg_trigger
    where tgrelid = 'auth.users'::regclass
      and tgname = 'auth_user_complete_invited_profile'
      and not tgisinternal
  ) then
    raise exception 'First-sign-in onboarding trigger is missing';
  end if;

  if exists (
    select 1
    from public.profiles profile
    join auth.users auth_user
      on auth_user.id = profile.user_id
    where profile.account_deleted_at is null
      and profile.employment_status in ('active', 'on_leave')
      and (
        profile.onboarding_status = 'active'
      ) is distinct from (
        auth_user.last_sign_in_at is not null
        and nullif(auth_user.encrypted_password, '') is not null
      )
  ) then
    raise exception 'Workforce onboarding status does not match Auth evidence';
  end if;

  if has_function_privilege(
    'anon',
    'private.workforce_complete_profile_after_user_password_created()',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'private.workforce_complete_profile_after_user_password_created()',
    'EXECUTE'
  ) then
    raise exception 'Browser roles can execute the private onboarding trigger function';
  end if;
end
$$;

select
  profile.user_id,
  profile.full_name,
  profile.email,
  profile.onboarding_status,
  auth_user.last_sign_in_at,
  nullif(auth_user.encrypted_password, '') is not null as has_password
from public.profiles profile
join auth.users auth_user
  on auth_user.id = profile.user_id
where profile.account_deleted_at is null
  and profile.employment_status in ('active', 'on_leave')
order by profile.full_name;
