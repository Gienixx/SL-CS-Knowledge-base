do $$
begin
  if has_function_privilege('anon', 'public.current_user_can_edit_articles()', 'EXECUTE') then
    raise exception 'Anonymous users can execute the article authorization function';
  end if;
  if not has_function_privilege('authenticated', 'public.current_user_can_edit_articles()', 'EXECUTE') then
    raise exception 'Authenticated users cannot execute the article authorization function';
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'articles'
      and cmd in ('INSERT', 'UPDATE', 'DELETE')
      and coalesce(qual, '') || coalesce(with_check, '') not like '%current_user_can_edit_articles%'
  ) then
    raise exception 'An article write policy bypasses canonical editor authorization';
  end if;
end $$;

select
  count(*) filter (where login_editor is distinct from permission_editor) as compatibility_mismatches,
  count(*) filter (where permission_editor and not is_active) as inactive_editor_grants
from (
  select
    login_user.can_edit_articles as login_editor,
    coalesce(permission.is_granted, false) as permission_editor,
    profile.onboarding_status = 'active'
      and profile.employment_status in ('active', 'on_leave')
      and profile.account_deleted_at is null as is_active
  from public.profiles profile
  join public.login login_user on lower(login_user.email) = lower(profile.email)
  left join public.user_permissions permission
    on permission.user_id = profile.user_id
   and permission.permission_key = 'edit_articles'
) parity;
