-- Phase 1, Step 9 verification: trusted attendance calculations.
-- Run after 2026070901_attendance_structured_calculation.sql.
--
-- Every blocker query in section 5 must return zero rows.

-- 1. Required functions and signatures.
select
  routine_name,
  routine_type,
  security_type,
  data_type
from information_schema.routines
where specific_schema = 'public'
  and routine_name in (
    'workforce_calculate_attendance',
    'workforce_recalculate_attendance',
    'workforce_recalculate_attendance_work_date',
    'workforce_clock_in',
    'workforce_clock_out'
  )
order by routine_name;

-- Expected: five function rows.

-- 2. Calculator examples.
select *
from public.workforce_calculate_attendance(
  '2026-07-09 09:00:00-04'::timestamptz,
  '2026-07-09 17:00:00-04'::timestamptz,
  '2026-07-09 07:00:00-04'::timestamptz,
  '2026-07-09 18:00:00-04'::timestamptz,
  '2026-07-09'::date,
  'America/New_York',
  1200
);
-- Expected: pre 120, regular 480, post 60, overtime 180,
-- worked 660, late 0, undertime 0.

select *
from public.workforce_calculate_attendance(
  '2026-07-09 09:00:00-04'::timestamptz,
  '2026-07-09 17:00:00-04'::timestamptz,
  '2026-07-09 09:30:00-04'::timestamptz,
  '2026-07-09 16:30:00-04'::timestamptz,
  '2026-07-09'::date,
  'America/New_York',
  1200
);
-- Expected: pre 0, regular 420, post 0, overtime 0,
-- worked 420, late 30, undertime 30.

select *
from public.workforce_calculate_attendance(
  '2026-07-09 22:00:00-04'::timestamptz,
  '2026-07-10 06:00:00-04'::timestamptz,
  '2026-07-09 21:00:00-04'::timestamptz,
  '2026-07-10 07:00:00-04'::timestamptz,
  '2026-07-09'::date,
  'America/New_York',
  90
);
-- Expected: pre 60, regular 480, post 30, overtime 90,
-- worked 600, late 0, undertime 0.

-- 3. Database enforcement.
select indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename = 'attendance'
  and indexname = 'attendance_one_open_session_per_user_idx';

select
  conname,
  convalidated,
  pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.attendance'::regclass
  and conname = 'attendance_structured_totals_check';

-- Expected: one unique partial index and one validated constraint.

-- 4. Function privileges. Internal calculation functions must not be callable
-- directly by anonymous or ordinary authenticated clients.
select
  has_function_privilege(
    'anon',
    'public.workforce_calculate_attendance(timestamptz,timestamptz,timestamptz,timestamptz,date,text,integer)',
    'EXECUTE'
  ) as anon_can_calculate,
  has_function_privilege(
    'authenticated',
    'public.workforce_calculate_attendance(timestamptz,timestamptz,timestamptz,timestamptz,date,text,integer)',
    'EXECUTE'
  ) as authenticated_can_calculate,
  has_function_privilege(
    'anon',
    'public.workforce_recalculate_attendance(uuid)',
    'EXECUTE'
  ) as anon_can_recalculate,
  has_function_privilege(
    'authenticated',
    'public.workforce_recalculate_attendance(uuid)',
    'EXECUTE'
  ) as authenticated_can_recalculate,
  has_function_privilege(
    'authenticated',
    'public.workforce_clock_in(uuid)',
    'EXECUTE'
  ) as authenticated_can_clock_in,
  has_function_privilege(
    'authenticated',
    'public.workforce_clock_out()',
    'EXECUTE'
  ) as authenticated_can_clock_out;

-- Expected: first four false; final two true.

-- 5. Blocker checks. Every query below must return zero rows.

-- More than one open session for an employee.
select user_id, count(*) as open_sessions
from public.attendance
where clock_in is not null
  and clock_out is null
group by user_id
having count(*) > 1;

-- Aggregate credited overtime above 20 hours on one scheduled work date.
select
  user_id,
  work_date,
  sum(total_overtime_minutes) as overtime_minutes
from public.attendance
group by user_id, work_date
having sum(total_overtime_minutes) > 1200;

-- Schedule work date or employee mismatch.
select
  attendance_row.id,
  attendance_row.user_id,
  attendance_row.work_date,
  schedule.user_id as schedule_user_id,
  schedule.shift_date
from public.attendance attendance_row
join public.work_schedules schedule
  on schedule.id = attendance_row.schedule_id
where attendance_row.user_id <> schedule.user_id
   or attendance_row.work_date <> schedule.shift_date;

-- Completed scheduled attendance still missing structured calculations.
select
  attendance_row.id,
  attendance_row.work_date,
  attendance_row.schedule_id
from public.attendance attendance_row
where attendance_row.schedule_id is not null
  and attendance_row.clock_in is not null
  and attendance_row.clock_out is not null
  and (
    attendance_row.pre_shift_overtime_minutes is null
    or attendance_row.regular_minutes is null
    or attendance_row.post_shift_overtime_minutes is null
  );

-- Structured totals are internally inconsistent.
select
  attendance_row.id,
  attendance_row.pre_shift_overtime_minutes,
  attendance_row.regular_minutes,
  attendance_row.post_shift_overtime_minutes,
  attendance_row.total_overtime_minutes,
  attendance_row.total_worked_minutes
from public.attendance attendance_row
where attendance_row.pre_shift_overtime_minutes is not null
  and (
    attendance_row.regular_minutes is null
    or attendance_row.post_shift_overtime_minutes is null
    or attendance_row.total_overtime_minutes <>
      attendance_row.pre_shift_overtime_minutes
      + attendance_row.post_shift_overtime_minutes
    or attendance_row.total_overtime_minutes > 1200
    or (
      attendance_row.clock_out is not null
      and attendance_row.total_worked_minutes <
        attendance_row.pre_shift_overtime_minutes
        + attendance_row.regular_minutes
        + attendance_row.post_shift_overtime_minutes
    )
  );

-- Attendance records assigned to overlapping scheduled shifts.
select
  first_attendance.id as first_attendance_id,
  second_attendance.id as second_attendance_id,
  first_attendance.user_id,
  first_attendance.work_date
from public.attendance first_attendance
join public.work_schedules first_schedule
  on first_schedule.id = first_attendance.schedule_id
join public.attendance second_attendance
  on second_attendance.user_id = first_attendance.user_id
 and second_attendance.work_date = first_attendance.work_date
 and second_attendance.id > first_attendance.id
join public.work_schedules second_schedule
  on second_schedule.id = second_attendance.schedule_id
where first_schedule.shift_start < second_schedule.shift_end
  and second_schedule.shift_start < first_schedule.shift_end;

-- 6. Confirm clock RPCs delegate to the trusted recalculator.
select
  routine_name,
  routine_definition
from information_schema.routines
where specific_schema = 'public'
  and routine_name in ('workforce_clock_in', 'workforce_clock_out')
order by routine_name;

-- Both definitions must call workforce_recalculate_attendance.

-- 7. Migration audit marker.
select
  action,
  entity_type,
  after_data,
  reason,
  created_at
from public.workforce_audit_logs
where action = 'attendance_structured_calculation_enabled'
order by created_at desc
limit 1;
