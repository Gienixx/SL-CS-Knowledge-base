-- Workforce identity links
--
-- Repairs legacy cases where a Supabase Auth account and the workforce profile
-- representing the same person use different UUIDs. The link is explicit and
-- auditable; self-service RLS never falls back to unrestricted name matching.

begin;

create table if not exists public.workforce_identity_links (
  auth_user_id uuid not null,
  profile_user_id uuid not null references public.profiles(user_id) on delete cascade,
  match_method text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (auth_user_id, profile_user_id),
  constraint workforce_identity_links_match_method_check check (
    match_method in (
      'auth_user_id',
      'exact_email',
      'unique_name_alias',
      'manual'
    )
  )
);

create index if not exists workforce_identity_links_profile_idx
  on public.workforce_identity_links (profile_user_id, is_active);

alter table public.workforce_identity_links enable row level security;
revoke all on table public.workforce_identity_links from anon;
revoke all on table public.workforce_identity_links from authenticated;

-- Exact Auth UUID and exact-email links are always safe.
insert into public.workforce_identity_links (
  auth_user_id,
  profile_user_id,
  match_method,
  is_active
)
select
  auth_user.id,
  profile.user_id,
  case
    when profile.user_id = auth_user.id then 'auth_user_id'
    else 'exact_email'
  end,
  true
from auth.users auth_user
join public.profiles profile
  on profile.user_id = auth_user.id
  or lower(trim(profile.email)) = lower(trim(auth_user.email))
where nullif(trim(auth_user.email), '') is not null
on conflict (auth_user_id, profile_user_id) do update
set match_method = excluded.match_method,
    is_active = true,
    updated_at = now();

-- Legacy aliases are linked only when the Auth email local-part is unique among
-- Auth users. This safely covers old dummy/test and renamed workforce profiles
-- without turning arbitrary duplicate names into shared identities.
with auth_identity as (
  select
    auth_user.id as auth_user_id,
    lower(trim(auth_user.email)) as auth_email,
    lower(split_part(trim(auth_user.email), '@', 1)) as auth_local_part,
    lower(trim(coalesce(
      nullif(login_user.name, ''),
      nullif(auth_user.raw_user_meta_data ->> 'name', ''),
      split_part(auth_user.email, '@', 1)
    ))) as identity_name,
    count(*) over (
      partition by lower(split_part(trim(auth_user.email), '@', 1))
    ) as local_part_auth_count
  from auth.users auth_user
  left join lateral (
    select trim(login_row.name) as name
    from public.login login_row
    where lower(trim(login_row.email)) = lower(trim(auth_user.email))
    limit 1
  ) login_user on true
  where nullif(trim(auth_user.email), '') is not null
), safe_aliases as (
  select distinct
    identity.auth_user_id,
    profile.user_id as profile_user_id
  from auth_identity identity
  join public.profiles profile
    on profile.user_id <> identity.auth_user_id
   and (
     lower(trim(profile.full_name)) = identity.identity_name
     or lower(trim(profile.full_name)) = identity.auth_local_part
     or lower(split_part(trim(profile.email), '@', 1)) = identity.auth_local_part
   )
  where identity.local_part_auth_count = 1
)
insert into public.workforce_identity_links (
  auth_user_id,
  profile_user_id,
  match_method,
  is_active
)
select
  alias.auth_user_id,
  alias.profile_user_id,
  'unique_name_alias',
  true
from safe_aliases alias
on conflict (auth_user_id, profile_user_id) do update
set is_active = true,
    updated_at = now();

create or replace function public.workforce_is_current_identity(
  p_target_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
    and p_target_user_id is not null
    and (
      p_target_user_id = auth.uid()
      or exists (
        select 1
        from public.workforce_identity_links identity_link
        where identity_link.auth_user_id = auth.uid()
          and identity_link.profile_user_id = p_target_user_id
          and identity_link.is_active is true
      )
    );
$$;

revoke execute on function public.workforce_is_current_identity(uuid) from anon;
revoke all on function public.workforce_is_current_identity(uuid) from public;
grant execute on function public.workforce_is_current_identity(uuid) to authenticated;

create or replace function public.workforce_current_user_is_active()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles profile
    where public.workforce_is_current_identity(profile.user_id)
      and profile.employment_status in ('active', 'on_leave')
  );
