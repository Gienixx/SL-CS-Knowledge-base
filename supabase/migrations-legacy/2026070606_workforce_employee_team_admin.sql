-- Phase 1 Step 3: employee and team administration
--
-- Adds transactional, server-authorized RPCs for employee profile, permission,
-- team, supervisor, and compatibility-login updates. Existing RLS remains the
-- authoritative read boundary for the browser interfaces.

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

  -- Prevent the current operator from accidentally locking themselves out.
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

  -- Run compatibility synchronization before the explicit permission upserts.
  -- The existing login trigger writes legacy defaults; the loop below then
  -- restores the administrator's exact permission choices.
  update public.login
  set name = v_profile.full_name,
      is_admin = v_profile.base_role = 'admin',
      can_edit_articles = v_can_edit_articles
  where lower(email) = lower(v_profile.email);

  foreach v_permission_key in array array[
    'manage_employees',
    'manage_schedules',
    'view_team_attendance',
    'approve_leave',
    'view_workforce_reports',
    'edit_articles',
    'manage_payroll'
  ] loop
    if v_permission_key = 'edit_articles' then
      v_is_granted := v_can_edit_articles;
    elsif v_permission_key = 'manage_payroll' then
      v_is_granted := v_can_manage_payroll;
    else
      v_is_granted := coalesce((p_permissions ->> v_permission_key)::boolean, false);
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
) is 'Atomically updates an employee profile, effective permissions, and legacy login compatibility fields.';

create or replace function public.workforce_admin_save_team(
  p_team_id uuid default null,
  p_name text default null,
  p_description text default null,
  p_supervisor_id uuid default null,
  p_is_active boolean default true,
  p_reason text default null
)
returns public.teams
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result public.teams%rowtype;
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_description text := nullif(trim(coalesce(p_description, '')), '');
begin
  if auth.uid() is null
     or not public.workforce_is_admin()
     or not public.workforce_has_permission('manage_employees') then
    raise exception 'You do not have permission to manage teams.' using errcode = '42501';
  end if;

  if v_name is null then
    raise exception 'Team name is required.';
  end if;

  if p_supervisor_id is not null and not exists (
    select 1
    from public.profiles supervisor
    where supervisor.user_id = p_supervisor_id
      and supervisor.employment_status in ('active', 'on_leave')
  ) then
    raise exception 'Selected supervisor is not an active workforce user.';
  end if;

  if p_team_id is null then
    insert into public.teams (
      name,
      description,
      supervisor_id,
      is_active,
      created_by,
      updated_by
    ) values (
      v_name,
      v_description,
      p_supervisor_id,
      coalesce(p_is_active, true),
      auth.uid(),
      auth.uid()
    )
    returning * into v_result;
  else
    update public.teams
    set name = v_name,
        description = v_description,
        supervisor_id = p_supervisor_id,
        is_active = coalesce(p_is_active, true),
        updated_by = auth.uid(),
        updated_at = now()
    where id = p_team_id
    returning * into v_result;

    if not found then
      raise exception 'Team not found.';
    end if;
  end if;

  if nullif(trim(coalesce(p_reason, '')), '') is not null then
    insert into public.workforce_audit_logs (
      actor_user_id,
      action,
      entity_type,
      entity_id,
      reason
    ) values (
      auth.uid(),
      case when p_team_id is null then 'create_note' else 'update_note' end,
      'teams',
      v_result.id,
      nullif(trim(p_reason), '')
    );
  end if;

  return v_result;
end;
$$;

comment on function public.workforce_admin_save_team(
  uuid, text, text, uuid, boolean, text
) is 'Creates or updates a workforce team through an authorized transaction.';

revoke execute on function public.workforce_admin_save_employee(
  uuid, text, text, text, text, uuid, uuid, text, jsonb, text
) from anon;
revoke all on function public.workforce_admin_save_employee(
  uuid, text, text, text, text, uuid, uuid, text, jsonb, text
) from public;
grant execute on function public.workforce_admin_save_employee(
  uuid, text, text, text, text, uuid, uuid, text, jsonb, text
) to authenticated;

revoke execute on function public.workforce_admin_save_team(
  uuid, text, text, uuid, boolean, text
) from anon;
revoke all on function public.workforce_admin_save_team(
  uuid, text, text, uuid, boolean, text
) from public;
grant execute on function public.workforce_admin_save_team(
  uuid, text, text, uuid, boolean, text
) to authenticated;
