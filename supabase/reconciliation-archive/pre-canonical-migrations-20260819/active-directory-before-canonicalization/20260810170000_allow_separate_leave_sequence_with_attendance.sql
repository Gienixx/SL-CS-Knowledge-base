begin;

create or replace function public.workforce_admin_save_nonworking_schedule(
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
  v_sequence integer := p_shift_sequence;
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
    raise exception 'Select a valid absent type.';
  end if;
  if v_status not in ('scheduled', 'published', 'changed', 'cancelled', 'completed') then
    raise exception 'Invalid schedule status.';
  end if;

  select * into v_profile from public.profiles where user_id = p_user_id;
  if not found then raise exception 'Employee profile not found.'; end if;
  if v_profile.is_agent is not true
     or v_profile.employment_status not in ('active', 'on_leave') then
    raise exception 'This schedule can only be assigned to active workforce participants.';
  end if;
  if v_sequence is null or v_sequence < 1 or v_sequence > 99 then
    raise exception 'Shift sequence must be between 1 and 99.';
  end if;

  if p_schedule_id is not null then
    select * into v_existing
    from public.work_schedules
    where id = p_schedule_id
    for update;
    if not found then raise exception 'Schedule entry not found.'; end if;
    if not public.workforce_can_manage_user(v_existing.user_id, 'manage_schedules') then
      raise exception 'You do not have permission to modify the existing schedule owner.';
    end if;

    -- An attended schedule remains a work schedule.  A leave request made from
    -- that editor creates a separate untimed sequence instead of converting it.
    if exists (
      select 1 from public.attendance attendance_row
      where attendance_row.schedule_id = v_existing.id
    ) then
      if v_schedule_type <> 'leave' then
        raise exception 'A schedule with attendance cannot be changed to leave or absent.';
      end if;

      if exists (
        select 1 from public.work_schedules schedule
        where schedule.user_id = p_user_id
          and schedule.shift_date = p_shift_date
          and schedule.is_leave
          and schedule.leave_type = v_subtype
      ) then
        raise exception 'This employee already has this leave type on the selected date.';
      end if;

      select coalesce(max(schedule.shift_sequence), 0) + 1
      into v_sequence
      from public.work_schedules schedule
      where schedule.user_id = p_user_id
        and schedule.shift_date = p_shift_date;
      if v_sequence > 99 then raise exception 'No available schedule sequence remains on this date.'; end if;

      insert into public.work_schedules (
        user_id, team_id, shift_date, shift_sequence, shift_start, shift_end,
        timezone, status, is_rest_day, is_holiday, is_leave, is_absent,
        leave_type, absence_type, holiday_name, notes, planned_paid_minutes,
        created_by, updated_by
      ) values (
        p_user_id, v_profile.team_id, p_shift_date, v_sequence::smallint,
        null, null, v_timezone, v_status, false, false, true, false,
        v_subtype, null, null, v_notes, null, v_actor, v_actor
      ) returning * into v_result;

      insert into public.workforce_audit_logs (
        actor_user_id, action, entity_type, entity_id, before_data, after_data, reason
      ) values (
        v_actor,
        'separate_leave_sequence_created',
        'work_schedule',
        v_result.id,
        to_jsonb(v_existing),
        to_jsonb(v_result),
        'Created a separate leave sequence because the selected schedule has linked attendance'
      );
      return v_result;
    end if;
  end if;

  if v_schedule_type = 'leave'
     and exists (
       select 1 from public.work_schedules schedule
       where schedule.user_id = p_user_id
         and schedule.shift_date = p_shift_date
         and schedule.is_leave
         and schedule.leave_type = v_subtype
         and (p_schedule_id is null or schedule.id <> p_schedule_id)
     ) then
    raise exception 'This employee already has this leave type on the selected date.';
  end if;

  if exists (
    select 1 from public.work_schedules schedule
    where schedule.user_id = p_user_id
      and schedule.shift_date = p_shift_date
      and schedule.shift_sequence = v_sequence
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
      p_user_id, v_profile.team_id, p_shift_date, v_sequence::smallint,
      null, null, v_timezone, v_status, false, false,
      v_schedule_type = 'leave', v_schedule_type = 'absent',
      case when v_schedule_type = 'leave' then v_subtype else null end,
      case when v_schedule_type = 'absent' then v_subtype else null end,
      null, v_notes, null, v_actor, v_actor
    ) returning * into v_result;
  else
    v_has_meaningful_change :=
      v_existing.user_id is distinct from p_user_id
      or v_existing.shift_date is distinct from p_shift_date
      or v_existing.shift_sequence is distinct from v_sequence::smallint
      or v_existing.shift_start is not null
      or v_existing.shift_end is not null
      or v_existing.timezone is distinct from v_timezone
      or v_existing.is_rest_day
      or v_existing.is_holiday
      or v_existing.is_leave is distinct from (v_schedule_type = 'leave')
      or v_existing.is_absent is distinct from (v_schedule_type = 'absent')
      or v_existing.leave_type is distinct from case when v_schedule_type = 'leave' then v_subtype else null end
      or v_existing.absence_type is distinct from case when v_schedule_type = 'absent' then v_subtype else null end;

    if v_existing.status in ('published', 'changed') and v_status = 'published' and v_has_meaningful_change then
      v_status := 'changed';
    end if;

    update public.work_schedules
    set user_id = p_user_id,
        team_id = v_profile.team_id,
        shift_date = p_shift_date,
        shift_sequence = v_sequence::smallint,
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

insert into public.workforce_audit_logs (
  actor_user_id, action, entity_type, after_data, reason
) values (
  null,
  'separate_leave_sequence_with_attendance_enabled',
  'work_schedules',
  jsonb_build_object('attendance_preserved', true, 'duplicate_leave_blocked', true, 'next_sequence_created', true),
  'Allows a separate untimed leave sequence when the selected work schedule already owns attendance'
);

commit;