$$;

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
        where public.workforce_is_current_identity(profile.user_id)
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

create or replace function public.workforce_has_permission(p_permission_key text)
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
        from public.user_permissions permission
        where public.workforce_is_current_identity(permission.user_id)
          and permission.permission_key = p_permission_key
          and permission.is_granted is true
      )
      or (
        p_permission_key in (
          'manage_employees',
          'manage_schedules',
          'view_team_attendance',
          'approve_leave',
          'view_workforce_reports'
        )
        and public.workforce_is_admin()
      )
    );
$$;

create or replace function public.workforce_is_assigned_supervisor(
  p_target_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles target
    left join public.teams team on team.id = target.team_id
    where target.user_id = p_target_user_id
      and (
        public.workforce_is_current_identity(target.supervisor_id)
        or public.workforce_is_current_identity(team.supervisor_id)
      )
  );
$$;

create or replace function public.workforce_can_manage_user(
  p_target_user_id uuid,
  p_permission_key text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.workforce_has_permission(p_permission_key)
    and (
      public.workforce_is_admin()
      or public.workforce_is_assigned_supervisor(p_target_user_id)
    );
$$;

create or replace function public.workforce_can_view_user(
  p_target_user_id uuid,
  p_permission_key text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.workforce_is_current_identity(p_target_user_id)
    or public.workforce_can_manage_user(p_target_user_id, p_permission_key);
$$;

revoke all on function public.workforce_current_user_is_active() from public;
revoke all on function public.workforce_is_admin() from public;
revoke all on function public.workforce_has_permission(text) from public;
revoke all on function public.workforce_is_assigned_supervisor(uuid) from public;
revoke all on function public.workforce_can_manage_user(uuid, text) from public;
revoke all on function public.workforce_can_view_user(uuid, text) from public;

grant execute on function public.workforce_current_user_is_active() to authenticated;
grant execute on function public.workforce_is_admin() to authenticated;
grant execute on function public.workforce_has_permission(text) to authenticated;
grant execute on function public.workforce_is_assigned_supervisor(uuid) to authenticated;
grant execute on function public.workforce_can_manage_user(uuid, text) to authenticated;
grant execute on function public.workforce_can_view_user(uuid, text) to authenticated;

-- Newly provisioned users receive an exact identity link after the existing
-- login-to-profile synchronization trigger has created or updated the profile.
create or replace function public.workforce_sync_identity_link_from_login()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_auth_user_id uuid;
  v_profile_user_id uuid;
begin
  if tg_op = 'DELETE' then
    return old;
  end if;

  select auth_user.id
  into v_auth_user_id
  from auth.users auth_user
  where lower(trim(auth_user.email)) = lower(trim(new.email))
  limit 1;

  select profile.user_id
  into v_profile_user_id
  from public.profiles profile
  where lower(trim(profile.email)) = lower(trim(new.email))
  limit 1;

  if v_auth_user_id is not null and v_profile_user_id is not null then
    insert into public.workforce_identity_links (
      auth_user_id,
      profile_user_id,
      match_method,
      is_active
    ) values (
      v_auth_user_id,
      v_profile_user_id,
      case
        when v_auth_user_id = v_profile_user_id then 'auth_user_id'
        else 'exact_email'
      end,
      true
    )
    on conflict (auth_user_id, profile_user_id) do update
    set match_method = excluded.match_method,
        is_active = true,
        updated_at = now();
  end if;

  return new;
end;
$$;

drop trigger if exists zz_login_workforce_identity_link on public.login;
create trigger zz_login_workforce_identity_link
after insert or update of email on public.login
for each row execute function public.workforce_sync_identity_link_from_login();

-- Expose linked profiles to the owning Auth account. Other profile visibility
-- remains controlled by the existing management permissions.
drop policy if exists "Users can view permitted workforce profiles" on public.profiles;
create policy "Users can view permitted workforce profiles"
on public.profiles
for select
to authenticated
using (
  public.workforce_is_current_identity(user_id)
  or public.workforce_can_manage_user(user_id, 'manage_employees')
  or public.workforce_can_manage_user(user_id, 'manage_schedules')
  or public.workforce_can_manage_user(user_id, 'view_team_attendance')
  or public.workforce_can_manage_user(user_id, 'approve_leave')
  or public.workforce_can_manage_user(user_id, 'view_workforce_reports')
);

drop policy if exists "Users can view their own permissions" on public.user_permissions;
create policy "Users can view their own permissions"
on public.user_permissions
for select
to authenticated
using (
  public.workforce_is_current_identity(user_id)
  or (
    public.workforce_is_admin()
    and public.workforce_has_permission('manage_employees')
  )
);

-- Work-schedule policy already calls workforce_can_view_user; recreating it makes
-- the linked-identity dependency explicit in the deployed schema.
drop policy if exists "Users can view permitted work schedules" on public.work_schedules;
create policy "Users can view permitted work schedules"
on public.work_schedules
for select
to authenticated
using (public.workforce_can_view_user(user_id, 'manage_schedules'));

drop policy if exists "Users can view permitted attendance" on public.attendance;
create policy "Users can view permitted attendance"
on public.attendance
for select
to authenticated
using (
  public.workforce_is_current_identity(user_id)
  or public.workforce_can_manage_user(user_id, 'view_team_attendance')
  or public.workforce_can_manage_user(user_id, 'manage_schedules')
);

-- Update access payload with auditable linked profile IDs. The primary displayed
-- profile still prefers the exact Auth UUID when available.
create or replace function public.workforce_get_current_access()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_auth_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_is_active boolean;
  v_permissions jsonb;
  v_linked_profile_ids jsonb := '[]'::jsonb;
  v_legacy_is_admin boolean := false;
  v_legacy_can_edit boolean := false;
begin
  if v_auth_user_id is null then
    return null;
  end if;

  select profile.*
  into v_profile
  from public.profiles profile
  where public.workforce_is_current_identity(profile.user_id)
  order by
    (profile.user_id = v_auth_user_id) desc,
    (lower(profile.email) = lower(coalesce(auth.jwt() ->> 'email', ''))) desc,
    profile.created_at asc
  limit 1;

  if not found then
    return null;
  end if;

  v_is_active := public.workforce_current_user_is_active();

  select coalesce(jsonb_agg(profile.user_id order by profile.created_at), '[]'::jsonb)
  into v_linked_profile_ids
  from public.profiles profile
  where public.workforce_is_current_identity(profile.user_id);

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
  from public.user_permissions permission
  where public.workforce_is_current_identity(permission.user_id);

  select
    coalesce((
      select login_user.is_admin
      from public.login login_user
      where lower(login_user.email) = lower(coalesce(auth.jwt() ->> 'email', v_profile.email))
      limit 1
    ), false),
    coalesce((
      select login_user.can_edit_articles
      from public.login login_user
      where lower(login_user.email) = lower(coalesce(auth.jwt() ->> 'email', v_profile.email))
      limit 1
    ), false)
  into v_legacy_is_admin, v_legacy_can_edit;

  return jsonb_build_object(
    'auth_user_id', v_auth_user_id,
    'user_id', v_profile.user_id,
    'linked_profile_ids', v_linked_profile_ids,
    'full_name', v_profile.full_name,
    'email', lower(coalesce(auth.jwt() ->> 'email', v_profile.email)),
    'employee_id', v_profile.employee_id,
    'employment_status', v_profile.employment_status,
    'is_active', v_is_active,
    'base_role', v_profile.base_role,
    'is_admin', public.workforce_is_admin(),
    'is_system_admin', exists (
      select 1
      from public.profiles linked_profile
      where public.workforce_is_current_identity(linked_profile.user_id)
        and linked_profile.is_system_admin is true
        and linked_profile.employment_status in ('active', 'on_leave')
    ),
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

insert into public.workforce_audit_logs (
  action,
  entity_type,
  after_data,
  reason
)
select
  'workforce_identity_links_backfilled',
  'workforce_identity_links',
  jsonb_build_object(
    'link_count', count(*),
    'multi_profile_auth_accounts', count(distinct auth_user_id) filter (
      where auth_user_id in (
        select auth_user_id
        from public.workforce_identity_links
        where is_active is true
        group by auth_user_id
        having count(*) > 1
      )
    )
  ),
  'Backfilled explicit Auth-to-workforce-profile identity links for self-service access'
from public.workforce_identity_links
where is_active is true;

commit;
