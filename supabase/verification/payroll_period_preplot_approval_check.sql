-- Revised Phase 2 Step 5 production verification.
-- Every query in section 3 must return zero rows.

-- 1. Required period columns and constraints.
select
  column_name,
  data_type,
  is_nullable,
  column_default,
  is_generated,
  generation_expression
from information_schema.columns
where table_schema = 'public'
  and table_name = 'payroll_periods'
  and column_name in (
    'early_payment_window_days',
    'early_payment_days',
    'early_payment_override_reason',
    'early_payment_override_by',
    'early_payment_override_at'
  )
order by ordinal_position;

select
  constraint_name,
  check_clause
from information_schema.check_constraints
where constraint_schema = 'public'
  and constraint_name in (
    'payroll_periods_payment_date_check',
    'payroll_periods_early_payment_window_check',
    'payroll_periods_early_payment_days_check',
    'payroll_periods_early_payment_override_check'
  )
order by constraint_name;

-- 2. Function security and API scope.
select
  routine_name,
  security_type
from information_schema.routines
where routine_schema = 'public'
  and routine_name in (
    'payroll_create_period',
    'payroll_get_period_dashboard',
    'payroll_get_period_employee_readiness',
    'payroll_get_period_missing_attendance',
    'payroll_get_period_exceptions',
    'payroll_get_preplot_candidates',
    'payroll_approve_preplots'
  )
order by routine_name;

select
  has_function_privilege(
    'anon',
    'public.payroll_get_preplot_candidates(uuid)',
    'execute'
  ) as anon_can_list_preplots_should_be_false,
  has_function_privilege(
    'anon',
    'public.payroll_approve_preplots(uuid,uuid[],text)',
    'execute'
  ) as anon_can_approve_preplots_should_be_false,
  has_function_privilege(
    'authenticated',
    'public.payroll_approve_preplots(uuid,uuid[],text)',
    'execute'
  ) as authenticated_can_call_guarded_approval_should_be_true,
  has_table_privilege(
    'authenticated',
    'public.payroll_schedule_snapshots',
    'insert'
  ) as authenticated_can_insert_snapshots_should_be_false,
  has_table_privilege(
    'authenticated',
    'public.payroll_periods',
    'insert'
  ) as authenticated_can_insert_periods_should_be_false;

-- 3. Blockers: every query below must return zero rows.

-- Payment dates cannot be after cutoff.
select
  id,
  period_start,
  period_end,
  payment_date
from public.payroll_periods
where payment_date > period_end;

-- More-than-standard early payment must have complete override evidence.
select
  id,
  early_payment_days,
  early_payment_window_days,
  early_payment_override_reason,
  early_payment_override_by,
  early_payment_override_at
from public.payroll_periods
where early_payment_days > early_payment_window_days
  and (
    nullif(trim(early_payment_override_reason), '') is null
    or early_payment_override_by is null
    or early_payment_override_at is null
  );

-- Standard-window periods must not contain unnecessary override evidence.
select
  id,
  early_payment_days,
  early_payment_window_days
from public.payroll_periods
where early_payment_days <= early_payment_window_days
  and (
    early_payment_override_reason is not null
    or early_payment_override_by is not null
    or early_payment_override_at is not null
  );

-- Approved pre-plots must be after payment, within cutoff, and belong to the
-- same employee and payroll record.
select
  snapshot.id,
  snapshot.payroll_record_id,
  snapshot.employee_id,
  snapshot.schedule_id,
  snapshot.work_date
from public.payroll_schedule_snapshots as snapshot
join public.payroll_records as record
  on record.id = snapshot.payroll_record_id
join public.payroll_periods as period
  on period.id = record.payroll_period_id
where snapshot.employee_id <> record.employee_id
   or snapshot.work_date <= period.payment_date
   or snapshot.work_date > period.period_end;

-- Pre-plots may never represent rest days, holidays, incomplete times, or
-- unsupported schedule states.
select
  id,
  schedule_id,
  work_date,
  schedule_status,
  is_rest_day,
  is_holiday,
  shift_start,
  shift_end
from public.payroll_schedule_snapshots
where is_rest_day
   or is_holiday
   or schedule_status not in ('published', 'changed')
   or shift_start is null
   or shift_end is null
   or shift_end <= shift_start
   or scheduled_minutes <= 0;

-- A snapshot that claims the current source version must match trusted source
-- identity and scheduling values exactly.
select
  snapshot.id,
  snapshot.schedule_id,
  snapshot.schedule_version
from public.payroll_schedule_snapshots as snapshot
join public.work_schedules as schedule
  on schedule.id = snapshot.schedule_id
 and schedule.schedule_version = snapshot.schedule_version
where snapshot.employee_id <> schedule.user_id
   or snapshot.work_date <> schedule.shift_date
   or snapshot.shift_start is distinct from schedule.shift_start
   or snapshot.shift_end is distinct from schedule.shift_end
   or snapshot.timezone <> schedule.timezone
   or snapshot.schedule_status <> schedule.status
   or snapshot.is_rest_day <> schedule.is_rest_day
   or snapshot.is_holiday <> schedule.is_holiday
   or snapshot.holiday_name is distinct from schedule.holiday_name
   or snapshot.schedule_updated_at <> schedule.updated_at;

-- Attendance may be recorded later as intended, but it must not have existed
-- before the explicit pre-plot approval.
select
  snapshot.id,
  snapshot.schedule_id,
  snapshot.approved_at,
  attendance_row.created_at as attendance_created_at
from public.payroll_schedule_snapshots as snapshot
join public.attendance as attendance_row
  on attendance_row.user_id = snapshot.employee_id
 and attendance_row.schedule_id = snapshot.schedule_id
where attendance_row.created_at <= snapshot.approved_at;

-- 4. Informational rollout evidence.
select
  count(*) as payroll_period_count,
  count(*) filter (where early_payment_days > 0) as early_period_count,
  count(*) filter (
    where early_payment_override_reason is not null
  ) as overridden_period_count
from public.payroll_periods;

select
  count(*) as approved_preplot_snapshot_count,
  count(distinct payroll_record_id) as payroll_record_count,
  coalesce(sum(scheduled_minutes), 0) as approved_preplot_minutes
from public.payroll_schedule_snapshots;

select
  count(*) as preplot_approval_audit_count
from public.payroll_audit_logs
where action = 'payroll_preplots_approved';
