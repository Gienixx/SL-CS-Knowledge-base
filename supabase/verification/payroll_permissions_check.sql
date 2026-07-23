-- Phase 2 Step 2 verification. Run before Step 3 grants permissions.
with payroll_permissions(permission_key) as (
  values
    ('manage_agent_rates'),
    ('create_payroll'),
    ('review_payroll'),
    ('finalize_payroll'),
    ('view_all_payslips'),
    ('view_own_payslips'),
    ('export_payslips'),
    ('reopen_payroll')
),
constraint_definition as (
  select pg_get_constraintdef(constraint_row.oid) as definition
  from pg_constraint constraint_row
  where constraint_row.conrelid = 'public.user_permissions'::regclass
    and constraint_row.conname = 'user_permissions_permission_key_check'
),
permission_registration as (
  select bool_and(
    position(permission.permission_key in constraint_definition.definition) > 0
  ) as all_permissions_registered
  from payroll_permissions permission
  cross join constraint_definition
),
access_rpc as (
  select bool_and(
    position(
      quote_literal(permission.permission_key)
      in pg_get_functiondef('public.workforce_get_current_access()'::regprocedure)
    ) > 0
  ) as all_permissions_in_access_rpc
  from payroll_permissions permission
),
admin_separation as (
  select bool_and(
    position(
      quote_literal(permission.permission_key)
      in pg_get_functiondef('public.workforce_has_permission(text)'::regprocedure)
    ) = 0
  ) as payroll_not_implied_by_admin
  from payroll_permissions permission
),
grant_check as (
  select not exists (
    select 1
    from public.user_permissions permission
    join payroll_permissions payroll
      on payroll.permission_key = permission.permission_key
    where permission.is_granted is true
  ) as no_step2_automatic_grants
)
select
  permission_registration.*,
  access_rpc.*,
  admin_separation.*,
  grant_check.*,
  (
    permission_registration.all_permissions_registered
    and access_rpc.all_permissions_in_access_rpc
    and admin_separation.payroll_not_implied_by_admin
    and grant_check.no_step2_automatic_grants
  ) as phase2_step2_ready
from permission_registration
cross join access_rpc
cross join admin_separation
cross join grant_check;
