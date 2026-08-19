-- Compatibility login rows must update the stable workforce profile linked to
-- the Auth user. Reinvited deleted employees intentionally receive a new Auth
-- UUID while retaining their original workforce/profile UUID and history.
create or replace function public.workforce_sync_login_record()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_auth_user_id uuid;
  v_profile_user_id uuid;
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

  select auth_user.id
  into v_auth_user_id
  from auth.users auth_user
  where lower(auth_user.email) = v_email
  limit 1;

  if v_auth_user_id is not null then
    select identity_link.profile_user_id
    into v_profile_user_id
    from public.workforce_identity_links identity_link
    where identity_link.auth_user_id = v_auth_user_id
      and identity_link.is_active is true
    order by
      (identity_link.profile_user_id = v_auth_user_id) desc,
      identity_link.updated_at desc
    limit 1;

    v_profile_user_id := coalesce(v_profile_user_id, v_auth_user_id);
  elsif tg_op = 'UPDATE' then
    select profile.user_id
    into v_profile_user_id
    from public.profiles profile
    where lower(profile.email) in (lower(old.email), v_email)
    limit 1;
  end if;

  if v_profile_user_id is null then
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
    v_profile_user_id,
    v_name,
    v_email,
    'SL-' || upper(substr(replace(v_profile_user_id::text, '-', ''), 1, 8)),
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
      v_profile_user_id,
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
    v_profile_user_id,
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

comment on function public.workforce_sync_login_record() is
  'Synchronizes compatibility login rows to the stable workforce profile, resolving replacement Auth identities through active workforce identity links.';
