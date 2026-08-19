-- Canonical workforce access model:
--   admin_agent  -> base_role=admin, is_agent=true
--   admin        -> base_role=admin, is_agent=false
--   regular_agent-> base_role=agent, is_agent=true
-- Article editing is an independent user_permissions grant, never an access type.

begin;

-- Preserve the latest transactional implementation behind a private bridge.
-- The public RPC below accepts only the three canonical administrator-facing
-- access types and maps article editing independently into its permissions.
alter function public.workforce_admin_save_employee(
  uuid, text, text, text, text, uuid, uuid, text, jsonb, text
) rename to workforce_admin_save_employee_legacy_access_bridge;

revoke all on function public.workforce_admin_save_employee_legacy_access_bridge(
  uuid, text, text, text, text, uuid, uuid, text, jsonb, text
) from public, anon, authenticated;

create function public.workforce_admin_save_employee(
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

  return jsonb_set(v_result, '{access_type}', to_jsonb(p_access_type), true);
end;
$$;

revoke all on function public.workforce_admin_save_employee(
  uuid, text, text, text, text, uuid, uuid, text, jsonb, text
) from public, anon;
grant execute on function public.workforce_admin_save_employee(
  uuid, text, text, text, text, uuid, uuid, text, jsonb, text
) to authenticated;

-- Normalize the verified production identities without changing their
-- employment, team, supervisor, onboarding, or Auth identity state.
update public.profiles
set base_role = 'agent', is_agent = true, can_edit_articles = true, updated_at = now()
where lower(email) in ('arez@eurekasurveys.com', 'gen@eurekasurveys.com');

update public.profiles
set base_role = 'admin', is_agent = true, updated_at = now()
where lower(email) = 'almar@eurekasurveys.com';

update public.profiles
set base_role = 'admin', is_agent = false, can_edit_articles = true, updated_at = now()
where lower(email) = 'arby.benito10@gmail.com'
  and is_system_admin is true;

insert into public.user_permissions (user_id, permission_key, is_granted, reason)
select profile.user_id, 'edit_articles', true,
       'Preserved as an independent permission during canonical access migration'
from public.profiles profile
where lower(profile.email) in (
  'arez@eurekasurveys.com',
  'gen@eurekasurveys.com',
  'almar@eurekasurveys.com',
  'arby.benito10@gmail.com'
)
on conflict (user_id, permission_key) do update
set is_granted = true,
    reason = excluded.reason,
    updated_at = now();

update public.login login_user
set is_admin = profile.base_role = 'admin',
    can_edit_articles = permission.is_granted
from public.profiles profile
join public.user_permissions permission
  on permission.user_id = profile.user_id
 and permission.permission_key = 'edit_articles'
where lower(login_user.email) = lower(profile.email)
  and lower(profile.email) in (
    'arez@eurekasurveys.com',
    'gen@eurekasurveys.com',
    'almar@eurekasurveys.com',
    'arby.benito10@gmail.com'
  );

insert into public.workforce_audit_logs (
  actor_user_id, action, entity_type, after_data, reason
) values (
  null,
  'canonical_access_model_enabled',
  'profiles',
  jsonb_build_object(
    'access_types', jsonb_build_array('admin', 'regular_agent', 'admin_agent'),
    'article_editing_source', 'user_permissions.edit_articles',
    'legacy_mirrors_preserved', true
  ),
  'Removed article editor as an access type while preserving effective access'
);

commit;
