-- Revised Phase 2 Step 1 verification.
-- Every *_should_be_true value must be true.
-- Every blocker query in section 5 must return zero rows.

-- 1. Required tables, RLS, and schedule source version.
select
  to_regclass('public.payroll_schedule_snapshots') is not null
    as schedule_snapshots_table_should_be_true,
  to_regclass('public.payroll_prepaid_hours') is not null
    as prepaid_hours_table_should_be_true,
  to_regclass('public.payroll_hour_allocations') is not null
    as hour_allocations_table_should_be_true,
  exists (
    select 1
    from pg_attribute
    where attrelid = 'public.work_schedules'::regclass
      and attname = 'schedule_version'
      and not attisdropped
  ) as schedule_version_column_should_be_true;

select
  relname,
  relrowsecurity as rls_enabled_should_be_true
from pg_class
where oid in (
  'public.payroll_schedule_snapshots'::regclass,
  'public.payroll_prepaid_hours'::regclass,
  'public.payroll_hour_allocations'::regclass
)
order by relname;

-- 2. Required constraints and generated balance fields.
select
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.payroll_schedule_snapshots'::regclass
      and conname = 'payroll_schedule_snapshots_record_employee_fkey'
  ) as schedule_employee_fk_should_be_true,
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.payroll_prepaid_hours'::regclass
      and conname = 'payroll_prepaid_hours_source_fkey'
  ) as prepaid_source_fk_should_be_true,
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.payroll_hour_allocations'::regclass
      and conname = 'payroll_hour_allocations_attendance_record_employee_fkey'
  ) as allocation_employee_fk_should_be_true,
  exists (
    select 1
    from pg_attribute
    where attrelid = 'public.payroll_prepaid_hours'::regclass
      and attname = 'remaining_minutes'
      and attgenerated = 's'
  ) as remaining_minutes_generated_should_be_true,
  exists (
    select 1
    from pg_attribute
    where attrelid = 'public.payroll_prepaid_hours'::regclass
      and attname = 'status'
      and attgenerated = 's'
  ) as prepaid_status_generated_should_be_true;

-- 3. Browser access is read-only and payroll-policy scoped.
select
  has_table_privilege(
    'authenticated',
    'public.payroll_schedule_snapshots',
    'SELECT'
  ) as authenticated_schedule_select_should_be_true,
  has_table_privilege(
    'authenticated',
    'public.payroll_prepaid_hours',
    'SELECT'
  ) as authenticated_prepaid_select_should_be_true,
  has_table_privilege(
    'authenticated',
    'public.payroll_hour_allocations',
    'SELECT'
  ) as authenticated_allocation_select_should_be_true,
  not has_table_privilege(
    'authenticated',
    'public.payroll_schedule_snapshots',
    'INSERT, UPDATE, DELETE'
  ) as authenticated_schedule_write_blocked_should_be_true,
  not has_table_privilege(
    'authenticated',
    'public.payroll_prepaid_hours',
    'INSERT, UPDATE, DELETE'
  ) as authenticated_prepaid_write_blocked_should_be_true,
  not has_table_privilege(
    'authenticated',
    'public.payroll_hour_allocations',
    'INSERT, UPDATE, DELETE'
  ) as authenticated_allocation_write_blocked_should_be_true,
  not has_table_privilege(
    'anon',
    'public.payroll_schedule_snapshots',
    'SELECT, INSERT, UPDATE, DELETE'
  ) as anon_schedule_access_blocked_should_be_true,
  not has_table_privilege(
    'anon',
    'public.payroll_prepaid_hours',
    'SELECT, INSERT, UPDATE, DELETE'
  ) as anon_prepaid_access_blocked_should_be_true,
  not has_table_privilege(
    'anon',
    'public.payroll_hour_allocations',
    'SELECT, INSERT, UPDATE, DELETE'
  ) as anon_allocation_access_blocked_should_be_true;

select
  tablename,
  policyname,
  roles,
  cmd
from pg_policies
where schemaname = 'public'
  and tablename in (
    'payroll_schedule_snapshots',
    'payroll_prepaid_hours',
    'payroll_hour_allocations'
  )
order by tablename, policyname;

-- 4. Versioning and immutable-history triggers are enabled.
select
  exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.work_schedules'::regclass
      and tgname = 'work_schedules_increment_version'
      and tgenabled <> 'D'
  ) as schedule_version_trigger_enabled_should_be_true,
  exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.payroll_attendance_snapshots'::regclass
      and tgname = 'payroll_attendance_snapshot_capture_special_details'
      and tgenabled <> 'D'
  ) as special_detail_trigger_enabled_should_be_true,
  exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.payroll_schedule_snapshots'::regclass
      and tgname = 'payroll_schedule_snapshots_immutable'
      and tgenabled <> 'D'
  ) as schedule_snapshot_immutable_should_be_true,
  exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.payroll_hour_allocations'::regclass
      and tgname = 'payroll_hour_allocations_immutable'
      and tgenabled <> 'D'
  ) as allocation_immutable_should_be_true,
  exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.payroll_prepaid_hours'::regclass
      and tgname = 'payroll_prepaid_hours_guard'
      and tgenabled <> 'D'
  ) as prepaid_guard_should_be_true;

-- 5. Data-integrity blockers. Every query must return zero rows.
select
  snapshot.id,
  snapshot.attendance_id,
  snapshot.attendance_version
from public.payroll_attendance_snapshots as snapshot
join public.attendance as attendance_row
  on attendance_row.id = snapshot.attendance_id
 and attendance_row.attendance_version = snapshot.attendance_version
where snapshot.special_day_type = 'unknown';

select *
from public.payroll_schedule_snapshots
where scheduled_minutes < 0
   or (is_rest_day and scheduled_minutes <> 0)
   or (not is_rest_day and scheduled_minutes <= 0);

select *
from public.payroll_prepaid_hours
where remaining_minutes <> prepaid_minutes - settled_minutes
   or remaining_minutes < 0;

select *
from public.payroll_hour_allocations
where minute_category not in (
    'regular',
    'pre_shift_overtime',
    'post_shift_overtime'
  )
   or allocated_minutes <= 0;

-- 6. Current row counts for operational reference.
select
  (select count(*) from public.payroll_schedule_snapshots)
    as schedule_snapshot_count,
  (select count(*) from public.payroll_prepaid_hours)
    as prepaid_balance_count,
  (select count(*) from public.payroll_hour_allocations)
    as allocation_count,
  (
    select count(*)
    from public.payroll_attendance_snapshots
    where special_day_type = 'unknown'
  ) as unknown_special_snapshot_count;
