begin;

alter table public.user_permissions
  drop constraint user_permissions_permission_key_check;

alter table public.user_permissions
  add constraint user_permissions_permission_key_check check (
    permission_key = any (array[
      'manage_employees'::text,
      'manage_schedules'::text,
      'view_team_attendance'::text,
      'correct_attendance'::text,
      'approve_attendance'::text,
      'approve_leave'::text,
      'view_workforce_reports'::text,
      'manage_announcements'::text,
      'edit_articles'::text,
      'manage_payroll'::text
    ])
  );

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
    'correct_attendance',
      v_is_active and coalesce(bool_or(permission_key = 'correct_attendance' and is_granted), false),
    'approve_attendance',
      v_is_active and coalesce(bool_or(permission_key = 'approve_attendance' and is_granted), false),
    'approve_leave',
      v_is_active and coalesce(bool_or(permission_key = 'approve_leave' and is_granted), false),
    'view_workforce_reports',
      v_is_active and coalesce(bool_or(permission_key = 'view_workforce_reports' and is_granted), false),
    'manage_announcements',
      v_is_active and coalesce(bool_or(permission_key = 'manage_announcements' and is_granted), false),
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
    'can_manage_announcements', coalesce((v_permissions ->> 'manage_announcements')::boolean, false),
    'can_manage_payroll', coalesce((v_permissions ->> 'manage_payroll')::boolean, false),
    'can_correct_attendance', coalesce((v_permissions ->> 'correct_attendance')::boolean, false),
    'can_approve_attendance', coalesce((v_permissions ->> 'approve_attendance')::boolean, false),
    'legacy', jsonb_build_object(
      'is_admin', v_legacy_is_admin,
      'can_edit_articles', v_legacy_can_edit
    )
  );
end;
$$;

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
  v_bridge_access_type text;
  v_result jsonb;
  v_manage_announcements boolean;
begin
  if auth.uid() is null
     or not public.workforce_is_admin()
     or not public.workforce_has_permission('manage_employees') then
    raise exception 'You do not have permission to manage employees.' using errcode = '42501';
  end if;

  if p_access_type not in ('admin', 'regular_agent', 'admin_agent') then
    raise exception 'Invalid access type. Use Admin, Regular Agent, or Admin and Agent.';
  end if;

  v_bridge_access_type := case
    when p_access_type = 'regular_agent'
      and coalesce((p_permissions ->> 'edit_articles')::boolean, false)
      then 'agent_editor'
    else p_access_type
  end;

  v_result := public.workforce_admin_save_employee_legacy_access_bridge(
    p_user_id,
    p_full_name,
    p_employee_id,
    p_employment_status,
    v_bridge_access_type,
    p_team_id,
    p_supervisor_id,
    p_timezone,
    p_permissions,
    p_reason
  );

  if exists (
    select 1
    from public.profiles profile
    where profile.user_id = p_user_id
      and profile.is_system_admin is true
  ) then
    v_manage_announcements := true;
  elsif p_permissions ? 'manage_announcements' then
    v_manage_announcements := coalesce(
      (p_permissions ->> 'manage_announcements')::boolean,
      false
    );
  else
    select permission.is_granted
    into v_manage_announcements
    from public.user_permissions permission
    where permission.user_id = p_user_id
      and permission.permission_key = 'manage_announcements';

    v_manage_announcements := coalesce(v_manage_announcements, false);
  end if;

  insert into public.user_permissions (
    user_id,
    permission_key,
    is_granted,
    granted_by,
    reason
  ) values (
    p_user_id,
    'manage_announcements',
    v_manage_announcements,
    auth.uid(),
    coalesce(nullif(trim(coalesce(p_reason, '')), ''), 'Updated through workforce employee administration')
  )
  on conflict (user_id, permission_key) do update
  set is_granted = excluded.is_granted,
      granted_by = excluded.granted_by,
      reason = excluded.reason,
      updated_at = now();

  v_result := jsonb_set(
    v_result,
    '{permissions,manage_announcements}',
    to_jsonb(v_manage_announcements),
    true
  );

  return jsonb_set(v_result, '{access_type}', to_jsonb(p_access_type), true);
