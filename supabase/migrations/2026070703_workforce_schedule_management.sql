-- Workforce Phase 1 Step 4 — Schedule management
-- Adds a server-authorized transactional RPC for creating and editing schedules.

create or replace function public.workforce_admin_save_schedule(
  p_schedule_id uuid,
  p_user_id uuid,
  p_shift_date date,
  p_shift_sequence integer,
  p_shift_start timestamptz,
  p_shift_end timestamptz,
  p_timezone text,
  p_status text,
  p_is_rest_day boolean,
  p_is_holiday boolean,
  p_holiday_name text,
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
  v_timezone text := coalesce(nullif(trim(p_timezone), ''), 'Asia/Manila');
  v_status text := coalesce(nullif(trim(p_status), ''), 'scheduled');
  v_holiday_name text := nullif(trim(coalesce(p_holiday_name, '')), '');
  v_notes text := nullif(trim(coalesce(p_notes, '')), '');
  v_is_rest_day boolean := coalesce(p_is_rest_day, false);
  v_is_holiday boolean := coalesce(p_is_holiday, false);
  v_has_meaningful_change boolean := false;
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

  select * into v_profile
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

  if v_status not in ('scheduled', 'published', 'changed', 'cancelled', 'completed') then
    raise exception 'Invalid schedule status.';
  end if;

  perform now() at time zone v_timezone;

  if v_is_rest_day then
    if p_shift_start is not null or p_shift_end is not null then
      raise exception 'Rest days cannot contain shift start or end times.';
    end if;
  else
    if p_shift_start is null or p_shift_end is null then
      raise exception 'Shift start and end times are required.';
    end if;

    if p_shift_end <= p_shift_start then
      raise exception 'Shift end must be later than shift start.';
    end if;

    if (p_shift_start at time zone v_timezone)::date <> p_shift_date then
      raise exception 'Shift start must fall on the selected shift date in the employee timezone.';
    end if;
  end if;

  if v_is_holiday and v_holiday_name is null then
    raise exception 'Holiday name is required when marking a holiday.';
  end if;

  if not v_is_holiday then
    v_holiday_name := null;
  end if;

  if p_schedule_id is not null then
    select * into v_existing
    from public.work_schedules
    where id = p_schedule_id
    for update;

    if not found then
      raise exception 'Schedule entry not found.';
    end if;

    if not public.workforce_can_manage_user(v_existing.user_id, 'manage_schedules') then
      raise exception 'You do not have permission to modify the existing schedule owner.';
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
      created_by, updated_by
    ) values (
      p_user_id,
      v_profile.team_id,
      p_shift_date,
      p_shift_sequence::smallint,
      case when v_is_rest_day then null else p_shift_start end,
      case when v_is_rest_day then null else p_shift_end end,
      v_timezone,
      v_status,
      v_is_rest_day,
      v_is_holiday,
      v_holiday_name,
      v_notes,
      v_actor,
      v_actor
    ) returning * into v_result;
  else
    v_has_meaningful_change :=
      v_existing.user_id is distinct from p_user_id
      or v_existing.shift_date is distinct from p_shift_date
      or v_existing.shift_sequence is distinct from p_shift_sequence::smallint
      or v_existing.shift_start is distinct from p_shift_start
      or v_existing.shift_end is distinct from p_shift_end
      or v_existing.timezone is distinct from v_timezone
      or v_existing.is_rest_day is distinct from v_is_rest_day
      or v_existing.is_holiday is distinct from v_is_holiday
      or v_existing.holiday_name is distinct from v_holiday_name;

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
        shift_start = case when v_is_rest_day then null else p_shift_start end,
        shift_end = case when v_is_rest_day then null else p_shift_end end,
        timezone = v_timezone,
        status = v_status,
        is_rest_day = v_is_rest_day,
        is_holiday = v_is_holiday,
        holiday_name = v_holiday_name,
        notes = v_notes,
        updated_by = v_actor
    where id = p_schedule_id
    returning * into v_result;
  end if;

  return v_result;
end;
$$;

revoke execute on function public.workforce_admin_save_schedule(
  uuid, uuid, date, integer, timestamptz, timestamptz, text, text,
  boolean, boolean, text, text
) from public;

revoke execute on function public.workforce_admin_save_schedule(
  uuid, uuid, date, integer, timestamptz, timestamptz, text, text,
  boolean, boolean, text, text
) from anon;

grant execute on function public.workforce_admin_save_schedule(
  uuid, uuid, date, integer, timestamptz, timestamptz, text, text,
  boolean, boolean, text, text
) to authenticated;
