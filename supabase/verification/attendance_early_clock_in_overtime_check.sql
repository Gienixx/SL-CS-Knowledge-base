-- Verify the attendance timing, overtime, overnight, and multi-shift policy.
-- Run after migrations through 2026070805_attendance_overnight_multi_shift.sql.

-- 1. Required attendance RPCs must exist.
select
  to_regprocedure('public.workforce_clock_in(uuid)') as clock_in_function,
  to_regprocedure('public.workforce_clock_out()') as clock_out_function;

-- 2. Confirm the installed clock-in function contains the 15-minute gate,
-- early overtime, previous-date overnight handling, and one-open-shift guard.
-- All columns must return true.
select
  position('interval ''15 minutes''' in pg_get_functiondef('public.workforce_clock_in(uuid)'::regprocedure)) > 0
    as has_fifteen_minute_window,
  position('v_early_overtime_minutes' in pg_get_functiondef('public.workforce_clock_in(uuid)'::regprocedure)) > 0
    as records_early_overtime,
  position('schedule.shift_date = v_local_date - 1' in pg_get_functiondef('public.workforce_clock_in(uuid)'::regprocedure)) > 0
    as supports_active_previous_date_shift,
  position('You are already clocked in to another shift' in pg_get_functiondef('public.workforce_clock_in(uuid)'::regprocedure)) > 0
    as prevents_parallel_open_shifts;

-- 3. Confirm clock-out combines early and post-shift overtime. Must return true.
select
  position(
    'v_early_overtime_minutes + v_post_shift_overtime_minutes'
    in pg_get_functiondef('public.workforce_clock_out()'::regprocedure)
  ) > 0 as combines_overtime_components;

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

-- 7. Confirm the attendance rollout audit entries exist.
select action, entity_type, after_data, created_at
from public.workforce_audit_logs
where action in (
  'attendance_early_clock_in_policy_enabled',
  'attendance_released_schedule_enforcement_enabled',
  'attendance_overnight_multi_shift_enabled'
)
order by created_at desc;
