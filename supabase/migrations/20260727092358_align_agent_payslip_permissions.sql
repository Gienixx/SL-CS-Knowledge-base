-- Phase 2 Step 3: make own-payslip access standard for agents and keep
-- payroll export restricted to approved payroll administrators.

begin;

create or replace function public.payroll_enforce_payslip_permission_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_agent boolean := false;
  v_can_export boolean := false;
begin
  select profile.is_agent
  into v_is_agent
  from public.profiles as profile
  where profile.user_id = new.user_id;

  if new.permission_key = 'view_own_payslips'
     and coalesce(v_is_agent, false) then
    new.is_granted := true;
    new.reason := coalesce(
      nullif(trim(new.reason), ''),
      'Standard own-payslip access for agents'
    );
  end if;

  if new.permission_key = 'export_payslips'
     and new.is_granted then
    select
      profile.is_system_admin is true
      or lower(profile.email) = 'almar@eurekasurveys.com'
      or exists (
        select 1
        from public.user_permissions as permission
        where permission.user_id = new.user_id
          and permission.permission_key in (
            'finalize_payroll',
            'view_all_payslips'
          )
          and permission.is_granted is true
      )
    into v_can_export
    from public.profiles as profile
    where profile.user_id = new.user_id;

    if not coalesce(v_can_export, false) then
      raise exception
        using
          errcode = '42501',
          message = 'Payslip export is restricted to approved payroll administrators.';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.payroll_enforce_payslip_permission_scope()
  from public, anon, authenticated;

drop trigger if exists user_permissions_enforce_payslip_scope
on public.user_permissions;

create trigger user_permissions_enforce_payslip_scope
before insert or update of permission_key, is_granted
on public.user_permissions
for each row
when (
  new.permission_key in ('view_own_payslips', 'export_payslips')
)
execute function public.payroll_enforce_payslip_permission_scope();

create or replace function public.payroll_sync_agent_own_payslip_permission()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.is_agent is true then
    insert into public.user_permissions (
      user_id,
      permission_key,
      is_granted,
      granted_by,
      reason
    )
    values (
      new.user_id,
      'view_own_payslips',
      true,
      null,
      'Standard own-payslip access for agents'
    )
    on conflict (user_id, permission_key) do update
    set is_granted = true,
        granted_by = null,
        reason = excluded.reason,
        updated_at = now();
  end if;

  return new;
end;
$$;

revoke all on function public.payroll_sync_agent_own_payslip_permission()
  from public, anon, authenticated;

drop trigger if exists profiles_sync_agent_own_payslip_permission
on public.profiles;

create trigger profiles_sync_agent_own_payslip_permission
after insert or update of is_agent
on public.profiles
for each row
when (new.is_agent is true)
execute function public.payroll_sync_agent_own_payslip_permission();

with granted as (
  insert into public.user_permissions (
    user_id,
    permission_key,
    is_granted,
    granted_by,
    reason
  )
  select
    profile.user_id,
    'view_own_payslips',
    true,
    null,
    'Standard own-payslip access for agents'
  from public.profiles as profile
  where profile.is_agent is true
  on conflict (user_id, permission_key) do update
  set is_granted = true,
      granted_by = null,
      reason = excluded.reason,
      updated_at = now()
  where public.user_permissions.is_granted is distinct from true
  returning user_id
)
insert into public.payroll_audit_logs (
  actor_user_id,
  action,
  entity_type,
  entity_id,
  after_data,
  reason,
  metadata
)
select
  null,
  'agent_own_payslip_access_granted',
  'profiles',
  granted.user_id,
  jsonb_build_object(
    'permission_key', 'view_own_payslips',
    'is_granted', true
  ),
  'Standard own-payslip access enabled for agent',
  jsonb_build_object(
    'scope', 'own_finalized_payslips',
    'export_implied', false
  )
from granted;

with revoked as (
  update public.user_permissions as permission
  set is_granted = false,
      granted_by = null,
      reason = 'Payslip export is restricted to approved payroll administrators',
      updated_at = now()
  from public.profiles as profile
  where profile.user_id = permission.user_id
    and permission.permission_key = 'export_payslips'
    and permission.is_granted is true
    and profile.is_system_admin is not true
    and coalesce(lower(profile.email), '') <> 'almar@eurekasurveys.com'
    and not exists (
      select 1
      from public.user_permissions as payroll_permission
      where payroll_permission.user_id = permission.user_id
        and payroll_permission.permission_key in (
          'finalize_payroll',
          'view_all_payslips'
        )
        and payroll_permission.is_granted is true
    )
  returning permission.user_id
)
insert into public.payroll_audit_logs (
  actor_user_id,
  action,
  entity_type,
  entity_id,
  before_data,
  after_data,
  reason,
  metadata
)
select
  null,
  'unauthorized_payslip_export_revoked',
  'profiles',
  revoked.user_id,
  jsonb_build_object(
    'permission_key', 'export_payslips',
    'is_granted', true
  ),
  jsonb_build_object(
    'permission_key', 'export_payslips',
    'is_granted', false
  ),
  'Payslip export is restricted to approved payroll administrators',
  jsonb_build_object(
    'own_payslip_printing_affected', false
  )
from revoked;

comment on function public.payroll_enforce_payslip_permission_scope() is
  'Keeps own-payslip access enabled for agents and blocks export grants to users without approved payroll-administrator authority.';

comment on function public.payroll_sync_agent_own_payslip_permission() is
  'Automatically grants owner-scoped payslip access whenever a profile becomes an agent.';

commit;
