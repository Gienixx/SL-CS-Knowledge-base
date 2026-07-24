-- Phase 2 Step 8 payroll exception review verification.
-- Replace the UUID in section 3 with the payroll period being reviewed.

-- 1. Required RPC exists.
select
  to_regprocedure('public.payroll_get_period_exceptions(uuid)') is not null
    as exception_review_rpc_exists_should_be_true;

-- 2. Browser access remains permission-checked and RPC-only.
select
  has_function_privilege(
    'anon',
    'public.payroll_get_period_exceptions(uuid)',
    'execute'
  ) as anon_can_review_exceptions_should_be_false,
  has_function_privilege(
    'authenticated',
    'public.payroll_get_period_exceptions(uuid)',
    'execute'
  ) as authenticated_can_review_exceptions_should_be_true;

select
  table_name,
  row_security_active(format('public.%I', table_name)::regclass)
    as rls_active_should_be_true
from (
  values
    ('agent_rates'::text),
    ('payroll_attendance_snapshots'::text)
) as protected_table(table_name);

select
  tablename,
  policyname,
  qual
from pg_policies
where schemaname = 'public'
  and tablename in ('agent_rates', 'payroll_attendance_snapshots')
order by tablename, policyname;

-- 3. Review the exact blocking exceptions for one payroll period.
-- select *
-- from public.payroll_get_period_exceptions(
--   '00000000-0000-0000-0000-000000000000'::uuid
-- )
-- order by work_date nulls first, employee_name, exception_label;

-- 4. Confirm the database function returns only review metadata.
select
  parameter_name,
  data_type
from information_schema.parameters
where specific_schema = 'public'
  and specific_name like 'payroll_get_period_exceptions_%'
order by ordinal_position;
