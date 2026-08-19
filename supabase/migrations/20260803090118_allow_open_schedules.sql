-- Allow administrators to publish a dated schedule placeholder without fixed
-- shift times. Open schedules carry no scheduled/prepaid hours and cannot be
-- confused with rest days or holidays.

begin;

alter table public.work_schedules
  drop constraint work_schedules_time_check;

alter table public.work_schedules
  add constraint work_schedules_time_check check (
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
  );

create or replace function public.workforce_admin_save_open_schedule(
  p_schedule_id uuid,
  p_user_id uuid,
  p_shift_date date,
  p_shift_sequence integer,
  p_timezone text,
  p_status text,
  p_notes text
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
      p_user_id, v_profile.team_id, p_shift_date, p_shift_sequence::smallint,
      null, null, v_timezone, v_status, false, false, null, v_notes,
      v_actor, v_actor
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
      or v_existing.is_holiday;

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
        updated_by = v_actor
    where id = p_schedule_id
    returning * into v_result;
  end if;

  return v_result;
end;
$$;

comment on function public.workforce_admin_save_open_schedule(uuid, uuid, date, integer, text, text, text) is
  'Creates or updates a non-payable dated schedule placeholder without fixed shift times.';

revoke all on function public.workforce_admin_save_open_schedule(uuid, uuid, date, integer, text, text, text)
  from public, anon, authenticated;

grant execute on function public.workforce_admin_save_open_schedule(uuid, uuid, date, integer, text, text, text)
  to authenticated;

commit;
