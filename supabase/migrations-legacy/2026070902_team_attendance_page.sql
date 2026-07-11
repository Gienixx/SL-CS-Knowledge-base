-- Phase 1, Step 10: read-only Team Attendance page data service.
--
-- Provides one permission-scoped result set for authorized administrators and
-- supervisors. Attendance corrections and approvals are intentionally excluded
-- until Steps 11 and 12.

begin;

create or replace function public.workforce_list_team_attendance(
  p_start_date date,
  p_end_date date
)
returns table (
  attendance_id uuid,
  employee_user_id uuid,
  employee_name text,
  employee_email text,
  employee_id text,
  employee_timezone text,
  team_id uuid,
  team_name text,
  work_date date,
  schedule_id uuid,
  shift_sequence smallint,
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  schedule_timezone text,
  schedule_status text,
  clock_in timestamptz,
  clock_out timestamptz,
  regular_minutes integer,
  pre_shift_overtime_minutes integer,
  post_shift_overtime_minutes integer,
  total_overtime_minutes integer,
  total_worked_minutes integer,
  minutes_late integer,
  undertime_minutes integer,
  attendance_status text,
  is_corrected boolean,
  review_status text,
  corrected_by uuid,
  corrected_by_name text,
  corrected_at timestamptz,
  correction_reason text,
  admin_notes text,
  is_open boolean,
  is_missing_clock_out boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.workforce_current_user_is_active() then
    raise exception 'Authentication and an active workforce profile are required.';
  end if;

  if not public.workforce_has_permission('view_team_attendance') then
    raise exception 'You do not have permission to view team attendance.';
  end if;

  if p_start_date is null or p_end_date is null then
    raise exception 'Start date and end date are required.';
  end if;

  if p_end_date < p_start_date then
    raise exception 'End date cannot be earlier than start date.';
  end if;

  if p_end_date - p_start_date > 366 then
    raise exception 'Team attendance date ranges cannot exceed 367 calendar days.';
  end if;

  return query
  select
    attendance_row.id,
    attendance_row.user_id,
    employee.full_name,
    employee.email,
    employee.employee_id,
    employee.timezone,
    employee.team_id,
    employee_team.name,
    attendance_row.work_date,
    attendance_row.schedule_id,
    schedule.shift_sequence,
    schedule.shift_start,
    schedule.shift_end,
    schedule.timezone,
    schedule.status,
    attendance_row.clock_in,
    attendance_row.clock_out,
    attendance_row.regular_minutes,
    attendance_row.pre_shift_overtime_minutes,
    attendance_row.post_shift_overtime_minutes,
    attendance_row.total_overtime_minutes,
    attendance_row.total_worked_minutes,
    attendance_row.minutes_late,
    attendance_row.undertime_minutes,
    attendance_row.attendance_status,
    attendance_row.is_corrected,
    attendance_row.review_status,
    attendance_row.corrected_by,
    case
      when attendance_row.corrected_by is null then null
      when corrector.full_name is not null then corrector.full_name
      else 'Former workforce user'
    end,
    attendance_row.corrected_at,
    attendance_row.correction_reason,
    attendance_row.admin_notes,
    attendance_row.clock_in is not null and attendance_row.clock_out is null,
    attendance_row.clock_in is not null
      and attendance_row.clock_out is null
      and (
        (schedule.shift_end is not null and schedule.shift_end < now())
        or attendance_row.work_date < (
          now() at time zone coalesce(nullif(employee.timezone, ''), 'Asia/Manila')
        )::date
      )
  from public.attendance attendance_row
  join public.profiles employee
    on employee.user_id = attendance_row.user_id
  left join public.teams employee_team
    on employee_team.id = employee.team_id
  left join public.work_schedules schedule
    on schedule.id = attendance_row.schedule_id
  left join public.profiles corrector
    on corrector.user_id = attendance_row.corrected_by
  where attendance_row.work_date between p_start_date and p_end_date
    and public.workforce_can_manage_user(
      attendance_row.user_id,
      'view_team_attendance'
    )
  order by
    attendance_row.work_date desc,
    schedule.shift_start desc nulls last,
    attendance_row.clock_in desc nulls last,
    attendance_row.created_at desc;
end;
$$;

comment on function public.workforce_list_team_attendance(date, date) is
  'Returns read-only, permission-scoped team attendance rows for the Step 10 Team Attendance page.';

revoke all on function public.workforce_list_team_attendance(date, date) from public;
revoke all on function public.workforce_list_team_attendance(date, date) from anon;
revoke all on function public.workforce_list_team_attendance(date, date) from authenticated;
grant execute on function public.workforce_list_team_attendance(date, date) to authenticated;

insert into public.workforce_audit_logs (
  actor_user_id,
  action,
  entity_type,
  after_data,
  reason
) values (
  auth.uid(),
  'team_attendance_read_service_added',
  'attendance',
  jsonb_build_object(
    'permission', 'view_team_attendance',
    'supervisor_scope_enforced', true,
    'read_only', true,
    'maximum_date_range_days', 367,
    'correction_actions_included', false
  ),
  'Added the Phase 1 Step 10 Team Attendance read service'
);

commit;
