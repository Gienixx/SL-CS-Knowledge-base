-- Verify the 15-minute early clock-in and combined overtime policy.
-- Run after 2026070803_attendance_early_clock_in_overtime.sql.

-- 1. Required attendance RPCs must exist.
select
  to_regprocedure('public.workforce_clock_in(uuid)') as clock_in_function,
  to_regprocedure('public.workforce_clock_out()') as clock_out_function;

-- 2. Confirm the installed clock-in function contains the 15-minute gate and
-- pre-shift overtime calculation. Both columns must return true.
select
  position('interval ''15 minutes''' in pg_get_functiondef('public.workforce_clock_in(uuid)'::regprocedure)) > 0
    as has_fifteen_minute_window,
  position('v_early_overtime_minutes' in pg_get_functiondef('public.workforce_clock_in(uuid)'::regprocedure)) > 0
    as records_early_overtime;

-- 3. Confirm clock-out combines early and post-shift overtime. Must return true.
select
  position(
    'v_early_overtime_minutes + v_post_shift_overtime_minutes'
    in pg_get_functiondef('public.workforce_clock_out()'::regprocedure)
  ) > 0 as combines_overtime_components;

-- 4. Released schedules with missing start or end times block reliable attendance
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

-- 5. Confirm the migration audit entry exists.
select action, entity_type, after_data, created_at
from public.workforce_audit_logs
where action = 'attendance_early_clock_in_policy_enabled'
order by created_at desc
limit 5;
