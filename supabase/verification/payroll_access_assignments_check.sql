-- Phase 2 Step 3 verification.
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
approved_users as (
  select profile.user_id, lower(profile.email) as email
  from public.profiles profile
  where lower(profile.email) = 'almar@eurekasurveys.com'
     or profile.is_system_admin is true
),
grant_matrix as (
  select
    approved_user.user_id,
    approved_user.email,
    payroll_permission.permission_key,
    coalesce(permission.is_granted, false) as is_granted
  from approved_users approved_user
  cross join payroll_permissions payroll_permission
  left join public.user_permissions permission
    on permission.user_id = approved_user.user_id
   and permission.permission_key = payroll_permission.permission_key
),
approved_grants as (
  select
    count(distinct user_id) = 2
      and count(*) = 16
      and bool_and(is_granted) as only_approved_users_have_full_access
  from grant_matrix
),
unapproved_grants as (
  select not exists (
    select 1
    from public.user_permissions permission
    join payroll_permissions payroll_permission
      on payroll_permission.permission_key = permission.permission_key
    where permission.is_granted is true
      and not exists (
        select 1
        from approved_users approved_user
        where approved_user.user_id = permission.user_id
      )
  ) as no_unapproved_payroll_grants
),
policy_checks as (
  select
    count(*) filter (
      where policy.tablename = 'agent_rates'
        and position('manage_agent_rates' in coalesce(policy.qual, '')) > 0
        and position('is_admin' in coalesce(policy.qual, '')) = 0
    ) = 1 as rates_require_explicit_permission,
    count(*) filter (
      where policy.tablename = 'payroll_records'
        and position('view_own_payslips' in coalesce(policy.qual, '')) > 0
        and position('workforce_is_current_identity' in coalesce(policy.qual, '')) > 0
    ) = 1 as own_records_are_identity_scoped,
    count(*) filter (
      where policy.tablename = 'payslips'
        and position('view_own_payslips' in coalesce(policy.qual, '')) > 0
        and position('workforce_is_current_identity' in coalesce(policy.qual, '')) > 0
    ) = 1 as own_payslips_are_identity_scoped
  from pg_policies policy
  where policy.schemaname = 'public'
    and policy.tablename in (
      'agent_rates',
      'payroll_records',
      'payslips'
    )
),
attendance_separation as (
  select
    position(
      'correct_attendance'
      in pg_get_functiondef('public.workforce_has_permission(text)'::regprocedure)
    ) = 0 as payroll_does_not_imply_attendance_correction
)
select
  approved_grants.*,
  unapproved_grants.*,
  policy_checks.*,
  attendance_separation.*,
  (
    approved_grants.only_approved_users_have_full_access
    and unapproved_grants.no_unapproved_payroll_grants
    and policy_checks.rates_require_explicit_permission
    and policy_checks.own_records_are_identity_scoped
    and policy_checks.own_payslips_are_identity_scoped
    and attendance_separation.payroll_does_not_imply_attendance_correction
  ) as phase2_step3_ready
from approved_grants
cross join unapproved_grants
cross join policy_checks
cross join attendance_separation;
