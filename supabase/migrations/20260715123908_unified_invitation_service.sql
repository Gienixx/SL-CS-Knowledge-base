begin;

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
    'view_workforce_reports', 'edit_articles', 'manage_payroll'
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

comment on function public.workforce_service_create_invitation(
  uuid, uuid, text, text, text, jsonb, uuid, uuid
) is 'Service-role-only transactional provisioning for an Auth invitation.';

revoke all on function public.workforce_service_create_invitation(
  uuid, uuid, text, text, text, jsonb, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.workforce_service_create_invitation(
  uuid, uuid, text, text, text, jsonb, uuid, uuid
) to service_role;

commit;
