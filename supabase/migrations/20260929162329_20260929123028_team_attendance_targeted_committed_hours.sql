create or replace function public.workforce_get_team_committed_hours_targets(
  p_employee_user_id uuid,
  p_start_date date,
  p_end_date date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_source jsonb;
begin
  if auth.uid() is null
     or public.workforce_current_profile_id() is null
     or not public.workforce_current_user_is_active() then
    raise exception using errcode = '42501',
      message = 'Authentication and an active workforce profile are required.';
  end if;

  if not public.workforce_has_permission('view_team_attendance') then
    raise exception using errcode = '42501',
      message = 'You do not have permission to view team attendance.';
  end if;
  if p_employee_user_id is null or p_start_date is null or p_end_date is null then
    raise exception using errcode = '22004',
      message = 'Employee and date range are required.';
  end if;
  if p_end_date < p_start_date then
    raise exception using errcode = '22007',
      message = 'End date cannot be earlier than start date.';
  end if;
  if p_end_date - p_start_date > 366 then
    raise exception using errcode = '22023',
      message = 'Team attendance date ranges cannot exceed 367 calendar days.';
  end if;

  if not exists (
    select 1
    from public.profiles profile
    where profile.user_id = p_employee_user_id
      and profile.is_agent is true
      and profile.employment_status::text in ('active', 'on_leave')
      and public.workforce_can_manage_user(profile.user_id, 'view_team_attendance')
  ) then
    raise exception using errcode = '42501',
      message = 'You do not have permission to view this employee’s Committed Hours.';
  end if;

  -- The FIFO helper may read this employee's earlier commitments and
  -- attendance to calculate carryover, but only the requested date targets
  -- are returned to the caller.
  v_source := public.payroll_get_expected_committed_hours_summary(
    p_employee_user_id,
    p_start_date,
    p_end_date
  );

  return coalesce(v_source -> 'days', '[]'::jsonb);
end;
$function$;

comment on function public.workforce_get_team_committed_hours_targets(uuid, date, date) is
  'Returns Committed Hours targets for one employee and requested dates, using the canonical FIFO summary and Team Attendance authorization.';

revoke all on function public.workforce_get_team_committed_hours_targets(uuid, date, date)
  from public, anon, authenticated;
grant execute on function public.workforce_get_team_committed_hours_targets(uuid, date, date)
  to authenticated, service_role;

;
