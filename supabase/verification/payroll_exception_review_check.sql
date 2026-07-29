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

-- 5. The private helper must not be callable by browser roles.
select
  not has_function_privilege(
    'anon',
    'public.payroll_get_period_exceptions_attendance(uuid)',
    'execute'
  ) as anon_cannot_call_private_helper_should_be_true,
  not has_function_privilege(
    'authenticated',
    'public.payroll_get_period_exceptions_attendance(uuid)',
    'execute'
  ) as authenticated_cannot_call_attendance_helper_should_be_true,
  not has_function_privilege(
    'authenticated',
    'public.payroll_get_period_exceptions_complete_base(uuid)',
    'execute'
  ) as authenticated_cannot_call_complete_helper_should_be_true;

-- 6. These blocker queries must return zero rows in healthy live data.
with active_prepaid as (
  select
    prepaid.*,
    snapshot.schedule_id,
    snapshot.schedule_version as approved_schedule_version,
    snapshot.scheduled_minutes,
    snapshot.schedule_status,
    snapshot.is_rest_day,
    snapshot.is_holiday,
    schedule.schedule_version as current_schedule_version
  from public.payroll_prepaid_hours as prepaid
  left join public.payroll_schedule_snapshots as snapshot
    on snapshot.id = prepaid.source_schedule_snapshot_id
   and snapshot.payroll_record_id = prepaid.source_payroll_record_id
   and snapshot.employee_id = prepaid.employee_id
  left join public.work_schedules as schedule
    on schedule.id = snapshot.schedule_id
  where prepaid.voided_at is null
)
select *
from active_prepaid
where schedule_id is null
   or current_schedule_version is null
   or current_schedule_version is distinct from approved_schedule_version
   or scheduled_minutes is null
   or scheduled_minutes <= 0
   or prepaid_minutes <> scheduled_minutes
   or schedule_status not in ('published', 'changed', 'completed')
   or is_rest_day
   or is_holiday;

with active_allocations as (
  select allocation.*
  from public.payroll_hour_allocations as allocation
  where allocation.allocation_type = 'settlement'
    and not exists (
      select 1
      from public.payroll_hour_allocations as reversal
      where reversal.allocation_type = 'reversal'
        and reversal.reverses_allocation_id = allocation.id
    )
)
select
  prepaid_hour_id,
  attendance_snapshot_id,
  minute_category,
  count(*) as duplicate_count
from active_allocations
group by prepaid_hour_id, attendance_snapshot_id, minute_category
having count(*) > 1;

-- 7. Unresolved balances are expected carry-forward evidence, not blockers.
select
  count(*) as unresolved_balance_count,
  coalesce(sum(remaining_minutes), 0) as unresolved_minutes
from public.payroll_prepaid_hours
where voided_at is null
  and remaining_minutes > 0;
