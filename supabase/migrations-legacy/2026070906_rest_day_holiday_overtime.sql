-- Attendance rule update: allow clock-in on released rest-day and holiday schedules.
--
-- Rest-day work is credited as RDOT. Holiday work is credited as normal overtime.
-- When a schedule is both a rest day and a holiday, RDOT takes precedence so
-- the same minute is never classified twice. All overtime remains subject to
-- the aggregate 1,200-minute limit per employee and scheduled work date.

begin;

alter table public.attendance
  add column if not exists rest_day_overtime_minutes integer not null default 0,
  add column if not exists holiday_overtime_minutes integer not null default 0;

comment on column public.attendance.rest_day_overtime_minutes is
  'Credited worked minutes on a released rest-day schedule. Included in total_overtime_minutes and displayed as RDOT.';
comment on column public.attendance.holiday_overtime_minutes is
  'Credited worked minutes on a released holiday schedule that is not also a rest day. Included in total_overtime_minutes as normal overtime.';

alter table public.attendance
  drop constraint if exists attendance_structured_minutes_nonnegative;

alter table public.attendance
  add constraint attendance_structured_minutes_nonnegative check (
    (pre_shift_overtime_minutes is null or pre_shift_overtime_minutes >= 0)
    and (regular_minutes is null or regular_minutes >= 0)
    and (post_shift_overtime_minutes is null or post_shift_overtime_minutes >= 0)
    and rest_day_overtime_minutes >= 0
    and holiday_overtime_minutes >= 0
    and total_overtime_minutes >= 0
    and total_worked_minutes >= 0
  );

alter table public.attendance
  drop constraint if exists attendance_structured_totals_check;

alter table public.attendance
  add constraint attendance_structured_totals_check check (
    (
      pre_shift_overtime_minutes is null
      and regular_minutes is null
      and post_shift_overtime_minutes is null
      and rest_day_overtime_minutes = 0
      and holiday_overtime_minutes = 0
      and total_overtime_minutes = 0
    )
    or (
      pre_shift_overtime_minutes is not null
      and regular_minutes is not null
      and post_shift_overtime_minutes is not null
      and total_overtime_minutes =
        pre_shift_overtime_minutes
        + post_shift_overtime_minutes
        + rest_day_overtime_minutes
        + holiday_overtime_minutes
      and total_overtime_minutes <= 1200
      and (
        clock_out is null
        or total_worked_minutes >= regular_minutes + total_overtime_minutes
      )
    )
  );

