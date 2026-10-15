create role anon;
create role authenticated;
create role service_role;
create schema auth;

create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create table public.profiles (
  user_id uuid primary key,
  is_active boolean not null,
  is_admin boolean not null
);

create table public.user_permissions (
  user_id uuid not null,
  permission_key text not null,
  is_granted boolean not null,
  granted_by uuid,
  reason text,
  updated_at timestamptz not null default now(),
  primary key(user_id, permission_key),
  constraint user_permissions_permission_key_check check (
    permission_key = any(array['view_workforce_reports'::text, 'reopen_payroll'::text])
  )
);

create table public.agent_identity_map (
  agent_key text primary key,
  agent_name text not null,
  zendesk_agent_key text,
  active boolean not null default true,
  dashboard_sync_approved boolean not null default false,
  updated_at timestamptz not null default now()
);

create function public.workforce_current_user_is_active() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.profiles where user_id = auth.uid() and is_active)
$$;

create function public.workforce_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.profiles where user_id = auth.uid() and is_admin)
$$;

create function public.workforce_has_permission(p_permission_key text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.workforce_current_user_is_active() and (
    exists(select 1 from public.user_permissions where user_id = auth.uid() and permission_key = p_permission_key and is_granted)
    or (p_permission_key = 'view_workforce_reports' and public.workforce_is_admin())
  )
$$;

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
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_permission_key text;
  v_is_granted boolean;
begin
  foreach v_permission_key in array array[
    'reopen_payroll'
  ] loop
    if p_permissions ? v_permission_key then
      v_is_granted := coalesce((p_permissions ->> v_permission_key)::boolean, false);
    else
      v_is_granted := false;
    end if;
    insert into public.user_permissions(user_id, permission_key, is_granted)
    values(p_user_id, v_permission_key, v_is_granted);
  end loop;
  return '{}'::jsonb;
end;
$$;

create function public.workforce_get_current_access() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_is_active boolean := public.workforce_current_user_is_active();
  v_permissions jsonb;
begin
  select jsonb_build_object(
    'reopen_payroll',
      v_is_active and coalesce(bool_or(permission_key = 'reopen_payroll' and is_granted), false)
  )
  into v_permissions
  from public.user_permissions
  where user_id = auth.uid();
  return jsonb_build_object('permissions', v_permissions);
end;
$$;

insert into public.profiles(user_id, is_active, is_admin) values
  ('11111111-1111-1111-1111-111111111111', true, true),
  ('22222222-2222-2222-2222-222222222222', true, true),
  ('33333333-3333-3333-3333-333333333333', true, false),
  ('44444444-4444-4444-4444-444444444444', false, true);

insert into public.user_permissions(user_id, permission_key, is_granted) values
  ('11111111-1111-1111-1111-111111111111', 'view_workforce_reports', true),
  ('22222222-2222-2222-2222-222222222222', 'view_workforce_reports', true),
  ('33333333-3333-3333-3333-333333333333', 'view_workforce_reports', true),
  ('44444444-4444-4444-4444-444444444444', 'view_workforce_reports', true);

insert into public.agent_identity_map(agent_key, agent_name, zendesk_agent_key, active)
values
  ('fixture-agent', 'Fixture Agent', 'zd-fixture', true),
  ('race-agent', 'Race Agent', 'zd-race', true),
  ('inactive-agent', 'Inactive Agent', 'zd-inactive', false);

grant usage on schema public to authenticated;
grant select on public.agent_identity_map to authenticated;
grant execute on function auth.uid() to authenticated;

