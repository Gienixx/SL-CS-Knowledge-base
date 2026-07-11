-- Phase 1, Step 11: attendance correction and approval permissions.
--
-- Adds explicit, independently assignable permissions for payroll-sensitive
-- attendance changes. Supervisor access remains view-only, base admin status does
-- not implicitly grant correction rights, and manage_payroll remains unrelated.

begin;

alter table public.user_permissions
  drop constraint if exists user_permissions_permission_key_check;

alter table public.user_permissions
  add constraint user_permissions_permission_key_check check (
    permission_key in (
      'manage_employees',
      'manage_schedules',
      'view_team_attendance',
      'correct_attendance',
      'approve_attendance',
      'approve_leave',
      'view_workforce_reports',
      'edit_articles',
      'manage_payroll'
    )
  );

-- System administrators retain complete workforce access. Ordinary admins must
-- receive these permissions explicitly through employee administration.
insert into public.user_permissions (
  user_id,
  permission_key,
  is_granted,
  granted_by,
  reason
)
select
  profile.user_id,
  permission.permission_key,
  true,
  auth.uid(),
  'System administrator attendance permission backfill'
from public.profiles profile
cross join (
  values ('correct_attendance'::text), ('approve_attendance'::text)
) as permission(permission_key)
where profile.is_system_admin is true
on conflict (user_id, permission_key) do update
set is_granted = true,
    granted_by = coalesce(excluded.granted_by, public.user_permissions.granted_by),
    reason = excluded.reason,
    updated_at = now();

