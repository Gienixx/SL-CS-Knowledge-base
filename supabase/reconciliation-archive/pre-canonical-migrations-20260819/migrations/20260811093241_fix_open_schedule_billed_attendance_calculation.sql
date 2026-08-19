-- Keep billed timestamps as the calculation source while preserving the
-- flexible Open Schedule classification contract.
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
  v_is_open_schedule boolean := false;
  v_clock_in timestamptz;
  v_clock_out timestamptz;
  v_worked_minutes integer;
begin
  if p_attendance_id is null then raise exception 'Attendance record is required.'; end if;

  select a.user_id into v_user_id from public.attendance a where a.id = p_attendance_id;
  if not found then raise exception 'Attendance record not found.'; end if;
  perform pg_advisory_xact_lock(hashtext(v_user_id::text)::bigint);

  select a.* into v_attendance from public.attendance a where a.id = p_attendance_id for update;
  v_clock_in := coalesce(v_attendance.billed_clock_in, v_attendance.clock_in);
  v_clock_out := coalesce(v_attendance.billed_clock_out, v_attendance.clock_out);

  if v_clock_out is null and exists (
    select 1 from public.attendance a
    where a.user_id = v_attendance.user_id and a.id <> v_attendance.id
      and coalesce(a.billed_clock_in, a.clock_in) is not null
      and coalesce(a.billed_clock_out, a.clock_out) is null
  ) then raise exception 'Only one attendance session may remain open at a time.'; end if;

  if v_attendance.schedule_id is not null then
    select s.* into v_schedule from public.work_schedules s
    where s.id = v_attendance.schedule_id for share;
    if not found then raise exception 'The linked schedule no longer exists.'; end if;
    if v_schedule.user_id <> v_attendance.user_id then raise exception 'Attendance employee does not match the linked schedule employee.'; end if;
    if v_attendance.work_date <> v_schedule.shift_date then raise exception 'Attendance work date must remain the linked schedule work date.'; end if;
    v_is_open_schedule := not v_schedule.is_rest_day and not v_schedule.is_holiday
      and v_schedule.shift_start is null and v_schedule.shift_end is null;
    if v_is_open_schedule and v_schedule.planned_paid_minutes is null then
      raise exception 'Open schedule attendance requires planned paid time.';
    end if;
  end if;

  select coalesce(sum(greatest(coalesce(a.total_overtime_minutes, 0), 0)), 0)::integer
  into v_other_overtime_minutes
  from public.attendance a
  where a.user_id = v_attendance.user_id and a.work_date = v_attendance.work_date and a.id <> v_attendance.id;
  v_available_overtime_minutes := greatest(0, 1200 - v_other_overtime_minutes);

  if v_is_open_schedule then
    if v_clock_out is not null and v_clock_out < v_clock_in then raise exception 'Clock-out cannot be earlier than clock-in.'; end if;
    v_worked_minutes := case when v_clock_out is null then 0 else floor(extract(epoch from (v_clock_out - v_clock_in)) / 60)::integer end;
    select 0::integer as pre_shift_overtime_minutes,
      case when v_clock_out is null then 0 else least(v_worked_minutes, v_schedule.planned_paid_minutes) end as regular_minutes,
      case when v_clock_out is null then 0 else least(greatest(v_worked_minutes - v_schedule.planned_paid_minutes, 0), v_available_overtime_minutes) end as post_shift_overtime_minutes,
      0::integer as rest_day_overtime_minutes, 0::integer as holiday_overtime_minutes,
      case when v_clock_out is null then 0 else least(greatest(v_worked_minutes - v_schedule.planned_paid_minutes, 0), v_available_overtime_minutes) end as total_overtime_minutes,
      v_worked_minutes as total_worked_minutes, 0::integer as minutes_late, 0::integer as undertime_minutes
    into v_calculation;
  else
    select * into v_calculation from public.workforce_calculate_attendance(
      case when v_attendance.schedule_id is null then null else v_schedule.shift_start end,
      case when v_attendance.schedule_id is null then null else v_schedule.shift_end end,
      v_clock_in, v_clock_out, v_attendance.work_date,
      case when v_attendance.schedule_id is null then coalesce(nullif((select p.timezone from public.profiles p where p.user_id = v_attendance.user_id), ''), 'America/New_York') else v_schedule.timezone end,
      v_available_overtime_minutes,
      case when v_attendance.schedule_id is null then true else v_schedule.is_rest_day end,
      case when v_attendance.schedule_id is null then false else v_schedule.is_holiday end
    );
  end if;

  update public.attendance set
    pre_shift_overtime_minutes = v_calculation.pre_shift_overtime_minutes,
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
  where id = v_attendance.id returning * into v_result;
  return v_result;
end;
$$;

revoke all on function public.workforce_recalculate_attendance(uuid) from public, anon, authenticated;
commit;
