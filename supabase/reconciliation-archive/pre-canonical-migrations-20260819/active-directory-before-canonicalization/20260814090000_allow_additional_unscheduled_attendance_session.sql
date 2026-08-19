-- Allow a second same-work-date unscheduled session after a completed session.
-- The session remains pending until an administrator assigns a same-date schedule.
create or replace function public.workforce_clock_in(p_schedule_id uuid default null::uuid)
returns public.attendance
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_auth_user_id uuid := auth.uid();
  v_profile_user_id uuid;
  v_timezone text;
  v_local_date date;
  v_work_date date;
  v_clock_time timestamptz := now();
  v_has_released_schedule boolean := false;
  v_has_completed_session boolean := false;
  v_schedule public.work_schedules%rowtype;
  v_existing public.attendance%rowtype;
  v_result public.attendance%rowtype;
begin
  if v_auth_user_id is null or not public.workforce_current_user_is_agent() then
    raise exception 'Authentication and an active agent profile are required.';
  end if;
  v_profile_user_id := public.workforce_current_profile_id();
  if v_profile_user_id is null then raise exception 'No workforce profile is linked to the current account.'; end if;
  perform pg_advisory_xact_lock(hashtext(v_profile_user_id::text)::bigint);
  select coalesce(nullif(profile.timezone, ''), 'America/New_York') into v_timezone
  from public.profiles profile where profile.user_id = v_profile_user_id;
  v_local_date := (v_clock_time at time zone v_timezone)::date;
  v_work_date := v_local_date;

  if exists (select 1 from public.attendance a where a.user_id = v_profile_user_id and a.clock_in is not null and a.clock_out is null) then
    raise exception 'You are already clocked in to another shift.';
  end if;

  if p_schedule_id is null then
    select exists (
      select 1 from public.work_schedules schedule
      where schedule.user_id = v_profile_user_id
        and schedule.status in ('published', 'changed')
        and not schedule.is_leave and not schedule.is_absent
        and ((schedule.shift_start is not null and schedule.shift_end is not null
          and schedule.shift_date between v_local_date - 1 and v_local_date + 1
          and schedule.shift_end > v_clock_time)
          or (schedule.is_rest_day or schedule.is_holiday) and schedule.shift_date = v_local_date)
    ) into v_has_released_schedule;
    select exists (
      select 1 from public.attendance a
      where a.user_id = v_profile_user_id and a.work_date = v_work_date
        and a.clock_in is not null and a.clock_out is not null
    ) into v_has_completed_session;
    if v_has_released_schedule and not v_has_completed_session then
      raise exception 'A released shift or special work date is available. Select it before clocking in.';
    end if;
  else
    select * into v_schedule from public.work_schedules schedule
    where schedule.id = p_schedule_id and schedule.user_id = v_profile_user_id;
    if not found then raise exception 'The selected schedule does not belong to the current user.'; end if;
    if v_schedule.status not in ('published', 'changed') then raise exception 'Clock-in is not available for this schedule.'; end if;
    if v_schedule.is_leave or v_schedule.is_absent then raise exception 'Leave and absence schedules cannot be used for timed attendance.'; end if;
    if not (v_schedule.is_rest_day or v_schedule.is_holiday)
       and (v_schedule.shift_start is null or v_schedule.shift_end is null) then
      raise exception 'The selected schedule does not have valid shift times.';
    end if;
    if v_schedule.shift_date < v_local_date - 1 or v_schedule.shift_date > v_local_date + 1 then raise exception 'The selected schedule is outside the available attendance date range.'; end if;
    if v_clock_time >= v_schedule.shift_end then raise exception 'This shift has already ended and is no longer available for clock-in.'; end if;
    v_work_date := v_schedule.shift_date;
  end if;

  -- Only reuse an empty placeholder. A completed unscheduled session must remain
  -- a separate row so the later Sequence 2 assignment is unambiguous.
  if p_schedule_id is null then
    select * into v_existing from public.attendance a
    where a.user_id = v_profile_user_id and a.schedule_id is null
      and a.work_date = v_work_date and a.clock_in is null
    order by a.created_at asc limit 1 for update;
  else
    select * into v_existing from public.attendance a
    where a.user_id = v_profile_user_id and a.schedule_id = p_schedule_id
    order by a.created_at asc limit 1 for update;
  end if;

  if v_existing.id is not null then
    update public.attendance set clock_in = v_clock_time, schedule_id = coalesce(p_schedule_id, schedule_id),
      work_date = v_work_date, attendance_status = 'present', review_status = case when p_schedule_id is null then 'pending' else review_status end,
      created_by = coalesce(created_by, v_auth_user_id), updated_by = v_auth_user_id
    where id = v_existing.id returning * into v_result;
  else
    insert into public.attendance (user_id, schedule_id, work_date, clock_in, attendance_status, review_status, created_by, updated_by)
    values (v_profile_user_id, p_schedule_id, v_work_date, v_clock_time, 'present', 'pending', v_auth_user_id, v_auth_user_id)
    returning * into v_result;
  end if;
  return public.workforce_recalculate_attendance(v_result.id);
end;
$$;

revoke all on function public.workforce_clock_in(uuid) from public, anon, authenticated;
grant execute on function public.workforce_clock_in(uuid) to authenticated;
