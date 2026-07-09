-- Phase 1, Step 9: trusted server-side attendance calculations.
--
-- Centralizes attendance interval classification in PostgreSQL, replaces inline
-- clock RPC arithmetic, and enforces the 20-hour overtime ceiling per employee
-- and scheduled work date.

begin;

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
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_available_overtime_minutes integer;
  v_raw_pre_shift_minutes integer := 0;
  v_raw_post_shift_minutes integer := 0;
  v_has_schedule boolean;
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

  v_has_schedule := p_scheduled_start is not null;

  if v_has_schedule then
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

  if not v_has_schedule then
    pre_shift_overtime_minutes := null;
    regular_minutes := null;
    post_shift_overtime_minutes := null;
    total_overtime_minutes := 0;
    minutes_late := 0;
    undertime_minutes := 0;
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
    regular_minutes := 0;
    post_shift_overtime_minutes := 0;
    total_overtime_minutes := pre_shift_overtime_minutes;
    undertime_minutes := 0;
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
  timestamptz, timestamptz, timestamptz, timestamptz, date, text, integer
) is
  'Classifies effective attendance timestamps into credited pre-shift overtime, regular time, credited post-shift overtime, total worked time, lateness, and undertime.';

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

    if v_schedule.is_rest_day
       or v_schedule.shift_start is null
       or v_schedule.shift_end is null then
      raise exception 'Attendance cannot be calculated from a rest day or incomplete schedule.';
    end if;

    if v_attendance.work_date <> v_schedule.shift_date then
      raise exception 'Attendance work date must remain the linked schedule work date.';
    end if;

    if exists (
      select 1
      from public.attendance other_attendance
      join public.work_schedules other_schedule
        on other_schedule.id = other_attendance.schedule_id
      where other_attendance.user_id = v_attendance.user_id
        and other_attendance.work_date = v_attendance.work_date
        and other_attendance.id <> v_attendance.id
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
    v_available_overtime_minutes
  );

  update public.attendance
  set pre_shift_overtime_minutes = v_calculation.pre_shift_overtime_minutes,
      regular_minutes = v_calculation.regular_minutes,
      post_shift_overtime_minutes = v_calculation.post_shift_overtime_minutes,
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
  'Locks and recalculates one attendance record while enforcing the aggregate 1,200-minute overtime ceiling for the employee work date.';

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
    order by schedule.shift_start, schedule.shift_sequence, attendance_row.created_at
  loop
    perform public.workforce_recalculate_attendance(v_attendance_id);
  end loop;
end;
$$;

comment on function public.workforce_recalculate_attendance_work_date(uuid, date) is
  'Recalculates scheduled attendance records for one employee work date in shift order so the aggregate overtime ceiling is allocated consistently.';

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

do $$
begin
  if exists (
    select 1
    from public.attendance attendance_row
    where attendance_row.clock_in is not null
      and attendance_row.clock_out is null
    group by attendance_row.user_id
    having count(*) > 1
  ) then
    raise exception 'Multiple open attendance sessions must be resolved before applying Step 9.';
  end if;
end
$$;

create unique index if not exists attendance_one_open_session_per_user_idx
  on public.attendance (user_id)
  where clock_in is not null and clock_out is null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'attendance_structured_totals_check'
      and conrelid = 'public.attendance'::regclass
  ) then
    alter table public.attendance
      add constraint attendance_structured_totals_check check (
        (
          pre_shift_overtime_minutes is null
          and regular_minutes is null
          and post_shift_overtime_minutes is null
        )
        or (
          pre_shift_overtime_minutes is not null
          and regular_minutes is not null
          and post_shift_overtime_minutes is not null
          and total_overtime_minutes =
            pre_shift_overtime_minutes + post_shift_overtime_minutes
          and total_overtime_minutes <= 1200
          and (
            clock_out is null
            or total_worked_minutes >=
              pre_shift_overtime_minutes
              + regular_minutes
              + post_shift_overtime_minutes
          )
        )
      ) not valid;
  end if;
end
$$;

alter table public.attendance
  validate constraint attendance_structured_totals_check;

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

create or replace function public.workforce_clock_out()
returns public.attendance
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_auth_user_id uuid := auth.uid();
  v_profile_user_id uuid;
  v_clock_time timestamptz := now();
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

  update public.attendance
  set clock_out = v_clock_time,
      updated_by = v_auth_user_id
  where id = v_existing.id
  returning * into v_result;

  return public.workforce_recalculate_attendance(v_result.id);
end;
$$;

revoke all on function public.workforce_clock_in(uuid) from public;
revoke all on function public.workforce_clock_in(uuid) from anon;
grant execute on function public.workforce_clock_in(uuid) to authenticated;

revoke all on function public.workforce_clock_out() from public;
revoke all on function public.workforce_clock_out() from anon;
grant execute on function public.workforce_clock_out() to authenticated;

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
          'Step 9 could not backfill attendance for user %, work date %: %',
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
  'attendance_structured_calculation_enabled',
  'attendance',
  jsonb_build_object(
    'trusted_server_side_calculation', true,
    'pre_shift_overtime', true,
    'regular_minutes', true,
    'post_shift_overtime', true,
    'late_minutes', true,
    'undertime_minutes', true,
    'overnight_shift_support', true,
    'multiple_shift_support', true,
    'one_open_session_enforced', true,
    'maximum_overtime_minutes_per_employee_work_date', 1200,
    'clock_rpcs_use_shared_calculator', true
  ),
  'Enabled Phase 1 Step 9 trusted attendance calculations and aggregate overtime enforcement'
);

commit;
