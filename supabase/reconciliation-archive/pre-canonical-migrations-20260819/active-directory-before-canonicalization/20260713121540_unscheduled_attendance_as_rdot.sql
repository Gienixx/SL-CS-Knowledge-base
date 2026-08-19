-- Treat attendance recorded without an assigned released shift as rest-day
-- overtime. A published or changed schedule must still be selected when one
-- exists; workforce_clock_in already enforces that boundary.

begin;

create or replace function public.workforce_recalculate_attendance(
  p_attendance_id uuid
)
returns public.attendance
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
  v_attendance public.attendance%rowtype;
  v_schedule public.work_schedules%rowtype;
  v_other_overtime_minutes integer := 0;
  v_available_overtime_minutes integer := 1200;
  v_calculation record;
  v_result public.attendance%rowtype;
  v_is_special_day boolean := false;
begin
  if p_attendance_id is null then
    raise exception 'Attendance record is required.';
  end if;

  select attendance_row.user_id
  into v_user_id
  from public.attendance attendance_row
  where attendance_row.id = p_attendance_id;

  if not found then
    raise exception 'Attendance record not found.';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_user_id::text)::bigint);

  select attendance_row.*
  into v_attendance
  from public.attendance attendance_row
  where attendance_row.id = p_attendance_id
  for update;

  if exists (
    select 1
    from public.attendance attendance_row
    where attendance_row.user_id = v_attendance.user_id
      and attendance_row.id <> v_attendance.id
      and attendance_row.clock_in is not null
      and attendance_row.clock_out is null
  ) then
    raise exception 'Only one attendance session may remain open at a time.';
  end if;

  if v_attendance.schedule_id is not null then
    select schedule.*
    into v_schedule
    from public.work_schedules schedule
    where schedule.id = v_attendance.schedule_id
    for share;

    if not found then
      raise exception 'The linked schedule no longer exists.';
    end if;

    if v_schedule.user_id <> v_attendance.user_id then
      raise exception 'Attendance employee does not match the linked schedule employee.';
    end if;

    v_is_special_day := v_schedule.is_rest_day or v_schedule.is_holiday;

    if not v_is_special_day
       and (v_schedule.shift_start is null or v_schedule.shift_end is null) then
      raise exception 'Normal attendance requires a complete scheduled shift.';
    end if;

    if v_attendance.work_date <> v_schedule.shift_date then
      raise exception 'Attendance work date must remain the linked schedule work date.';
    end if;

    if v_schedule.shift_start is not null
       and v_schedule.shift_end is not null
       and exists (
         select 1
         from public.attendance other_attendance
         join public.work_schedules other_schedule
           on other_schedule.id = other_attendance.schedule_id
         where other_attendance.user_id = v_attendance.user_id
           and other_attendance.work_date = v_attendance.work_date
           and other_attendance.id <> v_attendance.id
           and other_schedule.shift_start is not null
           and other_schedule.shift_end is not null
           and v_schedule.shift_start < other_schedule.shift_end
           and other_schedule.shift_start < v_schedule.shift_end
       ) then
      raise exception 'Attendance cannot be calculated for overlapping scheduled shifts.';
    end if;
  end if;

  select coalesce(
    sum(greatest(coalesce(attendance_row.total_overtime_minutes, 0), 0)),
    0
  )::integer
  into v_other_overtime_minutes
  from public.attendance attendance_row
  where attendance_row.user_id = v_attendance.user_id
    and attendance_row.work_date = v_attendance.work_date
    and attendance_row.id <> v_attendance.id;

  v_available_overtime_minutes := greatest(
    0,
    1200 - v_other_overtime_minutes
  );

  select *
  into v_calculation
  from public.workforce_calculate_attendance(
    case when v_attendance.schedule_id is null then null else v_schedule.shift_start end,
    case when v_attendance.schedule_id is null then null else v_schedule.shift_end end,
    v_attendance.clock_in,
    v_attendance.clock_out,
    v_attendance.work_date,
    case
      when v_attendance.schedule_id is null then
        coalesce(
          nullif(
            (
              select profile.timezone
              from public.profiles profile
              where profile.user_id = v_attendance.user_id
            ),
            ''
          ),
          'America/New_York'
        )
      else v_schedule.timezone
    end,
    v_available_overtime_minutes,
    case when v_attendance.schedule_id is null then true else v_schedule.is_rest_day end,
    case when v_attendance.schedule_id is null then false else v_schedule.is_holiday end
  );

  update public.attendance
  set pre_shift_overtime_minutes = v_calculation.pre_shift_overtime_minutes,
      regular_minutes = v_calculation.regular_minutes,
      post_shift_overtime_minutes = v_calculation.post_shift_overtime_minutes,
      rest_day_overtime_minutes = v_calculation.rest_day_overtime_minutes,
      holiday_overtime_minutes = v_calculation.holiday_overtime_minutes,
      total_overtime_minutes = v_calculation.total_overtime_minutes,
      overtime_minutes = v_calculation.total_overtime_minutes,
      total_worked_minutes = v_calculation.total_worked_minutes,
      minutes_late = v_calculation.minutes_late,
      is_late = v_calculation.minutes_late > 0,
      undertime_minutes = v_calculation.undertime_minutes
  where id = v_attendance.id
  returning * into v_result;

  return v_result;
end;
$$;

comment on function public.workforce_recalculate_attendance(uuid) is
  'Recalculates trusted attendance totals; attendance without an assigned shift is classified as RDOT.';

revoke all on function public.workforce_recalculate_attendance(uuid) from public;
revoke all on function public.workforce_recalculate_attendance(uuid) from anon;
revoke all on function public.workforce_recalculate_attendance(uuid) from authenticated;

insert into public.workforce_audit_logs (
  actor_user_id,
  action,
  entity_type,
  after_data,
  reason
) values (
  auth.uid(),
  'unscheduled_attendance_rdot_enabled',
  'attendance',
  jsonb_build_object(
    'no_released_shift_clock_in_enabled', true,
    'unscheduled_work_classification', 'rest_day_overtime_minutes',
    'maximum_overtime_minutes_per_employee_work_date', 1200
  ),
  'Classified attendance without an assigned released shift as RDOT'
);

commit;
