-- Phase 2 Step 6 payroll attendance import verification.
-- Every blocker query in section 3 must return zero rows.

-- 1. Required column, functions, triggers, and versioned uniqueness.
select
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'attendance'
      and column_name = 'attendance_version'
      and is_nullable = 'NO'
  ) as attendance_version_exists,
  to_regprocedure('public.payroll_import_attendance(uuid)') is not null
    as import_rpc_exists,
  to_regprocedure(
    'public.payroll_get_period_attendance_import_status(uuid)'
  ) is not null as import_status_rpc_exists,
  exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.attendance'::regclass
      and tgname = 'attendance_increment_version'
      and tgenabled = 'O'
  ) as attendance_version_trigger_enabled_should_be_true,
  exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.attendance'::regclass
      and tgname = 'attendance_flag_payroll_recalculation'
      and tgenabled = 'O'
  ) as attendance_recalculation_trigger_enabled_should_be_true,
  exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.payroll_attendance_snapshots'::regclass
      and tgname = 'payroll_attendance_snapshots_immutable'
      and tgenabled = 'O'
  ) as snapshot_mutation_trigger_enabled_should_be_true;

-- 2. Browser access remains RPC-only.
select
  has_table_privilege(
    'authenticated',
    'public.payroll_attendance_snapshots',
    'insert'
  ) as authenticated_can_insert_snapshots_should_be_false,
  has_table_privilege(
    'authenticated',
    'public.payroll_attendance_snapshots',
    'update'
  ) as authenticated_can_update_snapshots_should_be_false,
  has_function_privilege(
    'anon',
    'public.payroll_import_attendance(uuid)',
    'execute'
  ) as anon_can_import_attendance_should_be_false,
  has_function_privilege(
    'authenticated',
    'public.payroll_import_attendance(uuid)',
    'execute'
  ) as authenticated_can_call_import_rpc_should_be_true;

-- 3. Blockers: zero rows required.
select id, attendance_version
from public.attendance
where attendance_version <= 0;

select
  snapshot.id,
  snapshot.payroll_record_id,
  snapshot.attendance_id,
  snapshot.attendance_version
from public.payroll_attendance_snapshots as snapshot
join public.attendance as attendance_row
  on attendance_row.id = snapshot.attendance_id
join public.payroll_records as record
  on record.id = snapshot.payroll_record_id
join public.payroll_periods as period
  on period.id = record.payroll_period_id
where snapshot.attendance_version < attendance_row.attendance_version
  and period.status not in ('finalized', 'void')
  and record.status not in ('finalized', 'void')
  and record.requires_recalculation is false;
-- unflagged_changed_attendance_should_be_empty

select
  snapshot.id,
  snapshot.payroll_record_id,
  snapshot.attendance_id
from public.payroll_attendance_snapshots as snapshot
join public.payroll_records as record
  on record.id = snapshot.payroll_record_id
join public.payroll_periods as period
  on period.id = record.payroll_period_id
left join public.attendance as attendance_row
  on attendance_row.id = snapshot.attendance_id
left join public.work_schedules as schedule
  on schedule.id = snapshot.schedule_id
where snapshot.employee_id <> record.employee_id
   or snapshot.work_date < period.period_start
   or snapshot.work_date > period.period_end
   or attendance_row.id is null
   or schedule.id is null;

-- 4. Import and change audit evidence.
select
  audit.payroll_period_id,
  audit.actor_user_id,
  audit.created_at,
  audit.metadata
from public.payroll_audit_logs as audit
where audit.action = 'payroll_attendance_imported'
order by audit.created_at desc;

select
  audit.payroll_record_id,
  audit.actor_user_id,
  audit.created_at,
  audit.metadata
from public.payroll_audit_logs as audit
where audit.action = 'payroll_attendance_changed_after_import'
order by audit.created_at desc;
