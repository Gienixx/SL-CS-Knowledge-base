-- Treat open schedules as flexible paid schedules. They retain no fixed clock
-- boundaries, but carry an explicit planned paid duration so actual attendance
-- can be classified into regular and reviewable overtime minutes.

begin;

alter table public.work_schedules
  add column if not exists planned_paid_minutes integer;

update public.work_schedules
set planned_paid_minutes = 480
where not is_rest_day
  and not is_holiday
  and shift_start is null
  and shift_end is null
  and planned_paid_minutes is null;

alter table public.work_schedules
  drop constraint if exists work_schedules_planned_paid_minutes_check;

alter table public.work_schedules
  add constraint work_schedules_planned_paid_minutes_check check (
    (
      not is_rest_day
      and not is_holiday
      and shift_start is null
      and shift_end is null
      and planned_paid_minutes between 15 and 1440
    )
    or (
      (
        is_rest_day
        or is_holiday
        or shift_start is not null
        or shift_end is not null
      )
      and planned_paid_minutes is null
    )
  );

comment on column public.work_schedules.planned_paid_minutes is
  'Expected paid duration for an open schedule without fixed clock boundaries; null for fixed, rest-day, and holiday schedules.';

create or replace function public.workforce_normalize_planned_paid_minutes()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.is_rest_day
     or new.is_holiday
     or new.shift_start is not null
     or new.shift_end is not null then
    new.planned_paid_minutes := null;
  elsif new.planned_paid_minutes is null then
    raise exception 'Open schedules require planned paid time.';
  end if;

  return new;
end;
$$;

drop trigger if exists work_schedules_normalize_planned_paid_minutes
  on public.work_schedules;
create trigger work_schedules_normalize_planned_paid_minutes
before insert or update of
  shift_start, shift_end, is_rest_day, is_holiday, planned_paid_minutes
on public.work_schedules
for each row execute function public.workforce_normalize_planned_paid_minutes();

revoke all on function public.workforce_normalize_planned_paid_minutes()
  from public, anon, authenticated;

drop function if exists public.workforce_admin_save_open_schedule(
  uuid, uuid, date, integer, text, text, text
);

create function public.workforce_admin_save_open_schedule(
  p_schedule_id uuid,
  p_user_id uuid,
  p_shift_date date,
  p_shift_sequence integer,
  p_timezone text,
  p_status text,
  p_notes text,
  p_planned_paid_minutes integer
)
returns public.work_schedules
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_existing public.work_schedules%rowtype;
  v_result public.work_schedules%rowtype;
  v_timezone text := coalesce(nullif(trim(p_timezone), ''), 'America/New_York');
  v_status text := coalesce(nullif(trim(p_status), ''), 'scheduled');
  v_notes text := nullif(trim(coalesce(p_notes, '')), '');
  v_has_meaningful_change boolean := false;
  v_attendance_id uuid;
