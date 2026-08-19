-- Phase 2 Step 2: granular payroll permissions.
-- This migration defines and transports the permissions only. It deliberately
-- does not grant them to administrators, agents, or legacy payroll managers.

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
      'manage_payroll'::text,
      'manage_agent_rates'::text,
      'create_payroll'::text,
      'review_payroll'::text,
      'finalize_payroll'::text,
      'view_all_payslips'::text,
      'view_own_payslips'::text,
      'export_payslips'::text,
      'reopen_payroll'::text
    ])
  );

comment on constraint user_permissions_permission_key_check
on public.user_permissions is
  'Canonical workforce permissions, including eight independently granted Phase 2 payroll capabilities. The legacy manage_payroll key is retained only for compatibility.';

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
      v_is_active and coalesce(bool_or(permission_key = 'manage_payroll' and is_granted), false),
    'manage_agent_rates',
      v_is_active and coalesce(bool_or(permission_key = 'manage_agent_rates' and is_granted), false),
    'create_payroll',
      v_is_active and coalesce(bool_or(permission_key = 'create_payroll' and is_granted), false),
    'review_payroll',
      v_is_active and coalesce(bool_or(permission_key = 'review_payroll' and is_granted), false),
    'finalize_payroll',
      v_is_active and coalesce(bool_or(permission_key = 'finalize_payroll' and is_granted), false),
    'view_all_payslips',
      v_is_active and coalesce(bool_or(permission_key = 'view_all_payslips' and is_granted), false),
    'view_own_payslips',
      v_is_active and coalesce(bool_or(permission_key = 'view_own_payslips' and is_granted), false),
    'export_payslips',
      v_is_active and coalesce(bool_or(permission_key = 'export_payslips' and is_granted), false),
    'reopen_payroll',
      v_is_active and coalesce(bool_or(permission_key = 'reopen_payroll' and is_granted), false)
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
    'can_manage_agent_rates', coalesce((v_permissions ->> 'manage_agent_rates')::boolean, false),
    'can_create_payroll', coalesce((v_permissions ->> 'create_payroll')::boolean, false),
    'can_review_payroll', coalesce((v_permissions ->> 'review_payroll')::boolean, false),
    'can_finalize_payroll', coalesce((v_permissions ->> 'finalize_payroll')::boolean, false),
    'can_view_all_payslips', coalesce((v_permissions ->> 'view_all_payslips')::boolean, false),
    'can_view_own_payslips', coalesce((v_permissions ->> 'view_own_payslips')::boolean, false),
    'can_export_payslips', coalesce((v_permissions ->> 'export_payslips')::boolean, false),
    'can_reopen_payroll', coalesce((v_permissions ->> 'reopen_payroll')::boolean, false),
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
  v_permission_key text;
  v_is_granted boolean;
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

  foreach v_permission_key in array array[
    'manage_announcements',
    'manage_agent_rates',
    'create_payroll',
    'review_payroll',
    'finalize_payroll',
    'view_all_payslips',
    'view_own_payslips',
    'export_payslips',
    'reopen_payroll'
  ] loop
    if v_permission_key = 'manage_announcements'
       and exists (
         select 1 from public.profiles profile
         where profile.user_id = p_user_id
           and profile.is_system_admin is true
       ) then
      v_is_granted := true;
    elsif p_permissions ? v_permission_key then
      v_is_granted := coalesce((p_permissions ->> v_permission_key)::boolean, false);
    else
      select permission.is_granted
      into v_is_granted
      from public.user_permissions permission
      where permission.user_id = p_user_id
        and permission.permission_key = v_permission_key;

      v_is_granted := coalesce(v_is_granted, false);
    end if;

    insert into public.user_permissions (
      user_id, permission_key, is_granted, granted_by, reason
    ) values (
      p_user_id,
      v_permission_key,
      v_is_granted,
      auth.uid(),
      coalesce(
        nullif(trim(coalesce(p_reason, '')), ''),
        'Updated through workforce employee administration'
      )
    )
    on conflict (user_id, permission_key) do update
    set is_granted = excluded.is_granted,
        granted_by = excluded.granted_by,
        reason = excluded.reason,
        updated_at = now();

    v_result := jsonb_set(
      v_result,
      array['permissions', v_permission_key],
      to_jsonb(v_is_granted),
      true
    );
  end loop;

  return jsonb_set(v_result, '{access_type}', to_jsonb(p_access_type), true);
