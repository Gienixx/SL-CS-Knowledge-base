-- Step 7: allow clock-in at any time before a relevant released shift and
-- cap credited overtime at 20 hours per employee per scheduled work date.

begin;

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
  v_max_overtime_minutes constant integer := 1200;
  v_minutes_late integer := 0;
  v_raw_pre_shift_overtime_minutes integer := 0;
  v_other_overtime_minutes integer := 0;
  v_credited_pre_shift_overtime_minutes integer := 0;
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

  -- Serialize attendance actions for this employee so parallel requests cannot
  -- create more than one open session.
  perform pg_advisory_xact_lock(hashtext(v_profile_user_id::text)::bigint);

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
        and schedule.shift_start is not null
        and schedule.shift_end is not null
        and schedule.shift_date between v_local_date - 1 and v_local_date + 1
        and schedule.shift_end > v_clock_time
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

    if v_schedule.shift_date < v_local_date - 1
       or v_schedule.shift_date > v_local_date + 1 then
      raise exception 'The selected schedule is outside the available attendance date range.';
    end if;

    if v_clock_time >= v_schedule.shift_end then
      raise exception 'This shift has already ended and is no longer available for clock-in.';
    end if;

    v_work_date := v_schedule.shift_date;
    v_target_user_id := v_schedule.user_id;

    v_raw_pre_shift_overtime_minutes := greatest(
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

  if found and v_existing.clock_in is not null then
    raise exception 'Attendance has already been recorded for this shift.';
  end if;

  select coalesce(sum(greatest(coalesce(attendance_row.overtime_minutes, 0), 0)), 0)::integer
  into v_other_overtime_minutes
  from public.attendance attendance_row
  where public.workforce_is_current_identity(attendance_row.user_id)
    and attendance_row.work_date = v_work_date
    and (v_existing.id is null or attendance_row.id <> v_existing.id);

  v_credited_pre_shift_overtime_minutes := least(
    v_raw_pre_shift_overtime_minutes,
    greatest(0, v_max_overtime_minutes - v_other_overtime_minutes)
  );

  if v_existing.id is not null then
    update public.attendance
    set clock_in = v_clock_time,
        schedule_id = coalesce(p_schedule_id, schedule_id),
        work_date = v_work_date,
        attendance_status = 'present',
        is_late = case when p_schedule_id is null then is_late else v_minutes_late > 0 end,
        minutes_late = case when p_schedule_id is null then minutes_late else v_minutes_late end,
        overtime_minutes = case
          when p_schedule_id is null then overtime_minutes
          else v_credited_pre_shift_overtime_minutes
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
      v_credited_pre_shift_overtime_minutes,
      v_auth_user_id,
      v_auth_user_id
    )
    returning * into v_result;
  end if;

  return v_result;
end;
$$;

create or replace function public.workforce_clock_out()
returns public.attendance
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auth_user_id uuid := auth.uid();
  v_profile_user_id uuid;
  v_clock_time timestamptz := now();
  v_max_overtime_minutes constant integer := 1200;
  v_existing public.attendance%rowtype;
  v_shift_start timestamptz;
  v_shift_end timestamptz;
  v_pre_shift_overtime_minutes integer := 0;
  v_post_shift_overtime_minutes integer := 0;
  v_raw_overtime_minutes integer := 0;
  v_other_overtime_minutes integer := 0;
  v_credited_overtime_minutes integer := 0;
  v_undertime_minutes integer := 0;
  v_result public.attendance%rowtype;
begin
  if v_auth_user_id is null or not public.workforce_current_user_is_agent() then
    raise exception 'Authentication and an active agent profile are required.';
  end if;

  v_profile_user_id := public.workforce_current_profile_id();

  if v_profile_user_id is null then
    raise exception 'No workforce profile is linked to the current account.';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_profile_user_id::text)::bigint);

  select attendance_row.*
  into v_existing
  from public.attendance attendance_row
  where public.workforce_is_current_identity(attendance_row.user_id)
    and attendance_row.clock_in is not null
    and attendance_row.clock_out is null
  order by attendance_row.clock_in desc
  limit 1
  for update;

  if not found then
    raise exception 'No open attendance record was found.';
  end if;

  if v_clock_time < v_existing.clock_in then
    raise exception 'Clock-out cannot be earlier than clock-in.';
  end if;

  if v_existing.schedule_id is not null then
    select schedule.shift_start, schedule.shift_end
    into v_shift_start, v_shift_end
    from public.work_schedules schedule
    where schedule.id = v_existing.schedule_id;
  end if;

  if v_shift_start is not null then
    v_pre_shift_overtime_minutes := greatest(
      0,
      floor(extract(epoch from (v_shift_start - v_existing.clock_in)) / 60)::integer
    );
  end if;

  if v_shift_end is not null then
    v_post_shift_overtime_minutes := greatest(
      0,
      floor(extract(epoch from (v_clock_time - v_shift_end)) / 60)::integer
    );

    v_undertime_minutes := greatest(
      0,
      floor(extract(epoch from (v_shift_end - v_clock_time)) / 60)::integer
    );
  end if;

  v_raw_overtime_minutes := v_pre_shift_overtime_minutes + v_post_shift_overtime_minutes;

  select coalesce(sum(greatest(coalesce(attendance_row.overtime_minutes, 0), 0)), 0)::integer
  into v_other_overtime_minutes
  from public.attendance attendance_row
  where public.workforce_is_current_identity(attendance_row.user_id)
    and attendance_row.work_date = v_existing.work_date
    and attendance_row.id <> v_existing.id;

  v_credited_overtime_minutes := least(
    v_raw_overtime_minutes,
    greatest(0, v_max_overtime_minutes - v_other_overtime_minutes)
  );

  update public.attendance
  set clock_out = v_clock_time,
      overtime_minutes = case
        when v_shift_start is null and v_shift_end is null then overtime_minutes
        else v_credited_overtime_minutes
      end,
      undertime_minutes = case
        when v_shift_end is null then undertime_minutes
        else v_undertime_minutes
      end,
      updated_by = v_auth_user_id
  where id = v_existing.id
  returning * into v_result;

  return v_result;
end;
$$;

revoke all on function public.workforce_clock_in(uuid) from public;
revoke all on function public.workforce_clock_out() from public;
grant execute on function public.workforce_clock_in(uuid) to authenticated;
grant execute on function public.workforce_clock_out() to authenticated;

insert into public.workforce_audit_logs (
  actor_user_id,
  action,
  entity_type,
  after_data,
  reason
) values (
  auth.uid(),
  'attendance_unrestricted_pre_shift_overtime_enabled',
  'attendance',
  jsonb_build_object(
    'released_schedule_statuses', jsonb_build_array('published', 'changed'),
    'pre_shift_clock_in_lower_bound_removed', true,
    'one_open_session_per_employee', true,
    'maximum_overtime_minutes_per_work_date', 1200,
    'overtime_limit_aggregated_across_records', true,
    'clock_out_remains_allowed_after_limit', true
  ),
  'Removed the 15-minute early clock-in restriction and capped credited overtime at 20 hours per employee per scheduled work date'
);

commit;