begin
  if v_actor is null or not public.workforce_current_user_is_active() then
    raise exception 'Authentication and an active workforce profile are required.';
  end if;

  if p_user_id is null or p_shift_date is null then
    raise exception 'Employee and shift date are required.';
  end if;

  if not public.workforce_can_manage_user(p_user_id, 'manage_schedules') then
    raise exception 'You do not have permission to manage this employee schedule.';
  end if;

  select *
  into v_profile
  from public.profiles
  where user_id = p_user_id;

  if not found then
    raise exception 'Employee profile not found.';
  end if;

  if v_profile.is_agent is not true then
    raise exception 'Schedules can only be assigned to profiles with agent access.';
  end if;

  if v_profile.employment_status not in ('active', 'on_leave') then
    raise exception 'Schedules can only be assigned to active or on-leave employees.';
  end if;

  if p_shift_sequence is null or p_shift_sequence < 1 or p_shift_sequence > 99 then
    raise exception 'Shift sequence must be between 1 and 99.';
  end if;

  if p_planned_paid_minutes is null
     or p_planned_paid_minutes < 15
     or p_planned_paid_minutes > 1440 then
    raise exception 'Planned paid time must be between 15 minutes and 24 hours.';
  end if;

  if v_status not in ('scheduled', 'published', 'changed', 'cancelled', 'completed') then
    raise exception 'Invalid schedule status.';
  end if;

  perform now() at time zone v_timezone;

  if p_schedule_id is not null then
    select *
    into v_existing
    from public.work_schedules
    where id = p_schedule_id
    for update;

    if not found then
      raise exception 'Schedule entry not found.';
    end if;

    if not public.workforce_can_manage_user(v_existing.user_id, 'manage_schedules') then
      raise exception 'You do not have permission to modify the existing schedule owner.';
    end if;

    if v_existing.planned_paid_minutes is distinct from p_planned_paid_minutes
       and exists (
         select 1
         from public.attendance attendance_row
         where attendance_row.schedule_id = v_existing.id
           and attendance_row.review_status = 'locked'
       ) then
      raise exception 'Planned paid time cannot change after linked attendance is locked.';
    end if;
  end if;

  if exists (
    select 1
    from public.work_schedules schedule
    where schedule.user_id = p_user_id
      and schedule.shift_date = p_shift_date
      and schedule.shift_sequence = p_shift_sequence
      and (p_schedule_id is null or schedule.id <> p_schedule_id)
  ) then
    raise exception 'This employee already has the selected shift sequence on that date.';
  end if;

  if p_schedule_id is null then
    insert into public.work_schedules (
      user_id, team_id, shift_date, shift_sequence, shift_start, shift_end,
      timezone, status, is_rest_day, is_holiday, holiday_name, notes,
      planned_paid_minutes, created_by, updated_by
    ) values (
      p_user_id, v_profile.team_id, p_shift_date, p_shift_sequence::smallint,
      null, null, v_timezone, v_status, false, false, null, v_notes,
      p_planned_paid_minutes, v_actor, v_actor
    )
    returning * into v_result;
  else
    v_has_meaningful_change :=
      v_existing.user_id is distinct from p_user_id
      or v_existing.shift_date is distinct from p_shift_date
      or v_existing.shift_sequence is distinct from p_shift_sequence::smallint
      or v_existing.shift_start is not null
      or v_existing.shift_end is not null
      or v_existing.timezone is distinct from v_timezone
      or v_existing.is_rest_day
      or v_existing.is_holiday
      or v_existing.planned_paid_minutes is distinct from p_planned_paid_minutes;

    if v_existing.status in ('published', 'changed')
       and v_status = 'published'
       and v_has_meaningful_change then
      v_status := 'changed';
    end if;

    update public.work_schedules
    set user_id = p_user_id,
        team_id = v_profile.team_id,
        shift_date = p_shift_date,
        shift_sequence = p_shift_sequence::smallint,
        shift_start = null,
        shift_end = null,
        timezone = v_timezone,
        status = v_status,
        is_rest_day = false,
        is_holiday = false,
        holiday_name = null,
        notes = v_notes,
        planned_paid_minutes = p_planned_paid_minutes,
        updated_by = v_actor
    where id = p_schedule_id
    returning * into v_result;

    if v_has_meaningful_change then
      for v_attendance_id in
        select attendance_row.id
        from public.attendance attendance_row
        where attendance_row.schedule_id = v_result.id
          and attendance_row.review_status <> 'locked'
      loop
        perform public.workforce_recalculate_attendance(v_attendance_id);
      end loop;
    end if;
  end if;

  return v_result;
end;
$$;

comment on function public.workforce_admin_save_open_schedule(
  uuid, uuid, date, integer, text, text, text, integer
) is
  'Creates or updates a flexible paid schedule without fixed clock boundaries and recalculates unlocked linked attendance when its planned duration changes.';