create or replace function public.workforce_calculate_attendance(
  p_scheduled_start timestamptz,
  p_scheduled_end timestamptz,
  p_clock_in timestamptz,
  p_clock_out timestamptz,
  p_scheduled_work_date date,
  p_timezone text,
  p_available_overtime_minutes integer,
  p_is_rest_day boolean,
  p_is_holiday boolean
)
returns table (
  pre_shift_overtime_minutes integer,
  regular_minutes integer,
  post_shift_overtime_minutes integer,
  rest_day_overtime_minutes integer,
  holiday_overtime_minutes integer,
  total_overtime_minutes integer,
  total_worked_minutes integer,
  minutes_late integer,
  undertime_minutes integer
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_available_overtime_minutes integer;
  v_raw_pre_shift_minutes integer := 0;
  v_raw_post_shift_minutes integer := 0;
  v_credited_special_minutes integer := 0;
  v_has_schedule_times boolean;
  v_is_special_day boolean;
begin
  if p_clock_in is null then
    raise exception 'Clock-in is required for attendance calculation.';
  end if;

  if p_scheduled_work_date is null then
    raise exception 'Scheduled work date is required for attendance calculation.';
  end if;

  if nullif(trim(coalesce(p_timezone, '')), '') is null
     or not exists (
       select 1
       from pg_catalog.pg_timezone_names timezone_row
       where timezone_row.name = p_timezone
     ) then
    raise exception 'A valid IANA timezone is required for attendance calculation.';
  end if;

  if (p_scheduled_start is null) <> (p_scheduled_end is null) then
    raise exception 'Scheduled start and end must both be supplied or both be null.';
  end if;

  v_has_schedule_times := p_scheduled_start is not null;
  v_is_special_day := coalesce(p_is_rest_day, false) or coalesce(p_is_holiday, false);

  if v_has_schedule_times then
    if p_scheduled_end <= p_scheduled_start then
      raise exception 'Scheduled end must be later than scheduled start.';
    end if;

    if (p_scheduled_start at time zone p_timezone)::date <> p_scheduled_work_date then
      raise exception 'Scheduled start does not match the scheduled work date in the supplied timezone.';
    end if;
  end if;

  if p_clock_out is not null and p_clock_out < p_clock_in then
    raise exception 'Clock-out cannot be earlier than clock-in.';
  end if;

  v_available_overtime_minutes := least(
    1200,
    greatest(0, coalesce(p_available_overtime_minutes, 0))
  );

  total_worked_minutes := case
    when p_clock_out is null then 0
    else floor(extract(epoch from (p_clock_out - p_clock_in)) / 60)::integer
  end;

  pre_shift_overtime_minutes := 0;
  regular_minutes := 0;
  post_shift_overtime_minutes := 0;
  rest_day_overtime_minutes := 0;
  holiday_overtime_minutes := 0;
  total_overtime_minutes := 0;
  minutes_late := 0;
  undertime_minutes := 0;

  if v_is_special_day then
    if p_clock_out is not null then
      v_credited_special_minutes := least(
        total_worked_minutes,
        v_available_overtime_minutes
      );

      if coalesce(p_is_rest_day, false) then
        rest_day_overtime_minutes := v_credited_special_minutes;
      else
        holiday_overtime_minutes := v_credited_special_minutes;
      end if;

      total_overtime_minutes := v_credited_special_minutes;
    end if;

    return next;
    return;
  end if;

  if not v_has_schedule_times then
    pre_shift_overtime_minutes := null;
    regular_minutes := null;
    post_shift_overtime_minutes := null;
    return next;
    return;
  end if;

  minutes_late := greatest(
    0,
    floor(extract(epoch from (p_clock_in - p_scheduled_start)) / 60)::integer
  );

  if p_clock_out is null then
    v_raw_pre_shift_minutes := greatest(
      0,
      floor(extract(epoch from (p_scheduled_start - p_clock_in)) / 60)::integer
    );

    pre_shift_overtime_minutes := least(
      v_raw_pre_shift_minutes,
      v_available_overtime_minutes
    );
    total_overtime_minutes := pre_shift_overtime_minutes;
    return next;
    return;
  end if;

  if p_clock_in < p_scheduled_start then
    v_raw_pre_shift_minutes := greatest(
      0,
      floor(
        extract(
          epoch from (least(p_clock_out, p_scheduled_start) - p_clock_in)
        ) / 60
      )::integer
    );
  end if;

  if p_clock_out > p_scheduled_end then
    v_raw_post_shift_minutes := greatest(
      0,
      floor(
        extract(
          epoch from (p_clock_out - greatest(p_clock_in, p_scheduled_end))
        ) / 60
      )::integer
    );
  end if;

  pre_shift_overtime_minutes := least(
    v_raw_pre_shift_minutes,
    v_available_overtime_minutes
  );

  post_shift_overtime_minutes := least(
    v_raw_post_shift_minutes,
    greatest(0, v_available_overtime_minutes - pre_shift_overtime_minutes)
  );

  total_overtime_minutes :=
    pre_shift_overtime_minutes + post_shift_overtime_minutes;

  regular_minutes := greatest(
    0,
    total_worked_minutes - v_raw_pre_shift_minutes - v_raw_post_shift_minutes
  );

  undertime_minutes := case
    when p_clock_out >= p_scheduled_end then 0
    else greatest(
      0,
      floor(
        extract(
          epoch from (
            p_scheduled_end - greatest(p_clock_out, p_scheduled_start)
          )
        ) / 60
      )::integer
    )
  end;

  return next;
end;
$$;

comment on function public.workforce_calculate_attendance(
  timestamptz, timestamptz, timestamptz, timestamptz, date, text, integer, boolean, boolean
) is
  'Classifies normal shifts, rest-day work, and holiday work while enforcing the available overtime allowance.';

-- Keep the original seven-argument calculator contract for compatibility.
create or replace function public.workforce_calculate_attendance(
  p_scheduled_start timestamptz,
  p_scheduled_end timestamptz,
  p_clock_in timestamptz,
  p_clock_out timestamptz,
  p_scheduled_work_date date,
  p_timezone text,
  p_available_overtime_minutes integer default 1200
)
returns table (
  pre_shift_overtime_minutes integer,
  regular_minutes integer,
  post_shift_overtime_minutes integer,
  total_overtime_minutes integer,
  total_worked_minutes integer,
  minutes_late integer,
  undertime_minutes integer
)
language sql
stable
set search_path = public, pg_temp
as $$
  select
    calculation.pre_shift_overtime_minutes,
    calculation.regular_minutes,
    calculation.post_shift_overtime_minutes,
    calculation.total_overtime_minutes,
    calculation.total_worked_minutes,
    calculation.minutes_late,
    calculation.undertime_minutes
  from public.workforce_calculate_attendance(
    p_scheduled_start,
    p_scheduled_end,
    p_clock_in,
    p_clock_out,
    p_scheduled_work_date,
    p_timezone,
    p_available_overtime_minutes,
    false,
    false
  ) calculation;
$$;

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
    case when v_attendance.schedule_id is null then false else v_schedule.is_rest_day end,
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

create or replace function public.workforce_recalculate_attendance_work_date(
  p_user_id uuid,
  p_work_date date
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_attendance_id uuid;
begin
  if p_user_id is null or p_work_date is null then
    raise exception 'Employee and work date are required.';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text)::bigint);

  update public.attendance
  set pre_shift_overtime_minutes = null,
      regular_minutes = null,
      post_shift_overtime_minutes = null,
      rest_day_overtime_minutes = 0,
      holiday_overtime_minutes = 0,
      total_overtime_minutes = 0,
      overtime_minutes = 0
  where user_id = p_user_id
    and work_date = p_work_date
    and schedule_id is not null;

  for v_attendance_id in
    select attendance_row.id
    from public.attendance attendance_row
    join public.work_schedules schedule
      on schedule.id = attendance_row.schedule_id
    where attendance_row.user_id = p_user_id
      and attendance_row.work_date = p_work_date
      and attendance_row.clock_in is not null
    order by
      schedule.shift_date,
      schedule.shift_sequence,
      schedule.shift_start nulls first,
      attendance_row.created_at
  loop
    perform public.workforce_recalculate_attendance(v_attendance_id);
  end loop;
