-- Allow an agent with completed attendance for the current local work date
-- to start tomorrow's released rest-day or holiday attendance early.
create or replace function public.workforce_clock_in(p_schedule_id uuid default null::uuid)
returns public.attendance
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $$
declare
  v_auth_user_id uuid := auth.uid();
  v_profile_user_id uuid;
  v_target_user_id uuid;
  v_timezone text;
  v_local_date date;
  v_work_date date;
  v_clock_time timestamptz := now();
  v_has_released_schedule boolean := false;
  v_today_completed boolean := false;
  v_schedule public.work_schedules%rowtype;
  v_existing public.attendance%rowtype;
  v_result public.attendance%rowtype;
  v_is_special_day boolean := false;
begin
  if v_auth_user_id is null or not public.workforce_current_user_is_agent() then
    raise exception 'Authentication and an active agent profile are required.';
  end if;

  v_profile_user_id := public.workforce_current_profile_id();

  if v_profile_user_id is null then
    raise exception 'No workforce profile is linked to the current account.';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_profile_user_id::text)::bigint);

  select profile.timezone
  into v_timezone
  from public.profiles profile
  where profile.user_id = v_profile_user_id;

  v_timezone := coalesce(nullif(v_timezone, ''), 'America/New_York');
  v_local_date := (v_clock_time at time zone v_timezone)::date;
  v_work_date := v_local_date;
  v_target_user_id := v_profile_user_id;

  select exists (
    select 1
    from public.attendance attendance_row
    where public.workforce_is_current_identity(attendance_row.user_id)
      and attendance_row.work_date = v_local_date
      and attendance_row.clock_in is not null
      and attendance_row.clock_out is not null
  )
  into v_today_completed;

  if exists (
    select 1
    from public.attendance attendance_row
    where public.workforce_is_current_identity(attendance_row.user_id)
      and attendance_row.clock_in is not null
      and attendance_row.clock_out is null
  ) then
    raise exception 'You are already clocked in to another shift.';
  end if;

  if p_schedule_id is null then
    select exists (
      select 1
      from public.work_schedules schedule
      where public.workforce_is_current_identity(schedule.user_id)
        and schedule.status in ('published', 'changed')
        and (
          (
            (schedule.is_rest_day or schedule.is_holiday)
            and (
              schedule.shift_date = v_local_date
              or (
                schedule.shift_date = v_local_date - 1
                and schedule.shift_end is not null
                and schedule.shift_end > v_clock_time
              )
              or (
                schedule.shift_date = v_local_date + 1
                and v_today_completed
              )
            )
          )
          or (
            not schedule.is_rest_day
            and not schedule.is_holiday
            and schedule.shift_start is not null
            and schedule.shift_end is not null
            and schedule.shift_date between v_local_date - 1 and v_local_date + 1
            and schedule.shift_end > v_clock_time
          )
        )
    )
    into v_has_released_schedule;

    if v_has_released_schedule then
      raise exception 'A released shift or special work date is available. Select it before clocking in.';
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

    if v_schedule.status not in ('published', 'changed') then
      raise exception 'Clock-in is not available for this schedule.';
    end if;

    v_is_special_day := v_schedule.is_rest_day or v_schedule.is_holiday;

    if v_is_special_day then
      if not (
        v_schedule.shift_date = v_local_date
        or (
          v_schedule.shift_date = v_local_date - 1
          and v_schedule.shift_end is not null
          and v_schedule.shift_end > v_clock_time
        )
        or (
          v_schedule.shift_date = v_local_date + 1
          and v_today_completed
        )
      ) then
        raise exception 'Tomorrow''s rest-day or holiday schedule can be selected early only after today''s attendance is completed.';
      end if;
    else
      if v_schedule.shift_start is null or v_schedule.shift_end is null then
        raise exception 'The selected schedule does not have valid shift times.';
      end if;

      if v_schedule.shift_date < v_local_date - 1
         or v_schedule.shift_date > v_local_date + 1 then
        raise exception 'The selected schedule is outside the available attendance date range.';
      end if;

      if v_clock_time >= v_schedule.shift_end then
        raise exception 'This shift has already ended and is no longer available for clock-in.';
      end if;
    end if;

    v_work_date := v_schedule.shift_date;
    v_target_user_id := v_schedule.user_id;
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

  if found and v_existing.clock_in is not null then
    raise exception 'Attendance has already been recorded for this shift.';
  end if;

  if v_existing.id is not null then
    update public.attendance
    set clock_in = v_clock_time,
        schedule_id = coalesce(p_schedule_id, schedule_id),
        work_date = v_work_date,
        attendance_status = 'present',
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
      created_by,
      updated_by
    ) values (
      v_target_user_id,
      p_schedule_id,
      v_work_date,
      v_clock_time,
      'present',
      v_auth_user_id,
      v_auth_user_id
    )
    returning * into v_result;
  end if;

  return public.workforce_recalculate_attendance(v_result.id);
end;
$$;

revoke all on function public.workforce_clock_in(uuid) from public;
revoke all on function public.workforce_clock_in(uuid) from anon;
grant execute on function public.workforce_clock_in(uuid) to authenticated;
grant execute on function public.workforce_clock_in(uuid) to service_role;

comment on function public.workforce_clock_in(uuid) is
  'Clocks in the current agent to a released schedule or unscheduled work date. Tomorrow special-day schedules require completed attendance for the current local work date.';
