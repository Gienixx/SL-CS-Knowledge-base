-- Verify that deleted workforce accounts preserve history without reserving
-- reusable email addresses.

select
  count(*) filter (
    where profile.email <> (
      'deleted-' || replace(profile.user_id::text, '-', '') || '@deleted.invalid'
    )
  ) as deleted_profiles_with_real_email_should_be_zero,
  count(*) filter (
    where exists (
      select 1
      from public.login login_row
      where lower(login_row.email) = lower(profile.email)
    )
  ) as deleted_profiles_with_login_row_should_be_zero,
  count(*) filter (
    where exists (
      select 1
      from public.workforce_identity_links identity_link
      where identity_link.profile_user_id = profile.user_id
        and identity_link.is_active is true
    )
  ) as deleted_profiles_with_active_identity_should_be_zero
from public.profiles profile
where profile.account_deleted_at is not null;

select
  p.proname,
  has_function_privilege(
    'anon',
    p.oid,
    'execute'
  ) as anon_execute_should_be_false,
  has_function_privilege(
    'authenticated',
    p.oid,
    'execute'
  ) as authenticated_execute_should_be_true
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.oid = 'public.workforce_admin_change_employee_lifecycle(uuid,text,text)'::regprocedure;
