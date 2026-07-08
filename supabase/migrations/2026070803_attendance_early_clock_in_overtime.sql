-- Attendance policy: allow clock-in up to 15 minutes before a released shift
-- and count qualifying pre-shift minutes together with post-shift overtime.

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
  v_work_date date;
  v_clock_time timestamptz := now();
  v_early_clock_in_window interval := interval '15 minutes';
  v_minutes_late integer := 0;
  v_early_overtime_minutes integer := 0;
  v_schedule public.work_schedules%rowtype;
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
  v_work_date := (v_clock_time at time zone v_timezone)::date;
  v_target_user_id := v_profile_user_id;

  if p_schedule_id is not null then
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

    if v_schedule.shift_start is null then
      raise exception 'The selected schedule does not have a valid shift start time.';
    end if;

    if v_clock_time < v_schedule.shift_start - v_early_clock_in_window then
      raise exception 'Clock-in opens 15 minutes before the scheduled shift start.';
    end if;

    if v_schedule.shift_date <> v_work_date then
      if not (
        v_schedule.shift_date = v_work_date + 1
        and v_clock_time >= v_schedule.shift_start - v_early_clock_in_window
        and v_clock_time < v_schedule.shift_start
      ) then
        raise exception 'The selected schedule is not available for clock-in at this time.';
      end if;
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

  select attendance_row.*
  into v_existing
  from public.attendance attendance_row
  where public.workforce_is_current_identity(attendance_row.user_id)
    and attendance_row.work_date = v_work_date
  order by
    (attendance_row.clock_in is not null and attendance_row.clock_out is null) desc,
    attendance_row.created_at asc
  limit 1
  for update;

  if found then
    if v_existing.clock_in is not null then
      raise exception 'A clock-in has already been recorded for this work date.';
    end if;

    update public.attendance
    set clock_in = v_clock_time,
        schedule_id = coalesce(p_schedule_id, schedule_id),
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
  v_existing public.attendance%rowtype;
  v_shift_start timestamptz;
  v_shift_end timestamptz;
  v_early_overtime_minutes integer := 0;
  v_post_shift_overtime_minutes integer := 0;
  v_overtime_minutes integer := 0;
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

  if v_existing.schedule_id is not null then
    select schedule.shift_start, schedule.shift_end
    into v_shift_start, v_shift_end
    from public.work_schedules schedule
    where schedule.id = v_existing.schedule_id;
  end if;

  if v_shift_start is not null then
    v_early_overtime_minutes := greatest(
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

  v_overtime_minutes := v_early_overtime_minutes + v_post_shift_overtime_minutes;

  update public.attendance
  set clock_out = v_clock_time,
      overtime_minutes = case
        when v_shift_start is null and v_shift_end is null then overtime_minutes
        else v_overtime_minutes
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
  'attendance_early_clock_in_policy_enabled',
  'attendance',
  jsonb_build_object(
    'early_clock_in_window_minutes', 15,
    'released_schedule_statuses', jsonb_build_array('published', 'changed'),
    'pre_shift_minutes_count_as_overtime', true,
    'post_shift_minutes_count_as_overtime', true,
    'overtime_is_combined', true
  ),
  'Enabled a 15-minute early clock-in window and combined pre-shift and post-shift overtime'
);

commit;