end;
$$;

revoke all on function public.workforce_admin_save_employee(
  uuid, text, text, text, text, uuid, uuid, text, jsonb, text
) from public, anon;
grant execute on function public.workforce_admin_save_employee(
  uuid, text, text, text, text, uuid, uuid, text, jsonb, text
) to authenticated;

alter function public.workforce_service_create_invitation(
  uuid, uuid, text, text, text, jsonb, uuid, uuid
) rename to workforce_service_create_invitation_legacy_payroll_bridge;

revoke all on function public.workforce_service_create_invitation_legacy_payroll_bridge(
  uuid, uuid, text, text, text, jsonb, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.workforce_service_create_invitation_legacy_payroll_bridge(
  uuid, uuid, text, text, text, jsonb, uuid, uuid
) to service_role;

create function public.workforce_service_create_invitation(
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
set search_path = public
as $$
declare
  v_result jsonb;
  v_actor_profile_id uuid;
  v_permission_key text;
  v_is_granted boolean;
begin
  v_result := public.workforce_service_create_invitation_legacy_payroll_bridge(
    p_actor_auth_user_id,
    p_auth_user_id,
    p_full_name,
    p_email,
    p_access_type,
    p_permissions,
    p_team_id,
    p_supervisor_id
  );

  select identity_link.profile_user_id
  into v_actor_profile_id
  from public.workforce_identity_links identity_link
  join public.profiles profile on profile.user_id = identity_link.profile_user_id
  where identity_link.auth_user_id = p_actor_auth_user_id
    and identity_link.is_active is true
    and profile.employment_status in ('active', 'on_leave')
    and profile.onboarding_status = 'active'
  order by (identity_link.profile_user_id = p_actor_auth_user_id) desc
  limit 1;

  foreach v_permission_key in array array[
    'manage_agent_rates',
    'create_payroll',
    'review_payroll',
    'finalize_payroll',
    'view_all_payslips',
    'view_own_payslips',
    'export_payslips',
    'reopen_payroll'
  ] loop
    v_is_granted := coalesce((p_permissions ->> v_permission_key)::boolean, false);

    insert into public.user_permissions (
      user_id, permission_key, is_granted, granted_by, reason
    ) values (
      p_auth_user_id,
      v_permission_key,
      v_is_granted,
      v_actor_profile_id,
      'Initial grant from unified invitation service'
    )
    on conflict (user_id, permission_key) do update
    set is_granted = excluded.is_granted,
        granted_by = excluded.granted_by,
        reason = excluded.reason,
        updated_at = now();
  end loop;

  return v_result;
end;
$$;

revoke all on function public.workforce_service_create_invitation(
  uuid, uuid, text, text, text, jsonb, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.workforce_service_create_invitation(
  uuid, uuid, text, text, text, jsonb, uuid, uuid
) to service_role;

insert into public.workforce_audit_logs (
  actor_user_id,
  action,
  entity_type,
  after_data,
  reason
) values (
  null,
  'phase2_payroll_permissions_registered',
  'user_permissions',
  jsonb_build_object(
    'permission_keys', jsonb_build_array(
      'manage_agent_rates',
      'create_payroll',
      'review_payroll',
      'finalize_payroll',
      'view_all_payslips',
      'view_own_payslips',
      'export_payslips',
      'reopen_payroll'
    ),
    'automatic_grants_created', false,
    'legacy_manage_payroll_retained', true,
    'administrator_access_is_implicit', false
  ),
  'Registered granular payroll capabilities without assigning payroll access'
);

commit;
