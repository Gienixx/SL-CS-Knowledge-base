begin;

-- Resolve current linked schedules for display independently of the set of
-- schedules eligible for a new correction/reassignment. This preserves the
-- existing attendance and schedule permission boundaries.
create or replace function public.workforce_get_attendance_schedule_display(
  p_schedule_ids uuid[]
)
returns table (
  schedule_id uuid,
  shift_date date,
  shift_sequence smallint,
  shift_start timestamptz,
  shift_end timestamptz,
  timezone text,
  status text,
  is_rest_day boolean,
  is_holiday boolean,
  is_leave boolean,
  is_absent boolean,
  holiday_name text,
  leave_type text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_current_profile public.profiles%rowtype;
  v_is_admin boolean := false;
begin
  if auth.uid() is null
     or public.workforce_current_profile_id() is null
     or not public.workforce_current_user_is_active() then
    raise exception
      using errcode = '42501',
        message = 'Authentication and an active workforce profile are required.';
  end if;

  select profile.*
  into v_current_profile
  from public.profiles profile
  where profile.user_id = public.workforce_current_profile_id();

  if not found then
    raise exception
      using errcode = '42501',
        message = 'An active workforce profile is required.';
  end if;

  v_is_admin := public.workforce_is_admin();
  if v_is_admin
     and not public.workforce_has_permission('view_team_attendance') then
    raise exception
      using errcode = '42501',
        message = 'You do not have permission to view team attendance.';
  end if;

  if not v_is_admin and v_current_profile.is_agent is not true then
    raise exception
      using errcode = '42501',
        message = 'Team attendance is available only to administrators and active agents.';
  end if;

  if p_schedule_ids is null or cardinality(p_schedule_ids) = 0 then
    return;
  end if;

  return query
  select
    schedule.id,
    schedule.shift_date,
    schedule.shift_sequence,
    schedule.shift_start,
    schedule.shift_end,
    schedule.timezone,
    schedule.status,
    schedule.is_rest_day,
    schedule.is_holiday,
    schedule.is_leave,
    schedule.is_absent,
    schedule.holiday_name,
    schedule.leave_type
  from public.work_schedules schedule
  where schedule.id = any(p_schedule_ids)
    and (v_is_admin or schedule.user_id = v_current_profile.user_id)
  order by schedule.shift_date, schedule.shift_sequence, schedule.id;
end;
$$;

revoke all on function public.workforce_get_attendance_schedule_display(uuid[]) from public, anon, authenticated;
grant execute on function public.workforce_get_attendance_schedule_display(uuid[]) to authenticated, service_role;

comment on function public.workforce_get_attendance_schedule_display(uuid[]) is
  'Returns current linked schedule metadata for Team Attendance display without changing reassignment candidate eligibility.';

commit;
