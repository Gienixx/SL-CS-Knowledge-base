-- Keep the Team Attendance CH payload focused on people who can produce a
-- visible attendance card in the requested period and have an active target
-- history. The per-employee FIFO projection itself remains unchanged.

-- Reconstruction verification only reads attendance and immutable provenance.
-- Mark the verifier chain STABLE so the planner can push user/date predicates
-- through workforce_attendance_payroll_readiness instead of materializing and
-- verifying every attendance row for each CH day.
alter function workforce_internal.wave2b_single_session_is_verified_attendance(uuid) stable;
alter function workforce_internal.wave2b_multi_session_is_verified_attendance(uuid) stable;
alter function public.workforce_is_verified_reconstructed_attendance(uuid) stable;

create or replace function public.workforce_list_team_committed_hours(
  p_start_date date,
  p_end_date date
)
returns table (
  employee_user_id uuid,
  employee_name text,
  team_id uuid,
  team_name text,
  expected_minutes integer,
  credited_minutes integer,
  remaining_minutes integer,
  commitment_status text,
  targets jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
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
  if p_start_date is null or p_end_date is null then
    raise exception using errcode = '22004',
      message = 'Start date and end date are required.';
  end if;
  if p_end_date < p_start_date then
    raise exception using errcode = '22007',
      message = 'End date cannot be earlier than start date.';
  end if;
  if p_end_date - p_start_date > 366 then
    raise exception using errcode = '22023',
      message = 'Team attendance date ranges cannot exceed 367 calendar days.';
  end if;

  return query
  with visible_profiles as materialized (
    select
      profile.user_id,
      coalesce(nullif(btrim(profile.full_name), ''), profile.email) as employee_name,
      profile.team_id,
      employee_team.name as team_name
    from public.profiles profile
    left join public.teams employee_team on employee_team.id = profile.team_id
    where profile.is_agent is true
      and profile.employment_status::text in ('active', 'on_leave')
      and public.workforce_can_manage_user(profile.user_id, 'view_team_attendance')
      and exists (
        select 1
        from public.attendance attendance_row
        where attendance_row.user_id = profile.user_id
          and attendance_row.work_date between p_start_date and p_end_date
      )
      and exists (
        select 1
        from public.payroll_prepaid_commitments commitment
        where commitment.employee_id = profile.user_id
          and commitment.work_date <= p_end_date
          and commitment.superseded_at is null
      )
  )
  select
    profile.user_id,
    profile.employee_name,
    profile.team_id,
    profile.team_name,
    coalesce((summary.value ->> 'expected_minutes')::integer, 0),
    coalesce((summary.value ->> 'credited_minutes')::integer, 0),
    coalesce((summary.value ->> 'remaining_minutes')::integer, 0),
    coalesce(summary.value ->> 'status', 'No commitment required'),
    day_rows.value
  from visible_profiles profile
  cross join lateral (
    select public.payroll_get_expected_committed_hours_summary(
      profile.user_id, p_start_date, p_end_date
    ) as value
  ) summary
  cross join lateral (
    select coalesce(jsonb_agg(jsonb_build_object(
      'work_date', day.value -> 'work_date',
      'target_minutes', (day.value ->> 'target_minutes')::integer,
      'expected_minutes', (day.value ->> 'expected_minutes')::integer,
      'carryover_minutes', (day.value ->> 'carryover_minutes')::integer,
      'credited_minutes', (day.value ->> 'credited_minutes')::integer,
      'remaining_minutes', (day.value ->> 'remaining_minutes')::integer,
      'status', day.value -> 'status',
      'targets', coalesce(day.value -> 'targets', '[]'::jsonb)
    ) order by day.value ->> 'work_date'), '[]'::jsonb) as value
    from jsonb_array_elements(coalesce(summary.value -> 'days', '[]'::jsonb)) day(value)
  ) day_rows
  order by profile.employee_name, profile.user_id;
end;
$function$;

revoke all on function public.workforce_list_team_committed_hours(date, date)
  from public, anon, authenticated;
grant execute on function public.workforce_list_team_committed_hours(date, date)
  to authenticated, service_role;
comment on function public.workforce_list_team_committed_hours(date, date) is
  'Returns FIFO Committed Hours only for manageable active agents with attendance in the requested period and an active target history.';

;
