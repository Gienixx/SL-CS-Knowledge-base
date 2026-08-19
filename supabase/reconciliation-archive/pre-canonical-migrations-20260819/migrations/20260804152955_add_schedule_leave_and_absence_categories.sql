begin;

alter table public.work_schedules
  add column if not exists is_absent boolean not null default false,
  add column if not exists leave_type text,
  add column if not exists absence_type text;

comment on column public.work_schedules.is_absent is
  'Marks a non-working absence schedule.';
comment on column public.work_schedules.leave_type is
  'Leave classification: incentive_vl, birthday_vl, or leave_without_pay.';
comment on column public.work_schedules.absence_type is
  'Absence classification: with_notification or without_notification.';

alter table public.work_schedules
  add constraint work_schedules_special_type_check check (
    not (is_leave and is_absent)
    and (
      (is_leave and (leave_type is null or leave_type in (
        'incentive_vl', 'birthday_vl', 'leave_without_pay'
      )))
      or (not is_leave and leave_type is null)
    )
    and (
      (is_absent and absence_type in (
        'with_notification', 'without_notification'
      ))
      or (not is_absent and absence_type is null)
    )
  );

alter table public.work_schedules
  drop constraint if exists work_schedules_time_check;

alter table public.work_schedules
  add constraint work_schedules_time_check check (
    (
      (is_leave or is_absent)
      and not is_rest_day
      and not is_holiday
      and shift_start is null
      and shift_end is null
    )
    or (
      not is_leave
      and not is_absent
      and (
        (
          is_rest_day
          and shift_start is null
          and shift_end is null
        )
        or (
          not is_rest_day
          and (
            (
              not is_holiday
              and shift_start is null
              and shift_end is null
            )
            or (
              shift_start is not null
              and shift_end is not null
              and shift_end > shift_start
            )
          )
        )
      )
    )
  );

alter table public.work_schedules
  drop constraint if exists work_schedules_planned_paid_minutes_check;

alter table public.work_schedules
  add constraint work_schedules_planned_paid_minutes_check check (
    (
      (is_leave or is_absent)
      and planned_paid_minutes is null
    )
    or (
      not is_leave
      and not is_absent
      and (
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
      )
    )
  );

create or replace function public.workforce_clear_leave_on_schedule_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (old.is_leave or old.is_absent)
     and (
       new.is_rest_day
       or new.is_holiday
       or new.shift_start is not null
       or new.shift_end is not null
       or new.planned_paid_minutes is not null
     ) then
    new.is_leave := false;
    new.is_absent := false;
  end if;

  if not new.is_leave then
    new.leave_type := null;
  end if;

  if not new.is_absent then
    new.absence_type := null;
  end if;

  return new;
end;
$$;

drop trigger if exists work_schedules_clear_leave_on_schedule_change
  on public.work_schedules;
create trigger work_schedules_clear_leave_on_schedule_change
before update of
  shift_start, shift_end, is_rest_day, is_holiday, is_leave, is_absent,
  leave_type, absence_type, planned_paid_minutes
on public.work_schedules
for each row execute function public.workforce_clear_leave_on_schedule_change();

revoke all on function public.workforce_clear_leave_on_schedule_change()
  from public, anon, authenticated;

create or replace function public.workforce_normalize_planned_paid_minutes()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.is_leave
     or new.is_absent
     or new.is_rest_day
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
  shift_start, shift_end, is_rest_day, is_holiday, is_leave, is_absent,
  planned_paid_minutes
on public.work_schedules
for each row execute function public.workforce_normalize_planned_paid_minutes();

revoke all on function public.workforce_normalize_planned_paid_minutes()
  from public, anon, authenticated;

create function public.workforce_admin_save_nonworking_schedule(
  p_schedule_id uuid,
  p_user_id uuid,
  p_shift_date date,
  p_shift_sequence integer,
  p_timezone text,
  p_status text,
  p_schedule_type text,
  p_subtype text,
  p_notes text
)
returns public.work_schedules
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_existing public.work_schedules%rowtype;
  v_result public.work_schedules%rowtype;
  v_timezone text := coalesce(nullif(trim(p_timezone), ''), 'America/New_York');
  v_status text := coalesce(nullif(trim(p_status), ''), 'published');
  v_schedule_type text := lower(trim(coalesce(p_schedule_type, '')));
  v_subtype text := lower(trim(coalesce(p_subtype, '')));
  v_notes text := nullif(trim(coalesce(p_notes, '')), '');
  v_has_meaningful_change boolean := false;
