begin;

lock table public.profiles in share row exclusive mode;

-- Capture the complete access state before changing the protected owner.
insert into public.workforce_audit_logs (
  action,
  entity_type,
  before_data,
  reason
)
select
  'system_ownership_transfer_started',
  'workforce_configuration',
  jsonb_build_object(
    'profiles', jsonb_agg(
      jsonb_build_object(
        'employee_id', profile.employee_id,
        'full_name', profile.full_name,
        'base_role', profile.base_role,
        'is_agent', profile.is_agent,
        'is_system_admin', profile.is_system_admin,
        'employment_status', profile.employment_status,
        'permissions', coalesce((
          select jsonb_object_agg(permission.permission_key, permission.is_granted)
          from public.user_permissions permission
          where permission.user_id = profile.user_id
        ), '{}'::jsonb)
      ) order by profile.employee_id
    )
  ),
  'Snapshot before transferring protected ownership to the dedicated admin account'
from public.profiles profile;

do $$
declare
  v_source public.profiles%rowtype;
  v_target public.profiles%rowtype;
  v_permission text;
begin
  select * into strict v_source
  from public.profiles
  where lower(email) = lower('arby@eurekasurveys.com')
    and employee_id = 'SL-F69A9E68'
  for update;

  select * into strict v_target
  from public.profiles
  where lower(email) = lower('arby.benito10@gmail.com')
    and employee_id = 'SL-7859DCC5'
  for update;

  if v_source.is_system_admin is not true then
    raise exception 'Expected source profile is not the current system owner.';
  end if;

  if v_target.employment_status not in ('active', 'on_leave') then
    raise exception 'Destination admin account is not active.';
  end if;

  if not exists (
    select 1
    from public.workforce_identity_links identity_link
    where identity_link.profile_user_id = v_source.user_id
      and identity_link.auth_user_id = 'f69a9e68-5507-4132-af60-e7cc1255d8c2'::uuid
      and identity_link.is_active
  ) or not exists (
    select 1
    from public.workforce_identity_links identity_link
    where identity_link.profile_user_id = v_target.user_id
      and identity_link.auth_user_id = '7859dcc5-7a77-4850-bc91-1db5d9e0dd90'::uuid
      and identity_link.is_active
  ) then
    raise exception 'Ownership transfer identity verification failed.';
  end if;

  update public.profiles
  set is_system_admin = false,
      base_role = 'agent',
      is_agent = true,
      can_edit_articles = false,
      can_manage_payroll = false,
      updated_at = now()
  where user_id = v_source.user_id;

  update public.user_permissions
  set is_granted = false,
      granted_by = v_target.user_id,
      reason = 'Revoked when protected ownership moved to the dedicated admin account',
      updated_at = now()
  where user_id = v_source.user_id;

  update public.profiles
  set is_system_admin = true,
      base_role = 'admin',
      is_agent = false,
      can_edit_articles = true,
      can_manage_payroll = true,
      updated_at = now()
  where user_id = v_target.user_id;

  foreach v_permission in array array[
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
    insert into public.user_permissions (
      user_id, permission_key, is_granted, granted_by, reason
    ) values (
      v_target.user_id,
      v_permission,
      true,
      v_target.user_id,
      'Confirmed during protected ownership transfer'
    )
    on conflict (user_id, permission_key) do update
    set is_granted = true,
        granted_by = excluded.granted_by,
        reason = excluded.reason,
        updated_at = now();
  end loop;

  insert into public.workforce_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    before_data,
    after_data,
    reason
  ) values (
    v_target.user_id,
    'system_ownership_transferred',
    'profiles',
    v_target.user_id,
    jsonb_build_object(
      'owner_user_id', v_source.user_id,
      'owner_employee_id', v_source.employee_id,
      'owner_email', v_source.email
    ),
    jsonb_build_object(
      'owner_user_id', v_target.user_id,
      'owner_employee_id', v_target.employee_id,
      'owner_email', v_target.email
    ),
    'Transferred protected ownership from the employee-facing Arby profile to the dedicated admin account'
  );
end;
$$;

create unique index if not exists profiles_single_system_owner_idx
  on public.profiles ((is_system_admin))
  where is_system_admin is true;

create or replace function public.workforce_require_single_active_system_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner_count integer;
begin
  select count(*)::integer
  into v_owner_count
  from public.profiles
  where is_system_admin is true
    and employment_status in ('active', 'on_leave');

  if v_owner_count <> 1 then
    raise exception 'Exactly one active system owner is required; found %.', v_owner_count;
  end if;

  return null;
end;
$$;

revoke all on function public.workforce_require_single_active_system_owner() from public;
revoke all on function public.workforce_require_single_active_system_owner() from anon;
revoke all on function public.workforce_require_single_active_system_owner() from authenticated;

drop trigger if exists profiles_require_single_active_system_owner on public.profiles;
create constraint trigger profiles_require_single_active_system_owner
after insert or delete or update of is_system_admin, employment_status
on public.profiles
deferrable initially deferred
for each row execute function public.workforce_require_single_active_system_owner();

do $$
begin
  if (select count(*) from public.profiles where is_system_admin is true) <> 1
     or not exists (
       select 1
       from public.profiles
       where lower(email) = lower('arby.benito10@gmail.com')
         and employee_id = 'SL-7859DCC5'
         and is_system_admin is true
         and base_role = 'admin'
         and is_agent is false
         and employment_status in ('active', 'on_leave')
     ) then
    raise exception 'Destination admin account did not become the sole active system owner.';
  end if;

  if exists (
    select 1
    from public.profiles source_profile
    left join public.user_permissions permission
      on permission.user_id = source_profile.user_id
     and permission.is_granted
    where lower(source_profile.email) = lower('arby@eurekasurveys.com')
      and (
        source_profile.is_system_admin
        or source_profile.base_role <> 'agent'
        or source_profile.is_agent is not true
        or permission.id is not null
      )
  ) then
    raise exception 'Source employee profile still has owner-level access.';
  end if;
end;
$$;

comment on index public.profiles_single_system_owner_idx is
  'Allows no more than one protected workforce system owner.';

comment on function public.workforce_require_single_active_system_owner() is
  'Deferred ownership invariant requiring exactly one active or on-leave system owner.';

commit;
