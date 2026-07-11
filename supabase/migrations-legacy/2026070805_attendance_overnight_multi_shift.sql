-- Attendance correction: support active overnight shifts and multiple shifts on one work date.

begin;

alter table public.attendance
  drop constraint if exists attendance_user_work_date_unique;

create unique index if not exists attendance_user_schedule_unique
  on public.attendance (user_id, schedule_id)
  where schedule_id is not null;

create unique index if not exists attendance_user_unscheduled_date_unique
  on public.attendance (user_id, work_date)
  where schedule_id is null;

create or replace function public.workforce_clock_in(p_schedule_id uuid default null)
returns public.attendance
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auth_user_id uuid := auth.uid();
  v_profile_user_id uuid;
  v_target_user_id uuid;
  v_timezone text;
  v_local_date date;
  v_work_date date;
  v_clock_time timestamptz := now();
  v_early_clock_in_window interval := interval '15 minutes';
  v_minutes_late integer := 0;
  v_early_overtime_minutes integer := 0;
  v_has_released_schedule boolean := false;
  v_schedule public.work_schedules%rowtype;
  v_open public.attendance%rowtype;
  v_existing public.attendance%rowtype;
  v_result public.attendance%rowtype;
begin
  if v_auth_user_id is null or not public.workforce_current_user_is_agent() then
    raise exception 'Authentication and an active agent profile are required.';
  end if;

  v_profile_user_id := public.workforce_current_profile_id();

  if v_profile_user_id is null then
    raise exception 'No workforce profile is linked to the current account.';
  end if;

  select profile.timezone
  into v_timezone
  from public.profiles profile
  where profile.user_id = v_profile_user_id;

  v_timezone := coalesce(nullif(v_timezone, ''), 'America/New_York');
  v_local_date := (v_clock_time at time zone v_timezone)::date;
  v_work_date := v_local_date;
  v_target_user_id := v_profile_user_id;

  select attendance_row.*
  into v_open
  from public.attendance attendance_row
  where public.workforce_is_current_identity(attendance_row.user_id)
    and attendance_row.clock_in is not null
    and attendance_row.clock_out is null
  order by attendance_row.clock_in desc
  limit 1
  for update;

  if found then
    raise exception 'You are already clocked in to another shift.';
  end if;

  if p_schedule_id is null then
    select exists (
      select 1
      from public.work_schedules schedule
      where public.workforce_is_current_identity(schedule.user_id)
        and schedule.status in ('published', 'changed')
        and schedule.is_rest_day is false
        and (
          schedule.shift_date = v_local_date
          or (
            schedule.shift_date = v_local_date - 1
            and schedule.shift_end > v_clock_time
          )
          or (
            schedule.shift_date = v_local_date + 1
            and schedule.shift_start is not null
            and v_clock_time >= schedule.shift_start - v_early_clock_in_window
          )
        )
    )
    into v_has_released_schedule;

    if v_has_released_schedule then
      raise exception 'A released shift is available. Select that shift before clocking in.';
    end if;
  else
    select schedule.*
    into v_schedule
    from public.work_schedules schedule
    where schedule.id = p_schedule_id
      and public.workforce_is_current_identity(schedule.user_id);

    if not found then
      raise exception 'The selected schedule does not belong to the current user.';
    end if;

    if v_schedule.is_rest_day or v_schedule.status not in ('published', 'changed') then
      raise exception 'Clock-in is not available for this schedule.';
    end if;

    if v_schedule.shift_start is null or v_schedule.shift_end is null then
      raise exception 'The selected schedule does not have valid shift times.';
    end if;

    if v_clock_time < v_schedule.shift_start - v_early_clock_in_window then
      raise exception 'Clock-in opens 15 minutes before the scheduled shift start.';
    end if;

    if v_clock_time >= v_schedule.shift_end then
      raise exception 'This shift has already ended and is no longer available for clock-in.';
    end if;

    v_work_date := v_schedule.shift_date;
    v_target_user_id := v_schedule.user_id;

    v_early_overtime_minutes := greatest(
      0,
      floor(extract(epoch from (v_schedule.shift_start - v_clock_time)) / 60)::integer
    );

    v_minutes_late := greatest(
      0,
      floor(extract(epoch from (v_clock_time - v_schedule.shift_start)) / 60)::integer
    );
  end if;

  if p_schedule_id is null then
    select attendance_row.*
    into v_existing
    from public.attendance attendance_row
    where public.workforce_is_current_identity(attendance_row.user_id)
      and attendance_row.schedule_id is null
      and attendance_row.work_date = v_work_date
    order by attendance_row.created_at asc
    limit 1
    for update;
  else
    select attendance_row.*
    into v_existing
    from public.attendance attendance_row
    where public.workforce_is_current_identity(attendance_row.user_id)
      and attendance_row.schedule_id = p_schedule_id
    order by attendance_row.created_at asc
    limit 1
    for update;
  end if;

  if found then
    if v_existing.clock_in is not null then
      raise exception 'Attendance has already been recorded for this shift.';
    end if;

    update public.attendance
    set clock_in = v_clock_time,
        schedule_id = coalesce(p_schedule_id, schedule_id),
        work_date = v_work_date,
        attendance_status = 'present',
        is_late = case when p_schedule_id is null then is_late else v_minutes_late > 0 end,
        minutes_late = case when p_schedule_id is null then minutes_late else v_minutes_late end,
        overtime_minutes = case
          when p_schedule_id is null then overtime_minutes
          else v_early_overtime_minutes
        end,
        created_by = coalesce(created_by, v_auth_user_id),
        updated_by = v_auth_user_id
    where id = v_existing.id
    returning * into v_result;
  else
    insert into public.attendance (
      user_id,
      schedule_id,
      work_date,
      clock_in,
      attendance_status,
      is_late,
      minutes_late,
      overtime_minutes,
      created_by,
      updated_by
    ) values (
      v_target_user_id,
      p_schedule_id,
      v_work_date,
      v_clock_time,
      'present',
      v_minutes_late > 0,
      v_minutes_late,
      v_early_overtime_minutes,
      v_auth_user_id,
      v_auth_user_id
    )
    returning * into v_result;
  end if;

  return v_result;
end;
$$;

revoke all on function public.workforce_clock_in(uuid) from public;
grant execute on function public.workforce_clock_in(uuid) to authenticated;

insert into public.workforce_audit_logs (
  actor_user_id,
  action,
  entity_type,
  after_data,
  reason
) values (
  auth.uid(),
  'attendance_overnight_multi_shift_enabled',
  'attendance',
  jsonb_build_object(
    'active_previous_date_shifts_visible', true,
    'multiple_scheduled_shifts_per_work_date', true,
    'one_open_shift_at_a_time', true,
    'clock_in_closes_at_shift_end', true,
    'early_clock_in_window_minutes', 15
  ),
  'Enabled overnight shift clock-in and separate attendance records for multiple shifts on one date'
);

commit;