end;
$$;

revoke all on function public.workforce_admin_save_employee(
  uuid, text, text, text, text, uuid, uuid, text, jsonb, text
) from public, anon;
grant execute on function public.workforce_admin_save_employee(
  uuid, text, text, text, text, uuid, uuid, text, jsonb, text
) to authenticated;

create or replace function public.workforce_service_create_invitation(
  p_actor_auth_user_id uuid,
  p_auth_user_id uuid,
  p_full_name text,
  p_email text,
  p_access_type text,
  p_permissions jsonb default '{}'::jsonb,
  p_team_id uuid default null,
  p_supervisor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_actor_profile public.profiles%rowtype;
  v_base_role text;
  v_is_agent boolean;
  v_employee_id text;
  v_permission_key text;
  v_is_granted boolean;
  v_normalized_name text := nullif(trim(p_full_name), '');
  v_normalized_email text := lower(nullif(trim(p_email), ''));
begin
  select profile.*
  into v_actor_profile
  from public.workforce_identity_links identity_link
  join public.profiles profile on profile.user_id = identity_link.profile_user_id
  where identity_link.auth_user_id = p_actor_auth_user_id
    and identity_link.is_active is true
    and profile.employment_status in ('active', 'on_leave')
    and profile.onboarding_status = 'active'
  order by (profile.user_id = p_actor_auth_user_id) desc
  limit 1;

  if v_actor_profile.user_id is null
     or not (
       v_actor_profile.is_system_admin is true
       or (
         v_actor_profile.base_role = 'admin'
         and exists (
           select 1 from public.user_permissions permission
           where permission.user_id = v_actor_profile.user_id
             and permission.permission_key = 'manage_employees'
             and permission.is_granted is true
         )
       )
     ) then
    raise exception 'You do not have permission to invite employees.' using errcode = '42501';
  end if;

  if v_normalized_name is null or length(v_normalized_name) > 160 then
    raise exception 'A valid full name is required.';
  end if;
  if v_normalized_email is null
     or length(v_normalized_email) > 320
     or v_normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'A valid email address is required.';
  end if;
  if p_access_type not in ('admin', 'regular_agent', 'admin_agent') then
    raise exception 'Invalid access type. Use Admin, Regular Agent, or Admin and Agent.';
  end if;
  if p_auth_user_id is null or not exists (
    select 1 from auth.users auth_user
    where auth_user.id = p_auth_user_id
      and lower(auth_user.email) = v_normalized_email
  ) then
    raise exception 'The invited Auth account does not match the requested email.';
  end if;
  if exists (select 1 from public.profiles where lower(email) = v_normalized_email)
     or exists (select 1 from public.login where lower(email) = v_normalized_email) then
    raise exception 'An employee with this email address already exists.' using errcode = '23505';
  end if;
  if p_team_id is not null and not exists (
    select 1 from public.teams where id = p_team_id and is_active is true
  ) then
    raise exception 'Selected team does not exist or is inactive.';
  end if;
  if p_supervisor_id is not null and not exists (
    select 1 from public.profiles
    where user_id = p_supervisor_id
      and employment_status in ('active', 'on_leave')
      and onboarding_status = 'active'
  ) then
    raise exception 'Selected supervisor is not an active workforce user.';
  end if;

  v_base_role := case when p_access_type in ('admin', 'admin_agent') then 'admin' else 'agent' end;
  v_is_agent := p_access_type in ('regular_agent', 'admin_agent');
  v_employee_id := 'SL-' || upper(substr(replace(p_auth_user_id::text, '-', ''), 1, 8));

  insert into public.profiles (
    user_id, full_name, email, employee_id, employment_status, base_role,
    is_agent, is_system_admin, team_id, supervisor_id, can_edit_articles,
    can_manage_payroll, onboarding_status, invited_at, invited_by,
    invitation_last_sent_at
  ) values (
    p_auth_user_id, v_normalized_name, v_normalized_email, v_employee_id,
    'active', v_base_role, v_is_agent, false, p_team_id, p_supervisor_id,
    coalesce((p_permissions ->> 'edit_articles')::boolean, false),
    coalesce((p_permissions ->> 'manage_payroll')::boolean, false),
    'invited', now(), v_actor_profile.user_id, now()
  );

  insert into public.login (name, email, is_admin, can_edit_articles)
  values (
    v_normalized_name, v_normalized_email, v_base_role = 'admin',
    coalesce((p_permissions ->> 'edit_articles')::boolean, false)
  );

  foreach v_permission_key in array array[
    'manage_employees', 'manage_schedules', 'view_team_attendance',
    'correct_attendance', 'approve_attendance', 'approve_leave',
    'view_workforce_reports', 'manage_announcements', 'edit_articles',
    'manage_payroll'
  ] loop
    v_is_granted := coalesce((p_permissions ->> v_permission_key)::boolean, false);
    insert into public.user_permissions (
      user_id, permission_key, is_granted, granted_by, reason
    ) values (
      p_auth_user_id, v_permission_key, v_is_granted, v_actor_profile.user_id,
      'Initial grant from unified invitation service'
    )
    on conflict (user_id, permission_key) do update
    set is_granted = excluded.is_granted,
        granted_by = excluded.granted_by,
        reason = excluded.reason,
        updated_at = now();
  end loop;

  insert into public.workforce_identity_links (
    auth_user_id, profile_user_id, match_method, is_active
  ) values (p_auth_user_id, p_auth_user_id, 'auth_user_id', true)
  on conflict (auth_user_id, profile_user_id) do update
  set match_method = excluded.match_method, is_active = true, updated_at = now();

  insert into public.workforce_audit_logs (
    actor_user_id, action, entity_type, entity_id, after_data, reason
  ) values (
    v_actor_profile.user_id, 'employee_invited', 'profiles', p_auth_user_id,
    jsonb_build_object(
      'employee_id', v_employee_id,
      'email', v_normalized_email,
      'access_type', p_access_type,
      'onboarding_status', 'invited',
      'permissions', p_permissions
    ),
    'Created through unified invitation service'
  );

  return jsonb_build_object(
    'user_id', p_auth_user_id,
    'employee_id', v_employee_id,
    'full_name', v_normalized_name,
    'email', v_normalized_email,
    'access_type', p_access_type,
    'onboarding_status', 'invited'
  );
end;
$$;

revoke all on function public.workforce_service_create_invitation(
  uuid, uuid, text, text, text, jsonb, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.workforce_service_create_invitation(
  uuid, uuid, text, text, text, jsonb, uuid, uuid
) to service_role;

drop policy if exists "Workforce users can view published announcements"
on public.team_announcements;
drop policy if exists "Workforce admins can create announcements"
on public.team_announcements;
drop policy if exists "Workforce admins can update announcements"
on public.team_announcements;
drop policy if exists "Workforce admins can delete announcements"
on public.team_announcements;

create policy "Workforce users can view announcements"
on public.team_announcements
for select
to authenticated
using (
  public.workforce_current_user_is_active()
  and (
    status = 'published'
    or public.workforce_is_admin()
    or public.workforce_has_permission('manage_announcements')
  )
);

create policy "Announcement managers can create announcements"
on public.team_announcements
for insert
to authenticated
with check (
  public.workforce_current_user_is_active()
  and (
    public.workforce_is_admin()
    or public.workforce_has_permission('manage_announcements')
  )
  and public.workforce_is_current_identity(created_by)
);

create policy "Announcement managers can update announcements"
on public.team_announcements
for update
to authenticated
using (
  public.workforce_current_user_is_active()
  and (
    public.workforce_is_admin()
    or public.workforce_has_permission('manage_announcements')
  )
)
with check (
  public.workforce_current_user_is_active()
  and (
    public.workforce_is_admin()
    or public.workforce_has_permission('manage_announcements')
  )
);

create policy "Announcement managers can delete announcements"
on public.team_announcements
for delete
to authenticated
using (
  public.workforce_current_user_is_active()
  and (
    public.workforce_is_admin()
    or public.workforce_has_permission('manage_announcements')
  )
);

comment on constraint user_permissions_permission_key_check
on public.user_permissions is
  'Canonical workforce permissions, including scoped announcement management.';

commit;
