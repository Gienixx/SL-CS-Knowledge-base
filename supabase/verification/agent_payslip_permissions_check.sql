-- Phase 2 Step 3 agent payslip permission verification.
-- Every blocker query in section 2 must return zero rows.

-- 1. Required enforcement functions and triggers.
select
  to_regprocedure(
    'public.payroll_enforce_payslip_permission_scope()'
  ) is not null as payslip_scope_function_exists_should_be_true,
  to_regprocedure(
    'public.payroll_sync_agent_own_payslip_permission()'
  ) is not null as agent_sync_function_exists_should_be_true,
  exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.user_permissions'::regclass
      and tgname = 'user_permissions_enforce_payslip_scope'
      and tgenabled = 'O'
  ) as payslip_scope_trigger_enabled_should_be_true,
  exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.profiles'::regclass
      and tgname = 'profiles_sync_agent_own_payslip_permission'
      and tgenabled = 'O'
  ) as agent_sync_trigger_enabled_should_be_true;

-- 2. Blockers.
select
  profile.user_id,
  profile.employee_id
from public.profiles as profile
left join public.user_permissions as permission
  on permission.user_id = profile.user_id
 and permission.permission_key = 'view_own_payslips'
 and permission.is_granted is true
where profile.is_agent is true
  and permission.id is null;
-- agents_without_own_payslip_access_should_be_empty

select
  profile.user_id,
  profile.employee_id
from public.user_permissions as permission
join public.profiles as profile
  on profile.user_id = permission.user_id
where permission.permission_key = 'export_payslips'
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
  );
-- unauthorized_payslip_export_grants_should_be_empty

-- 3. Payslip RLS must retain employee identity scoping.
select
  policyname,
  qual
from pg_policies
where schemaname = 'public'
  and tablename = 'payslips'
  and policyname = 'Authorized users can view payslips';