begin
  if v_actor is null or not public.workforce_current_user_is_active() then
    raise exception 'Authentication and an active workforce profile are required.';
  end if;

  if p_user_id is null or p_shift_date is null then
    raise exception 'Employee and schedule date are required.';
  end if;

  if not public.workforce_can_manage_user(p_user_id, 'manage_schedules') then
    raise exception 'You do not have permission to manage this employee schedule.';
  end if;

  if v_schedule_type not in ('leave', 'absent') then
    raise exception 'Non-working schedule type must be leave or absent.';
  end if;

  if v_schedule_type = 'leave'
     and v_subtype not in ('incentive_vl', 'birthday_vl', 'leave_without_pay') then
    raise exception 'Select a valid leave type.';
  end if;

  if v_schedule_type = 'absent'
     and v_subtype not in ('with_notification', 'without_notification') then
    raise exception 'Select a valid absence type.';
  end if;

  select *
  into v_profile
  from public.profiles
  where user_id = p_user_id;

  if not found then
    raise exception 'Employee profile not found.';
  end if;

  if v_profile.is_agent is not true
     or v_profile.employment_status not in ('active', 'on_leave') then
    raise exception 'This schedule can only be assigned to active workforce participants.';
  end if;

  if p_shift_sequence is null or p_shift_sequence < 1 or p_shift_sequence > 99 then
    raise exception 'Shift sequence must be between 1 and 99.';
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

    if exists (
      select 1
      from public.attendance attendance_row
      where attendance_row.schedule_id = v_existing.id
    ) then
      raise exception 'A schedule with attendance cannot be changed to leave or absent.';
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
      timezone, status, is_rest_day, is_holiday, is_leave, is_absent,
      leave_type, absence_type, holiday_name, notes, planned_paid_minutes,
      created_by, updated_by
    ) values (
      p_user_id, v_profile.team_id, p_shift_date, p_shift_sequence::smallint,
      null, null, v_timezone, v_status, false, false,
      v_schedule_type = 'leave', v_schedule_type = 'absent',
      case when v_schedule_type = 'leave' then v_subtype else null end,
      case when v_schedule_type = 'absent' then v_subtype else null end,
      null, v_notes, null, v_actor, v_actor
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
      or v_existing.is_leave is distinct from (v_schedule_type = 'leave')
      or v_existing.is_absent is distinct from (v_schedule_type = 'absent')
      or v_existing.leave_type is distinct from (
        case when v_schedule_type = 'leave' then v_subtype else null end
      )
      or v_existing.absence_type is distinct from (
        case when v_schedule_type = 'absent' then v_subtype else null end
      );

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
        is_leave = v_schedule_type = 'leave',
        is_absent = v_schedule_type = 'absent',
        leave_type = case when v_schedule_type = 'leave' then v_subtype else null end,
        absence_type = case when v_schedule_type = 'absent' then v_subtype else null end,
        holiday_name = null,
        notes = v_notes,
        planned_paid_minutes = null,
        updated_by = v_actor
    where id = p_schedule_id
    returning * into v_result;
  end if;

  return v_result;
end;
$$;

revoke all on function public.workforce_admin_save_nonworking_schedule(
  uuid, uuid, date, integer, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.workforce_admin_save_nonworking_schedule(
  uuid, uuid, date, integer, text, text, text, text, text
) to authenticated, service_role;

comment on function public.workforce_admin_save_nonworking_schedule(
  uuid, uuid, date, integer, text, text, text, text, text
) is
  'Creates or updates a protected leave or absence schedule with its required classification.';

create or replace function public.workforce_reject_attended_leave_schedule()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.is_leave or new.is_absent)
     and exists (
       select 1
       from public.attendance attendance_row
       where attendance_row.schedule_id = new.id
     ) then
    raise exception 'A schedule with attendance cannot be changed to leave or absent.';
  end if;

  return new;
end;
$$;

drop trigger if exists work_schedules_reject_attended_leave
on public.work_schedules;
create trigger work_schedules_reject_attended_leave
before insert or update of is_leave, is_absent on public.work_schedules
for each row execute function public.workforce_reject_attended_leave_schedule();

revoke all on function public.workforce_reject_attended_leave_schedule()
  from public, anon, authenticated;

create or replace function public.workforce_reject_leave_attendance()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_is_leave boolean := false;
  v_is_absent boolean := false;
begin
  if new.schedule_id is not null then
    select schedule.is_leave, schedule.is_absent
    into v_is_leave, v_is_absent
    from public.work_schedules schedule
    where schedule.id = new.schedule_id;
  end if;

  if v_is_leave then
    raise exception 'Attendance cannot be recorded for a leave schedule.';
  end if;

  if v_is_absent then
    raise exception 'Attendance cannot be recorded for an absent schedule.';
  end if;

  return new;
end;
$$;

drop trigger if exists attendance_reject_leave_schedule on public.attendance;
create trigger attendance_reject_leave_schedule
before insert or update of schedule_id on public.attendance
for each row execute function public.workforce_reject_leave_attendance();

revoke all on function public.workforce_reject_leave_attendance()
  from public, anon, authenticated;

insert into public.workforce_audit_logs (
  actor_user_id,
  action,
  entity_type,
  after_data,
  reason
) values (
  null,
  'schedule_leave_absence_categories_enabled',
  'work_schedules',
  jsonb_build_object(
    'leave_types', jsonb_build_array('incentive_vl', 'birthday_vl', 'leave_without_pay'),
    'absence_types', jsonb_build_array('with_notification', 'without_notification')
  ),
  'Added controlled leave and absence classifications to schedule management'
);

commit;
