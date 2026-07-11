-- Workforce Phase 1: guarantee payroll access for every administrator.
--
-- Visible administrators (`base_role = 'admin'`) and hidden system
-- administrators (`is_system_admin = true`) must always have both the profile
-- flag and explicit `manage_payroll` permission enabled. Individually granted
-- payroll access for non-admin users is left unchanged.

begin;

alter table public.profiles
  add column if not exists is_system_admin boolean not null default false;

create or replace function public.workforce_enforce_admin_payroll_profile()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.base_role = 'admin' or new.is_system_admin is true then
    new.can_manage_payroll := true;
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_enforce_admin_payroll on public.profiles;
create trigger profiles_enforce_admin_payroll
before insert or update of base_role, is_system_admin, can_manage_payroll
on public.profiles
for each row execute function public.workforce_enforce_admin_payroll_profile();

create or replace function public.workforce_sync_admin_payroll_permission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_should_grant boolean;
begin
  v_should_grant := (
    new.base_role = 'admin'
    or new.is_system_admin is true
    or new.can_manage_payroll is true
  );

  insert into public.user_permissions (
    user_id,
    permission_key,
    is_granted,
    reason
  ) values (
    new.user_id,
    'manage_payroll',
    v_should_grant,
    case
      when new.base_role = 'admin' or new.is_system_admin is true
        then 'Automatically granted to administrator'
      else 'Synchronized from profile payroll permission'
    end
  )
  on conflict (user_id, permission_key) do update
  set is_granted = excluded.is_granted,
      reason = excluded.reason,
      updated_at = now();

  return new;
end;
$$;

drop trigger if exists profiles_sync_admin_payroll_permission on public.profiles;
create trigger profiles_sync_admin_payroll_permission
after insert or update of base_role, is_system_admin, can_manage_payroll
on public.profiles
for each row execute function public.workforce_sync_admin_payroll_permission();

-- Backfill existing visible and hidden administrators.
update public.profiles
set can_manage_payroll = true,
    updated_at = now()
where base_role = 'admin'
   or is_system_admin is true;

insert into public.user_permissions (
  user_id,
  permission_key,
  is_granted,
  reason
)
select
  profile.user_id,
  'manage_payroll',
  true,
  'Automatically granted to administrator'
from public.profiles profile
where profile.base_role = 'admin'
   or profile.is_system_admin is true
on conflict (user_id, permission_key) do update
set is_granted = true,
    reason = excluded.reason,
    updated_at = now();

insert into public.workforce_audit_logs (
  action,
  entity_type,
  after_data,
  reason
)
select
  'administrator_payroll_access_enabled',
  'workforce_permissions',
  jsonb_build_object(
    'administrator_count', count(*),
    'administrators', jsonb_agg(
      jsonb_build_object(
        'user_id', profile.user_id,
        'full_name', profile.full_name,
        'base_role', profile.base_role,
        'is_system_admin', profile.is_system_admin
      ) order by profile.full_name
    )
  ),
  'Payroll access is mandatory for visible and hidden administrators'
from public.profiles profile
where profile.base_role = 'admin'
   or profile.is_system_admin is true;

do $$
begin
  if exists (
    select 1
    from public.profiles profile
    left join public.user_permissions permission
      on permission.user_id = profile.user_id
     and permission.permission_key = 'manage_payroll'
    where (profile.base_role = 'admin' or profile.is_system_admin is true)
      and (
        profile.can_manage_payroll is not true
        or permission.id is null
        or permission.is_granted is not true
      )
  ) then
    raise exception 'One or more administrators do not have payroll access.';
  end if;
end
$$;

commit;
