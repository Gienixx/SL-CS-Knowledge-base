-- Run after deployment. Every boolean must be true.
select
  to_regprocedure(
    'public.workforce_correct_attendance(uuid,timestamp with time zone,timestamp with time zone,text,uuid,text,text,text)'
  ) is not null as correction_function_exists,
  position(
    'workforce_recalculate_attendance' in pg_get_functiondef(
      'public.workforce_correct_attendance(uuid,timestamp with time zone,timestamp with time zone,text,uuid,text,text,text)'::regprocedure
    )
  ) > 0 as uses_canonical_recalculation,
  has_function_privilege(
    'authenticated',
    'public.workforce_correct_attendance(uuid,timestamp with time zone,timestamp with time zone,text,uuid,text,text,text)',
    'execute'
  ) as authenticated_can_execute,
  not has_function_privilege(
    'anon',
    'public.workforce_correct_attendance(uuid,timestamp with time zone,timestamp with time zone,text,uuid,text,text,text)',
    'execute'
  ) as anon_cannot_execute;

-- Reproduce the corrected unscheduled interval without modifying attendance.
-- The canonical calculator must classify it wholly as RDOT and satisfy the
-- same structured-total relationship enforced on public.attendance.
with calculation as (
  select *
  from public.workforce_calculate_attendance(
    null,
    null,
    '2026-07-13 04:52:00-04'::timestamptz,
    '2026-07-13 19:03:00-04'::timestamptz,
    '2026-07-13'::date,
    'America/New_York',
    1200,
    true,
    false
  )
)
select
  regular_minutes = 0 as no_regular_minutes,
  pre_shift_overtime_minutes = 0 as no_pre_shift_overtime,
  post_shift_overtime_minutes = 0 as no_post_shift_overtime,
  holiday_overtime_minutes = 0 as no_holiday_overtime,
  rest_day_overtime_minutes = total_overtime_minutes as all_overtime_is_rdot,
  total_worked_minutes >= regular_minutes + total_overtime_minutes as totals_satisfy_constraint
from calculation;