create or replace function public.workforce_is_authorized_attendance_admin(
  p_permission_key text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_permission_key in ('correct_attendance', 'approve_attendance')
    and public.workforce_current_user_is_active()
    and public.workforce_is_admin()
    and public.workforce_has_permission(p_permission_key);
$$;

comment on function public.workforce_is_authorized_attendance_admin(text) is
  'Returns true only for an active admin with the requested explicit attendance permission.';

create or replace function public.workforce_can_correct_attendance(
  p_target_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_target_user_id is not null
    and exists (
      select 1
      from public.profiles target
      where target.user_id = p_target_user_id
    )
    and public.workforce_is_authorized_attendance_admin('correct_attendance');
$$;

comment on function public.workforce_can_correct_attendance(uuid) is
  'Authorizes attendance correction only for explicitly permitted administrators; supervisor scope alone is insufficient.';

create or replace function public.workforce_can_approve_attendance(
  p_target_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_target_user_id is not null
    and exists (
      select 1
      from public.profiles target
      where target.user_id = p_target_user_id
    )
    and public.workforce_is_authorized_attendance_admin('approve_attendance');
$$;

comment on function public.workforce_can_approve_attendance(uuid) is
  'Authorizes attendance approval only for explicitly permitted administrators; payroll access does not imply approval.';

revoke all on function public.workforce_is_authorized_attendance_admin(text) from public;
revoke all on function public.workforce_is_authorized_attendance_admin(text) from anon;
revoke all on function public.workforce_is_authorized_attendance_admin(text) from authenticated;
grant execute on function public.workforce_is_authorized_attendance_admin(text) to authenticated;

revoke all on function public.workforce_can_correct_attendance(uuid) from public;
revoke all on function public.workforce_can_correct_attendance(uuid) from anon;
revoke all on function public.workforce_can_correct_attendance(uuid) from authenticated;
grant execute on function public.workforce_can_correct_attendance(uuid) to authenticated;

revoke all on function public.workforce_can_approve_attendance(uuid) from public;
revoke all on function public.workforce_can_approve_attendance(uuid) from anon;
revoke all on function public.workforce_can_approve_attendance(uuid) from authenticated;
grant execute on function public.workforce_can_approve_attendance(uuid) to authenticated;

-- Extend the shared access payload so all pages use the same permission state.
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
    'can_correct_attendance', coalesce((v_permissions ->> 'correct_attendance')::boolean, false),
    'can_approve_attendance', coalesce((v_permissions ->> 'approve_attendance')::boolean, false),
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

-- Extend the transactional employee editor. New attendance permissions are
-- preserved when older clients omit them and are forced off for non-admins.
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
  v_profile public.profiles%rowtype;
  v_base_role text;
  v_is_agent boolean;
  v_can_edit_articles boolean;
  v_can_manage_payroll boolean;
  v_permission_key text;
  v_is_granted boolean;
  v_existing_grant boolean;
  v_permissions jsonb := '{}'::jsonb;
  v_normalized_name text := nullif(trim(coalesce(p_full_name, '')), '');
  v_normalized_employee_id text := nullif(trim(coalesce(p_employee_id, '')), '');
  v_normalized_timezone text := coalesce(nullif(trim(coalesce(p_timezone, '')), ''), 'Asia/Manila');
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if auth.uid() is null
     or not public.workforce_is_admin()
     or not public.workforce_has_permission('manage_employees') then
    raise exception 'You do not have permission to manage employees.' using errcode = '42501';
  end if;

  if p_user_id is null then
    raise exception 'Employee user ID is required.';
  end if;

  select *
  into v_profile
  from public.profiles
  where user_id = p_user_id
  for update;

  if not found then
    raise exception 'Employee profile not found.';
  end if;

  if v_normalized_name is null then
    raise exception 'Full name is required.';
  end if;

  if v_normalized_employee_id is null then
    raise exception 'Employee ID is required.';
  end if;

  if p_employment_status not in ('active', 'on_leave', 'inactive', 'terminated') then
    raise exception 'Invalid employment status.';
  end if;

  case p_access_type
    when 'admin_agent' then
      v_base_role := 'admin';
      v_is_agent := true;
      v_can_edit_articles := coalesce((p_permissions ->> 'edit_articles')::boolean, false);
    when 'admin' then
      v_base_role := 'admin';
      v_is_agent := false;
      v_can_edit_articles := coalesce((p_permissions ->> 'edit_articles')::boolean, false);
    when 'agent_editor' then
      v_base_role := 'agent';
      v_is_agent := true;
      v_can_edit_articles := true;
    when 'regular_agent' then
      v_base_role := 'agent';
      v_is_agent := true;
      v_can_edit_articles := false;
    else
      raise exception 'Invalid access type.';
  end case;

  v_can_manage_payroll := coalesce((p_permissions ->> 'manage_payroll')::boolean, false);

  if p_team_id is not null and not exists (
    select 1 from public.teams team where team.id = p_team_id
  ) then
    raise exception 'Selected team does not exist.';
  end if;

  if p_supervisor_id = p_user_id then
    raise exception 'An employee cannot supervise their own profile.';
  end if;

  if p_supervisor_id is not null and not exists (
    select 1
    from public.profiles supervisor
    where supervisor.user_id = p_supervisor_id
      and supervisor.employment_status in ('active', 'on_leave')
  ) then
    raise exception 'Selected supervisor is not an active workforce user.';
  end if;

  if p_user_id = auth.uid() and (
    v_base_role <> 'admin'
    or coalesce((p_permissions ->> 'manage_employees')::boolean, false) is false
    or p_employment_status not in ('active', 'on_leave')
  ) then
    raise exception 'You cannot remove your own active administrator and employee-management access.';
  end if;

  update public.profiles
  set full_name = v_normalized_name,
      employee_id = v_normalized_employee_id,
      employment_status = p_employment_status,
      base_role = v_base_role,
      is_agent = v_is_agent,
      team_id = p_team_id,
      supervisor_id = p_supervisor_id,
      can_edit_articles = v_can_edit_articles,
      can_manage_payroll = v_can_manage_payroll,
      timezone = v_normalized_timezone,
      updated_at = now()
  where user_id = p_user_id
  returning * into v_profile;

  update public.login
  set name = v_profile.full_name,
      is_admin = v_profile.base_role = 'admin',
      can_edit_articles = v_can_edit_articles
  where lower(email) = lower(v_profile.email);

  foreach v_permission_key in array array[
    'manage_employees',
    'manage_schedules',
    'view_team_attendance',
    'correct_attendance',
    'approve_attendance',
    'approve_leave',
    'view_workforce_reports',
    'edit_articles',
    'manage_payroll'
  ] loop
    v_existing_grant := false;

    select permission.is_granted
    into v_existing_grant
    from public.user_permissions permission
    where permission.user_id = p_user_id
      and permission.permission_key = v_permission_key;

    if v_permission_key in ('correct_attendance', 'approve_attendance')
       and not (v_base_role = 'admin' or v_profile.is_system_admin is true) then
      v_is_granted := false;
    elsif v_profile.is_system_admin is true then
      v_is_granted := true;
    elsif v_permission_key = 'edit_articles' then
      v_is_granted := v_can_edit_articles;
    elsif v_permission_key = 'manage_payroll' then
      v_is_granted := v_can_manage_payroll;
    elsif p_permissions ? v_permission_key then
      v_is_granted := coalesce((p_permissions ->> v_permission_key)::boolean, false);
    else
      v_is_granted := coalesce(v_existing_grant, false);
    end if;

    insert into public.user_permissions (
      user_id,
      permission_key,
      is_granted,
      granted_by,
      reason
    ) values (
      p_user_id,
      v_permission_key,
      v_is_granted,
      auth.uid(),
      coalesce(v_reason, 'Updated through workforce employee administration')
    )
    on conflict (user_id, permission_key) do update
    set is_granted = excluded.is_granted,
        granted_by = excluded.granted_by,
        reason = excluded.reason,
        updated_at = now();

    v_permissions := v_permissions || jsonb_build_object(v_permission_key, v_is_granted);
  end loop;

  return jsonb_build_object(
    'profile', to_jsonb(v_profile),
    'permissions', v_permissions,
    'access_type', p_access_type
  );
end;
$$;

comment on function public.workforce_admin_save_employee(
  uuid, text, text, text, text, uuid, uuid, text, jsonb, text
) is 'Atomically updates an employee profile, explicit attendance permissions, other workforce permissions, and legacy compatibility fields.';

revoke execute on function public.workforce_admin_save_employee(
  uuid, text, text, text, text, uuid, uuid, text, jsonb, text
) from anon;
revoke all on function public.workforce_admin_save_employee(
  uuid, text, text, text, text, uuid, uuid, text, jsonb, text
) from public;
grant execute on function public.workforce_admin_save_employee(
  uuid, text, text, text, text, uuid, uuid, text, jsonb, text
) to authenticated;

insert into public.workforce_audit_logs (
  actor_user_id,
  action,
  entity_type,
  after_data,
  reason
) values (
  auth.uid(),
  'attendance_permissions_added',
  'user_permissions',
  jsonb_build_object(
    'permissions', jsonb_build_array('correct_attendance', 'approve_attendance'),
    'admin_required', true,
    'supervisor_view_only', true,
    'manage_payroll_implies_correction', false,
    'manage_payroll_implies_approval', false
  ),
  'Added Phase 1 Step 11 attendance correction and approval permission boundaries'
);

commit;
