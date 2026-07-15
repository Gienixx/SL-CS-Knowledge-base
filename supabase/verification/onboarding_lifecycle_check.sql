-- Step 2 verification: onboarding lifecycle and workforce access gate.

do $$
declare
  v_profile_count integer;
  v_active_count integer;
begin
  select count(*) into v_profile_count from public.profiles;
  select count(*) into v_active_count
  from public.profiles
  where onboarding_status = 'active'
    and activated_at is not null;

  if v_profile_count <> v_active_count then
    raise exception 'Expected all existing profiles to remain active; profiles %, active %.',
      v_profile_count, v_active_count;
  end if;

  if exists (
    select 1
    from public.profiles
    where onboarding_status not in ('invited', 'active')
  ) then
    raise exception 'Invalid onboarding status found.';
  end if;

  if position(
    'profile.onboarding_status = ''active'''
    in pg_get_functiondef('public.workforce_current_user_is_active()'::regprocedure)
  ) = 0 then
    raise exception 'The shared workforce access gate does not require onboarding activation.';
  end if;
end
$$;

select
  count(*) as profile_count,
  count(*) filter (where onboarding_status = 'active') as active_profiles,
  count(*) filter (where onboarding_status = 'invited') as invited_profiles,
  count(*) filter (where activated_at is not null) as profiles_with_activation_time
from public.profiles;