end;
$$;

create or replace function public.workforce_clock_in(
  p_schedule_id uuid default null
)
returns public.attendance
language plpgsql
security definer
set search_path = public, pg_temp
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
      ) then
        raise exception 'Rest-day and holiday clock-in is available only on the scheduled work date.';
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

revoke all on function public.workforce_calculate_attendance(
  timestamptz, timestamptz, timestamptz, timestamptz, date, text, integer, boolean, boolean
) from public;
revoke all on function public.workforce_calculate_attendance(
  timestamptz, timestamptz, timestamptz, timestamptz, date, text, integer, boolean, boolean
) from anon;
revoke all on function public.workforce_calculate_attendance(
  timestamptz, timestamptz, timestamptz, timestamptz, date, text, integer, boolean, boolean
) from authenticated;

revoke all on function public.workforce_calculate_attendance(
  timestamptz, timestamptz, timestamptz, timestamptz, date, text, integer
) from public;
revoke all on function public.workforce_calculate_attendance(
  timestamptz, timestamptz, timestamptz, timestamptz, date, text, integer
) from anon;
revoke all on function public.workforce_calculate_attendance(
  timestamptz, timestamptz, timestamptz, timestamptz, date, text, integer
) from authenticated;

revoke all on function public.workforce_recalculate_attendance(uuid) from public;
revoke all on function public.workforce_recalculate_attendance(uuid) from anon;
revoke all on function public.workforce_recalculate_attendance(uuid) from authenticated;

revoke all on function public.workforce_recalculate_attendance_work_date(uuid, date) from public;
revoke all on function public.workforce_recalculate_attendance_work_date(uuid, date) from anon;
revoke all on function public.workforce_recalculate_attendance_work_date(uuid, date) from authenticated;

revoke all on function public.workforce_clock_in(uuid) from public;
revoke all on function public.workforce_clock_in(uuid) from anon;
grant execute on function public.workforce_clock_in(uuid) to authenticated;

-- Recalculate historical scheduled rows so special-day classifications are ready
-- for reporting. Open rows remain zero until clock-out.
do $$
declare
  v_work_date record;
begin
  for v_work_date in
    select distinct attendance_row.user_id, attendance_row.work_date
    from public.attendance attendance_row
    where attendance_row.schedule_id is not null
      and attendance_row.clock_in is not null
    order by attendance_row.user_id, attendance_row.work_date
  loop
    begin
      perform public.workforce_recalculate_attendance_work_date(
        v_work_date.user_id,
        v_work_date.work_date
      );
    exception
      when others then
        raise warning
          'Special-day overtime backfill could not recalculate user %, work date %: %',
          v_work_date.user_id,
          v_work_date.work_date,
          sqlerrm;
    end;
  end loop;
end
$$;

insert into public.workforce_audit_logs (
  actor_user_id,
  action,
  entity_type,
  after_data,
  reason
) values (
  auth.uid(),
  'rest_day_holiday_overtime_enabled',
  'attendance',
  jsonb_build_object(
    'rest_day_clock_in_enabled', true,
    'holiday_clock_in_enabled', true,
    'rest_day_classification', 'rest_day_overtime_minutes',
    'holiday_classification', 'holiday_overtime_minutes included as normal overtime',
    'combined_rest_day_holiday_precedence', 'rest_day',
    'maximum_overtime_minutes_per_employee_work_date', 1200
  ),
  'Enabled RDOT and holiday overtime attendance'
);

commit;
