-- Verify the attendance timing, overtime, overnight, and multi-shift policy.
-- Run after migrations through
-- 2026070806_attendance_unrestricted_pre_shift_overtime_cap.sql.

-- 1. Required attendance RPCs must exist.
select
  to_regprocedure('public.workforce_clock_in(uuid)') as clock_in_function,
  to_regprocedure('public.workforce_clock_out()') as clock_out_function;

-- 2. Confirm the installed clock-in function has no 15-minute lower bound,
-- records pre-shift overtime, supports relevant overnight shifts, serializes
-- attendance actions, and applies the 1,200-minute work-date limit.
-- All columns must return true.
select
  position(
    'interval ''15 minutes'''
    in pg_get_functiondef('public.workforce_clock_in(uuid)'::regprocedure)
  ) = 0 as fifteen_minute_gate_removed,
  position(
    'v_raw_pre_shift_overtime_minutes'
    in pg_get_functiondef('public.workforce_clock_in(uuid)'::regprocedure)
  ) > 0 as records_pre_shift_overtime,
  position(
    'schedule.shift_date between v_local_date - 1 and v_local_date + 1'
    in pg_get_functiondef('public.workforce_clock_in(uuid)'::regprocedure)
  ) > 0 as supports_relevant_attendance_date_range,
  position(
    'pg_advisory_xact_lock'
    in pg_get_functiondef('public.workforce_clock_in(uuid)'::regprocedure)
  ) > 0 as serializes_clock_in_requests,
  position(
    'v_max_overtime_minutes constant integer := 1200'
    in pg_get_functiondef('public.workforce_clock_in(uuid)'::regprocedure)
  ) > 0 as has_twenty_hour_overtime_limit,
  position(
    'v_max_overtime_minutes - v_other_overtime_minutes'
    in pg_get_functiondef('public.workforce_clock_in(uuid)'::regprocedure)
  ) > 0 as aggregates_existing_work_date_overtime,
  position(
    'You are already clocked in to another shift'
    in pg_get_functiondef('public.workforce_clock_in(uuid)'::regprocedure)
  ) > 0 as prevents_parallel_open_shifts;

-- 3. Confirm clock-out combines pre-shift and post-shift overtime, preserves
-- clock-out after the cap is reached, and caps credited overtime against other
-- attendance records on the same work date. All columns must return true.
select
  position(
    'v_pre_shift_overtime_minutes + v_post_shift_overtime_minutes'
    in pg_get_functiondef('public.workforce_clock_out()'::regprocedure)
  ) > 0 as combines_overtime_components,
  position(
    'attendance_row.work_date = v_existing.work_date'
    in pg_get_functiondef('public.workforce_clock_out()'::regprocedure)
  ) > 0 as aggregates_overtime_by_work_date,
  position(
    'v_credited_overtime_minutes := least'
    in pg_get_functiondef('public.workforce_clock_out()'::regprocedure)
  ) > 0 as caps_credited_overtime,
  position(
    'Clock-out cannot be earlier than clock-in'
    in pg_get_functiondef('public.workforce_clock_out()'::regprocedure)
  ) > 0 as rejects_negative_attendance_duration;

-- 4. The obsolete one-record-per-date constraint must be removed, and the new
-- partial uniqueness indexes must exist.
select
  not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.attendance'::regclass
      and conname = 'attendance_user_work_date_unique'
  ) as old_daily_unique_removed,
  to_regclass('public.attendance_user_schedule_unique') is not null
    as scheduled_shift_unique_index_exists,
  to_regclass('public.attendance_user_unscheduled_date_unique') is not null
    as unscheduled_date_unique_index_exists;

-- 5. Released schedules with missing start or end times block reliable attendance
-- calculations. Must return 0 rows.
select
  schedule.id,
  schedule.user_id,
  schedule.shift_date,
  schedule.status,
  schedule.shift_start,
  schedule.shift_end
from public.work_schedules schedule
where schedule.status in ('published', 'changed')
  and schedule.is_rest_day is false
  and (schedule.shift_start is null or schedule.shift_end is null);

-- 6. No user should have more than one open attendance row. Must return 0 rows.
select
  attendance_row.user_id,
  count(*) as open_record_count
from public.attendance attendance_row
where attendance_row.clock_in is not null
  and attendance_row.clock_out is null
group by attendance_row.user_id
having count(*) > 1;

-- 7. Credited overtime must not exceed 1,200 minutes per employee/work date.
-- Must return 0 rows.
select
  attendance_row.user_id,
  attendance_row.work_date,
  sum(greatest(coalesce(attendance_row.overtime_minutes, 0), 0)) as credited_overtime_minutes
from public.attendance attendance_row
group by attendance_row.user_id, attendance_row.work_date
having sum(greatest(coalesce(attendance_row.overtime_minutes, 0), 0)) > 1200;

-- 8. Confirm the attendance rollout audit entries exist.
select action, entity_type, after_data, created_at
from public.workforce_audit_logs
where action in (
  'attendance_early_clock_in_policy_enabled',
  'attendance_released_schedule_enforcement_enabled',
  'attendance_overnight_multi_shift_enabled',
  'attendance_unrestricted_pre_shift_overtime_enabled'
)
order by created_at desc;
