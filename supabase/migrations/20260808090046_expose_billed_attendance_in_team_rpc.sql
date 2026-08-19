-- Step 2.5: expose existing billed attendance values to Team Attendance.
-- Query behavior, scope, ordering, and permissions intentionally match the
-- canonical listing RPC; only its return contract is extended.

begin;

drop function if exists public.workforce_list_team_attendance(date, date);

create function public.workforce_list_team_attendance(
  p_start_date date,
  p_end_date date
)
returns table (
  attendance_id uuid, employee_user_id uuid, employee_name text,
  employee_email text, employee_id text, employee_timezone text,
  team_id uuid, team_name text, work_date date, schedule_id uuid,
  shift_sequence smallint, scheduled_start timestamptz, scheduled_end timestamptz,
  schedule_timezone text, schedule_status text, clock_in timestamptz,
  clock_out timestamptz, original_clock_in timestamptz,
  original_clock_out timestamptz, billed_clock_in timestamptz,
  billed_clock_out timestamptz, regular_minutes integer,
  pre_shift_overtime_minutes integer, post_shift_overtime_minutes integer,
  total_overtime_minutes integer, total_worked_minutes integer,
  minutes_late integer, undertime_minutes integer, attendance_status text,
  is_corrected boolean, review_status text, corrected_by uuid,
  corrected_by_name text, corrected_at timestamptz, correction_reason text,
  admin_notes text, is_open boolean, is_missing_clock_out boolean
)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_current_profile public.profiles%rowtype;
  v_is_admin boolean := false;
  v_today date;
begin
  if auth.uid() is null
     or public.workforce_current_profile_id() is null
     or not public.workforce_current_user_is_active() then
    raise exception using errcode = '42501',
      message = 'Authentication and an active workforce profile are required.';
  end if;

  select profile.* into v_current_profile
  from public.profiles profile
  where profile.user_id = public.workforce_current_profile_id();
  if not found then
    raise exception using errcode = '42501',
      message = 'An active workforce profile is required.';
  end if;

  v_is_admin := public.workforce_is_admin();
  v_today := (now() at time zone coalesce(nullif(v_current_profile.timezone, ''), 'America/New_York'))::date;

  if v_is_admin and not public.workforce_has_permission('view_team_attendance') then
    raise exception using errcode = '42501', message = 'You do not have permission to view team attendance.';
  end if;
  if not v_is_admin and v_current_profile.is_agent is not true then
    raise exception using errcode = '42501', message = 'Team attendance is available only to administrators and active agents.';
  end if;
  if p_start_date is null or p_end_date is null then
    raise exception using errcode = '22004', message = 'Start date and end date are required.';
  end if;
  if p_end_date < p_start_date then
    raise exception using errcode = '22007', message = 'End date cannot be earlier than start date.';
  end if;
  if p_end_date - p_start_date > 366 then
    raise exception using errcode = '22023', message = 'Team attendance date ranges cannot exceed 367 calendar days.';
  end if;

  return query
  select
    attendance_row.id, attendance_row.user_id, employee.full_name,
    case when v_is_admin then employee.email else null end,
    case when v_is_admin then employee.employee_id else null end,
    employee.timezone, employee.team_id, employee_team.name,
    attendance_row.work_date, attendance_row.schedule_id, schedule.shift_sequence,
    schedule.shift_start, schedule.shift_end, schedule.timezone, schedule.status,
    attendance_row.clock_in, attendance_row.clock_out,
    case when v_is_admin then attendance_row.original_clock_in else null end,
    case when v_is_admin then attendance_row.original_clock_out else null end,
    case when v_is_admin then attendance_row.billed_clock_in else null end,
    case when v_is_admin then attendance_row.billed_clock_out else null end,
    case when v_is_admin then attendance_row.regular_minutes else null end,
    case when v_is_admin then attendance_row.pre_shift_overtime_minutes else null end,
    case when v_is_admin then attendance_row.post_shift_overtime_minutes else null end,
    case when v_is_admin then attendance_row.total_overtime_minutes else null end,
    case when v_is_admin then attendance_row.total_worked_minutes else null end,
    case when v_is_admin then attendance_row.minutes_late else null end,
    case when v_is_admin then attendance_row.undertime_minutes else null end,
    attendance_row.attendance_status,
    case when v_is_admin then attendance_row.is_corrected else false end,
    case when v_is_admin then attendance_row.review_status else 'pending' end,
    case when v_is_admin then attendance_row.corrected_by else null end,
    case when not v_is_admin or attendance_row.corrected_by is null then null
      when corrector.full_name is not null then corrector.full_name
      else 'Former workforce user' end,
    case when v_is_admin then attendance_row.corrected_at else null end,
    case when v_is_admin then attendance_row.correction_reason else null end,
    case when v_is_admin then attendance_row.admin_notes else null end,
    attendance_row.clock_in is not null and attendance_row.clock_out is null,
    attendance_row.clock_in is not null and attendance_row.clock_out is null
      and ((schedule.shift_end is not null and schedule.shift_end < now())
        or attendance_row.work_date < (now() at time zone coalesce(nullif(employee.timezone, ''), 'America/New_York'))::date)
  from public.attendance attendance_row
  join public.profiles employee on employee.user_id = attendance_row.user_id
  left join public.teams employee_team on employee_team.id = employee.team_id
  left join public.work_schedules schedule on schedule.id = attendance_row.schedule_id
  left join public.profiles corrector on corrector.user_id = attendance_row.corrected_by
  where (v_is_admin and attendance_row.work_date between p_start_date and p_end_date
    and public.workforce_can_manage_user(attendance_row.user_id, 'view_team_attendance'))
    or (not v_is_admin and attendance_row.clock_in is not null
      and attendance_row.clock_out is null
      and coalesce(schedule.shift_date, attendance_row.work_date) = v_today)
  order by attendance_row.work_date desc, schedule.shift_start desc nulls last,
    attendance_row.clock_in desc nulls last, attendance_row.created_at desc;
end;
$$;

revoke all on function public.workforce_list_team_attendance(date, date)
  from public, anon, authenticated;
grant execute on function public.workforce_list_team_attendance(date, date)
  to authenticated, service_role;

comment on function public.workforce_list_team_attendance(date, date) is
  'Returns permission-scoped history with immutable original and manager-adjustable billed timestamps for administrators and only today''s open sessions for regular agents.';

commit;
