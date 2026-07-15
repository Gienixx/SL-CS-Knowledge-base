begin;

create or replace function public.current_user_can_edit_articles()
returns boolean
language sql
stable
security definer
set search_path = public, auth, pg_temp
as $$
  select exists (
    select 1
    from public.workforce_identity_links identity_link
    join public.profiles profile
      on profile.user_id = identity_link.profile_user_id
    join public.user_permissions permission
      on permission.user_id = profile.user_id
     and permission.permission_key = 'edit_articles'
     and permission.is_granted is true
    where identity_link.auth_user_id = auth.uid()
      and identity_link.is_active is true
      and profile.onboarding_status = 'active'
      and profile.employment_status in ('active', 'on_leave')
      and profile.account_deleted_at is null
  );
$$;

revoke all on function public.current_user_can_edit_articles() from public, anon;
grant execute on function public.current_user_can_edit_articles() to authenticated, service_role;

comment on function public.current_user_can_edit_articles() is
  'Canonical article authorization: active linked workforce profile with an explicit edit_articles grant.';

drop policy if exists "Editors can insert articles" on public.articles;
create policy "Editors can insert articles"
  on public.articles for insert to authenticated
  with check (public.current_user_can_edit_articles());

insert into public.workforce_audit_logs (action, entity_type, after_data, reason)
values (
  'canonical_article_authorization_enabled',
  'user_permissions',
  jsonb_build_object(
    'permission_key', 'edit_articles',
    'legacy_login_authorization_removed', true,
    'compatibility_mirror_retained', true
  ),
  'Article policies and clients now authorize through user_permissions.edit_articles'
);

commit;
