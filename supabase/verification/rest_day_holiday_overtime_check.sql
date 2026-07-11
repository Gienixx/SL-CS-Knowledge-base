-- Rest-day and holiday overtime verification.
-- Run only after:
--   1. supabase/maintenance/rest_day_holiday_overtime_preflight.sql
--   2. supabase/migrations-legacy/2026070906_rest_day_holiday_overtime.sql

-- ---------------------------------------------------------------------------
-- 1. Required attendance columns
-- ---------------------------------------------------------------------------

select
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'attendance'
      and column_name = 'rest_day_overtime_minutes'
      and data_type = 'integer'
  ) as rest_day_overtime_column_exists,
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'attendance'
      and column_name = 'holiday_overtime_minutes'
      and data_type = 'integer'
  ) as holiday_overtime_column_exists;

-- ---------------------------------------------------------------------------
-- 2. Required calculation and clock-in rules
-- ---------------------------------------------------------------------------

select
  to_regprocedure(
    'public.workforce_calculate_attendance(timestamptz,timestamptz,timestamptz,timestamptz,date,text,integer,boolean,boolean)'
  ) is not null as special_day_calculator_exists,
  to_regprocedure('public.workforce_clock_in(uuid)') is not null
    as clock_in_function_exists;

with function_oids as (
  select
    to_regprocedure(
      'public.workforce_calculate_attendance(timestamptz,timestamptz,timestamptz,timestamptz,date,text,integer,boolean,boolean)'
    ) as calculator_oid,
    to_regprocedure('public.workforce_clock_in(uuid)') as clock_in_oid
), definitions as (
  select
    case
      when calculator_oid is null then null
      else pg_get_functiondef(calculator_oid)
    end as calculator_definition,
    case
      when clock_in_oid is null then null
      else pg_get_functiondef(clock_in_oid)
    end as clock_in_definition
  from function_oids
)
select
  calculator_definition is not null
    as calculator_definition_available,
  position('rest_day_overtime_minutes := v_credited_special_minutes' in coalesce(calculator_definition, '')) > 0
    as rest_day_minutes_are_rdot,
  position('holiday_overtime_minutes := v_credited_special_minutes' in coalesce(calculator_definition, '')) > 0
    as holiday_minutes_are_overtime,
  position('if coalesce(p_is_rest_day, false) then' in coalesce(calculator_definition, '')) > 0
    as rest_day_precedence_exists,
  position('v_schedule.is_rest_day or v_schedule.is_holiday' in coalesce(clock_in_definition, '')) > 0
    as special_day_clock_in_is_allowed,
  position('Rest-day and holiday clock-in is available only on the scheduled work date.' in coalesce(clock_in_definition, '')) > 0
    as special_day_date_boundary_exists
from definitions;

-- Stop with an explicit deployment message instead of an ambiguous regprocedure
-- cast failure when the migration was not applied or rolled back.
do $$
begin
  if to_regprocedure(
    'public.workforce_calculate_attendance(timestamptz,timestamptz,timestamptz,timestamptz,date,text,integer,boolean,boolean)'
  ) is null then
    raise exception
      'Special-day attendance calculator is missing. Run the preflight and apply 2026070906_rest_day_holiday_overtime.sql successfully before verification.';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Direct calculator examples
-- ---------------------------------------------------------------------------

-- Rest day: all 480 minutes must be RDOT.
select *
from public.workforce_calculate_attendance(
  null,
  null,
  '2026-07-12 09:00:00+00'::timestamptz,
  '2026-07-12 17:00:00+00'::timestamptz,
  '2026-07-12'::date,
  'UTC',
  1200,
  true,
  false
);

-- Holiday: all 480 minutes must be normal holiday overtime, not RDOT.
select *
from public.workforce_calculate_attendance(
  '2026-07-13 09:00:00+00'::timestamptz,
  '2026-07-13 17:00:00+00'::timestamptz,
  '2026-07-13 09:00:00+00'::timestamptz,
  '2026-07-13 17:00:00+00'::timestamptz,
  '2026-07-13'::date,
  'UTC',
  1200,
  false,
  true
);

-- Rest day plus holiday: all 480 minutes must be RDOT and holiday OT must be zero.
select *
from public.workforce_calculate_attendance(
  null,
  null,
  '2026-07-14 09:00:00+00'::timestamptz,
  '2026-07-14 17:00:00+00'::timestamptz,
  '2026-07-14'::date,
  'UTC',
  1200,
  true,
  true
);

-- Overtime cap: only 60 of 480 worked minutes remain available.
select *
from public.workforce_calculate_attendance(
  null,
  null,
  '2026-07-15 09:00:00+00'::timestamptz,
  '2026-07-15 17:00:00+00'::timestamptz,
  '2026-07-15'::date,
  'UTC',
  60,
  true,
  false
);

-- ---------------------------------------------------------------------------
-- 4. Privilege boundary
-- ---------------------------------------------------------------------------

select
  has_function_privilege('authenticated', 'public.workforce_clock_in(uuid)', 'EXECUTE')
    as authenticated_can_clock_in,
  has_function_privilege(
    'authenticated',
    to_regprocedure(
      'public.workforce_calculate_attendance(timestamptz,timestamptz,timestamptz,timestamptz,date,text,integer,boolean,boolean)'
    ),
    'EXECUTE'
  ) as browser_can_call_internal_calculator_should_be_false;

-- ---------------------------------------------------------------------------
-- 5. Blocker queries
-- Every blocker query in section 5 must return zero rows.
-- ---------------------------------------------------------------------------

-- No negative special-day minute values.
select id, user_id, work_date
from public.attendance
where rest_day_overtime_minutes < 0
   or holiday_overtime_minutes < 0;

-- The same minute must not be classified as both RDOT and holiday OT.
select id, user_id, work_date
from public.attendance
where rest_day_overtime_minutes > 0
  and holiday_overtime_minutes > 0;

-- Total overtime must equal all overtime components.
select id, user_id, work_date
from public.attendance
where pre_shift_overtime_minutes is not null
  and total_overtime_minutes <>
    pre_shift_overtime_minutes
    + post_shift_overtime_minutes
    + rest_day_overtime_minutes
    + holiday_overtime_minutes;

-- The aggregate overtime limit must remain within 1,200 minutes per work date.
select user_id, work_date, sum(total_overtime_minutes) as overtime_minutes
from public.attendance
group by user_id, work_date
having sum(total_overtime_minutes) > 1200;

-- Completed attendance linked to a rest-day schedule must be classified as RDOT.
select attendance_row.id, attendance_row.user_id, attendance_row.work_date
from public.attendance attendance_row
join public.work_schedules schedule
  on schedule.id = attendance_row.schedule_id
where schedule.is_rest_day is true
  and attendance_row.clock_in is not null
  and attendance_row.clock_out is not null
  and attendance_row.total_worked_minutes > 0
  and attendance_row.rest_day_overtime_minutes = 0;

-- Completed holiday-only attendance must be classified as holiday overtime.
select attendance_row.id, attendance_row.user_id, attendance_row.work_date
from public.attendance attendance_row
join public.work_schedules schedule
  on schedule.id = attendance_row.schedule_id
where schedule.is_holiday is true
  and schedule.is_rest_day is false
  and attendance_row.clock_in is not null
  and attendance_row.clock_out is not null
  and attendance_row.total_worked_minutes > 0
  and attendance_row.holiday_overtime_minutes = 0;