revoke all on function public.workforce_admin_save_open_schedule(
  uuid, uuid, date, integer, text, text, text, integer
) from public, anon, authenticated;
grant execute on function public.workforce_admin_save_open_schedule(
  uuid, uuid, date, integer, text, text, text, integer
) to authenticated;

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

  if v_attendance.clock_out is null and exists (
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

    if v_attendance.work_date <> v_schedule.shift_date then
      raise exception 'Attendance work date must remain the linked schedule work date.';
    end if;

    v_is_open_schedule :=
      not v_schedule.is_rest_day
      and not v_schedule.is_holiday
      and v_schedule.shift_start is null
      and v_schedule.shift_end is null;

    if v_is_open_schedule and v_schedule.planned_paid_minutes is null then
      raise exception 'Open schedule attendance requires planned paid time.';
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

  v_available_overtime_minutes := greatest(0, 1200 - v_other_overtime_minutes);

  if v_is_open_schedule then
    if v_attendance.clock_out is not null
       and v_attendance.clock_out < v_attendance.clock_in then
      raise exception 'Clock-out cannot be earlier than clock-in.';
    end if;

    select
      0::integer as pre_shift_overtime_minutes,
      case
        when v_attendance.clock_out is null then 0
        else least(
          floor(extract(epoch from (v_attendance.clock_out - v_attendance.clock_in)) / 60)::integer,
          v_schedule.planned_paid_minutes
        )
      end as regular_minutes,
      case
        when v_attendance.clock_out is null then 0
        else least(
          greatest(
            floor(extract(epoch from (v_attendance.clock_out - v_attendance.clock_in)) / 60)::integer
              - v_schedule.planned_paid_minutes,
            0
          ),
          v_available_overtime_minutes
        )
      end as post_shift_overtime_minutes,
      0::integer as rest_day_overtime_minutes,
      0::integer as holiday_overtime_minutes,
      case
        when v_attendance.clock_out is null then 0
        else least(
          greatest(
            floor(extract(epoch from (v_attendance.clock_out - v_attendance.clock_in)) / 60)::integer
              - v_schedule.planned_paid_minutes,
            0
          ),
          v_available_overtime_minutes
        )
      end as total_overtime_minutes,
      case
        when v_attendance.clock_out is null then 0
        else floor(extract(epoch from (v_attendance.clock_out - v_attendance.clock_in)) / 60)::integer
      end as total_worked_minutes,
      0::integer as minutes_late,
      0::integer as undertime_minutes
    into v_calculation;
  else
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
  end if;

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
  'Recalculates fixed, special-day, unscheduled, and flexible open-schedule attendance; open schedules classify actual time against planned paid minutes without lateness or undertime.';

revoke all on function public.workforce_recalculate_attendance(uuid)
  from public, anon, authenticated;

create or replace view public.workforce_attendance_payroll_readiness
with (security_invoker = true)
as
with evaluated as (
  select
    attendance_row.*,
    array_remove(array[
      case when attendance_row.clock_in is null then 'missing_clock_in' end,
      case when attendance_row.clock_out is null then 'missing_clock_out' end,
      case
        when attendance_row.clock_in is not null
         and attendance_row.clock_out is not null
         and attendance_row.clock_out < attendance_row.clock_in
        then 'invalid_clock_order'
      end,
      case when attendance_row.schedule_id is null then 'missing_schedule' end,
      case
        when attendance_row.schedule_id is not null and schedule_row.id is null
        then 'invalid_schedule'
      end,
      case
        when schedule_row.id is not null
         and schedule_row.user_id is distinct from attendance_row.user_id
        then 'schedule_employee_mismatch'
      end,
      case
        when schedule_row.id is not null
         and schedule_row.shift_date is distinct from attendance_row.work_date
        then 'schedule_work_date_mismatch'
      end,
      case
        when schedule_row.id is not null
         and schedule_row.status not in ('published', 'changed', 'completed')
        then 'invalid_schedule_status'
      end,
      case
        when schedule_row.id is not null
         and not schedule_row.is_rest_day
         and (
           (schedule_row.shift_start is null) <> (schedule_row.shift_end is null)
           or (
             schedule_row.shift_start is not null
             and schedule_row.shift_end <= schedule_row.shift_start
           )
         )
        then 'invalid_schedule_shift'
      end,
      case
        when schedule_row.id is not null
         and not schedule_row.is_rest_day
         and not schedule_row.is_holiday
         and schedule_row.shift_start is null
         and schedule_row.shift_end is null
         and (
           schedule_row.planned_paid_minutes is null
           or schedule_row.planned_paid_minutes not between 15 and 1440
         )
        then 'open_schedule_planned_time_missing'
      end,
      case
        when attendance_row.pre_shift_overtime_minutes is null
          or attendance_row.regular_minutes is null
          or attendance_row.post_shift_overtime_minutes is null
        then 'calculations_missing'
      end,
      case
        when attendance_row.clock_in is not null
         and attendance_row.clock_out is not null
         and attendance_row.total_worked_minutes is distinct from greatest(
           0,
           floor(extract(epoch from (attendance_row.clock_out - attendance_row.clock_in)) / 60)::integer
         )
        then 'total_worked_mismatch'
      end,
      case
        when attendance_row.clock_out is not null
         and attendance_row.total_worked_minutes is distinct from (
           greatest(coalesce(attendance_row.regular_minutes, 0), 0)
           + greatest(coalesce(attendance_row.total_overtime_minutes, 0), 0)
         )
        then 'worked_minutes_unclassified'
      end,
      case
        when attendance_row.pre_shift_overtime_minutes is not null
         and attendance_row.post_shift_overtime_minutes is not null
         and attendance_row.total_overtime_minutes is distinct from (
           attendance_row.pre_shift_overtime_minutes
           + attendance_row.post_shift_overtime_minutes
           + attendance_row.rest_day_overtime_minutes
           + attendance_row.holiday_overtime_minutes
         )
        then 'total_overtime_mismatch'
      end,
      case
        when attendance_row.total_overtime_minutes < 0
          or attendance_row.total_overtime_minutes > 1200
        then 'attendance_overtime_limit_exceeded'
      end,
      case
        when sum(attendance_row.total_overtime_minutes) over (
          partition by attendance_row.user_id, attendance_row.work_date
        ) > 1200
        then 'work_date_overtime_limit_exceeded'
      end,
      case
        when attendance_row.attendance_status not in ('present', 'absent', 'on_leave', 'excused')
        then 'invalid_attendance_status'
      end,
      case
        when attendance_row.review_status not in ('approved', 'locked')
        then 'review_required'
      end
    ], null)::text[] as payroll_readiness_blockers
  from public.attendance attendance_row
  left join public.work_schedules schedule_row
    on schedule_row.id = attendance_row.schedule_id
)
select
  id,
  user_id,
  schedule_id,
  work_date,
  clock_in,
  clock_out,
  attendance_status,
  is_late,
  minutes_late,
  overtime_minutes,
  undertime_minutes,
  correction_reason,
  admin_notes,
  corrected_by,
  corrected_at,
  created_by,
  updated_by,
  created_at,
  updated_at,
  original_clock_in,
  original_clock_out,
  pre_shift_overtime_minutes,
  regular_minutes,
  post_shift_overtime_minutes,
  total_overtime_minutes,
  total_worked_minutes,
  is_corrected,
  review_status,
  reviewed_by,
  reviewed_at,
  rest_day_overtime_minutes,
  holiday_overtime_minutes,
  cardinality(payroll_readiness_blockers) = 0 as is_payroll_ready,
  payroll_readiness_blockers
from evaluated;

comment on view public.workforce_attendance_payroll_readiness is
  'Payroll-readiness projection including flexible open-schedule planned-time validation and complete worked-minute classification.';

revoke all on public.workforce_attendance_payroll_readiness from public, anon;
grant select on public.workforce_attendance_payroll_readiness
  to authenticated, service_role;

do $$
declare
  v_attendance_id uuid;
begin
  for v_attendance_id in
    select attendance_row.id
    from public.attendance attendance_row
    join public.work_schedules schedule
      on schedule.id = attendance_row.schedule_id
    where not schedule.is_rest_day
      and not schedule.is_holiday
      and schedule.shift_start is null
      and schedule.shift_end is null
      and attendance_row.review_status <> 'locked'
  loop
    perform public.workforce_recalculate_attendance(v_attendance_id);
  end loop;
end;
$$;

insert into public.workforce_audit_logs (
  actor_user_id,
  action,
  entity_type,
  after_data,
  reason
) values (
  auth.uid(),
  'open_schedule_attendance_classification_enabled',
  'attendance',
  jsonb_build_object(
    'default_planned_paid_minutes', 480,
    'late_and_undertime_minutes', 0,
    'excess_minutes_classification', 'post_shift_overtime',
    'approval_required_for_payroll', true
  ),
  'Classified flexible open-schedule attendance without adding fixed clock boundaries'
);

commit;
