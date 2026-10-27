begin;
-- Payroll V2, Attendance, and Team Attendance share this one read-only
-- Committed Hours projection. Only approved, payroll-ready minutes count.
create or replace function public.payroll_get_expected_committed_hours_summary(
  p_employee_user_id uuid,
  p_start_date date,
  p_end_date date
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  with current_targets as (
    select distinct on (commitment.work_date)
      commitment.id,
      commitment.work_date,
      commitment.expected_minutes,
      commitment.prepaid_day_type,
      commitment.commitment_version
    from public.payroll_prepaid_commitments commitment
    where commitment.employee_id = p_employee_user_id
      and commitment.work_date between p_start_date and p_end_date
      and commitment.superseded_at is null
    order by commitment.work_date, commitment.commitment_version desc, commitment.created_at desc
  ), target_coverage as (
    select
      target.*,
      coalesce(ready.payroll_ready_minutes, 0)::integer as payroll_ready_minutes,
      least(target.expected_minutes, coalesce(ready.payroll_ready_minutes, 0))::integer as covered_minutes,
      greatest(target.expected_minutes - coalesce(ready.payroll_ready_minutes, 0), 0)::integer as remaining_minutes
    from current_targets target
    left join lateral (
      select coalesce(sum(case
        when public.payroll_expected_commitment_day_type(p_employee_user_id, target.work_date) = 'rest_day'
          then greatest(readiness.rest_day_overtime_minutes, 0)
        else greatest(readiness.regular_minutes, 0)
      end), 0)::integer as payroll_ready_minutes
      from public.workforce_attendance_payroll_readiness readiness
      where readiness.user_id = p_employee_user_id
        and readiness.work_date = target.work_date
        and readiness.is_payroll_ready
        and readiness.review_status in ('approved', 'locked')
    ) ready on true
  )
  select jsonb_build_object(
    'expected_minutes', coalesce(sum(target.expected_minutes), 0)::integer,
    'payroll_ready_minutes', coalesce(sum(target.payroll_ready_minutes), 0)::integer,
    'covered_minutes', coalesce(sum(target.covered_minutes), 0)::integer,
    'remaining_minutes', coalesce(sum(target.remaining_minutes), 0)::integer,
    'status', case
      when count(*) = 0 then 'No commitment required'
      when coalesce(sum(target.remaining_minutes), 0) = 0 then 'Covered'
      when coalesce(sum(target.payroll_ready_minutes), 0) = 0 then 'Outstanding'
      else 'Partially covered'
    end,
    'targets', coalesce(jsonb_agg(jsonb_build_object(
      'work_date', target.work_date,
      'expected_minutes', target.expected_minutes,
      'payroll_ready_minutes', target.payroll_ready_minutes,
      'covered_minutes', target.covered_minutes,
      'remaining_minutes', target.remaining_minutes,
      'day_type', target.prepaid_day_type,
      'commitment_version', target.commitment_version
    ) order by target.work_date), '[]'::jsonb)
  )
  from target_coverage target;
$function$;
revoke all on function public.payroll_get_expected_committed_hours_summary(uuid, date, date)
  from public, anon, authenticated;
comment on function public.payroll_get_expected_committed_hours_summary(uuid, date, date) is
  'Shared current-target Committed Hours read model. Only approved, payroll-ready qualifying minutes reduce remaining coverage; callers control authorization.';
-- Attendance uses the authenticated employee or the existing authorized
-- Admin Assist path. The response omits payroll-only fields and legacy balances.
create or replace function public.workforce_get_attendance_committed_hours_summary(
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
  v_profile_id uuid := public.workforce_current_profile_id();
  v_source jsonb;
  v_targets jsonb;
begin
  if auth.uid() is null
     or v_profile_id is null
     or not public.workforce_current_user_is_active() then
    raise exception using errcode = '42501',
      message = 'Authentication and an active workforce profile are required.';
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
      message = 'Attendance date ranges cannot exceed 367 calendar days.';
  end if;
  if p_employee_user_id not in (auth.uid(), v_profile_id)
     and not public.workforce_is_authorized_attendance_admin('correct_attendance') then
    raise exception using errcode = '42501',
      message = 'You do not have permission to view this employee’s Committed Hours.';
  end if;
  if not exists (
    select 1
    from public.profiles profile
    where profile.user_id = p_employee_user_id
      and profile.is_agent is true
      and profile.employment_status::text in ('active', 'on_leave')
  ) then
    raise exception using errcode = 'P0002',
      message = 'Active workforce employee was not found.';
  end if;

  v_source := public.payroll_get_expected_committed_hours_summary(
    p_employee_user_id, p_start_date, p_end_date
  );
  select coalesce(jsonb_agg(jsonb_build_object(
    'work_date', target.value -> 'work_date',
    'expected_minutes', (target.value ->> 'expected_minutes')::integer,
    'credited_minutes', (target.value ->> 'covered_minutes')::integer,
    'remaining_minutes', (target.value ->> 'remaining_minutes')::integer
  ) order by target.value ->> 'work_date'), '[]'::jsonb)
  into v_targets
  from jsonb_array_elements(coalesce(v_source -> 'targets', '[]'::jsonb)) target(value);

  return jsonb_build_object(
    'expected_minutes', coalesce((v_source ->> 'expected_minutes')::integer, 0),
    'credited_minutes', coalesce((v_source ->> 'covered_minutes')::integer, 0),
    'remaining_minutes', coalesce((v_source ->> 'remaining_minutes')::integer, 0),
    'status', case
      when coalesce((v_source ->> 'expected_minutes')::integer, 0) = 0 then 'No commitment required'
      when coalesce((v_source ->> 'remaining_minutes')::integer, 0) = 0 then 'Complete'
      else 'Remaining'
    end,
    'targets', v_targets
  );
end;
$function$;
revoke all on function public.workforce_get_attendance_committed_hours_summary(uuid, date, date)
  from public, anon, authenticated;
grant execute on function public.workforce_get_attendance_committed_hours_summary(uuid, date, date)
  to authenticated, service_role;
comment on function public.workforce_get_attendance_committed_hours_summary(uuid, date, date) is
  'Returns only current Committed Hours target, credited, remaining, and status values for the employee or authorized Admin Assist target.';
-- Team Attendance receives one period summary per manageable active agent.
-- Per-date target rows let the existing attendance cards show the same rule.
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
  select
    profile.user_id,
    coalesce(nullif(btrim(profile.full_name), ''), profile.email),
    profile.team_id,
    employee_team.name,
    coalesce((summary.value ->> 'expected_minutes')::integer, 0),
    coalesce((summary.value ->> 'covered_minutes')::integer, 0),
    coalesce((summary.value ->> 'remaining_minutes')::integer, 0),
    case
      when coalesce((summary.value ->> 'expected_minutes')::integer, 0) = 0 then 'No commitment required'
      when coalesce((summary.value ->> 'remaining_minutes')::integer, 0) = 0 then 'Complete'
      else 'Remaining'
    end,
    target_rows.value
  from public.profiles profile
  left join public.teams employee_team on employee_team.id = profile.team_id
  cross join lateral (
    select public.payroll_get_expected_committed_hours_summary(
      profile.user_id, p_start_date, p_end_date
    ) as value
  ) summary
  cross join lateral (
    select coalesce(jsonb_agg(jsonb_build_object(
      'work_date', target.value -> 'work_date',
      'expected_minutes', (target.value ->> 'expected_minutes')::integer,
      'credited_minutes', (target.value ->> 'covered_minutes')::integer,
      'remaining_minutes', (target.value ->> 'remaining_minutes')::integer
    ) order by target.value ->> 'work_date'), '[]'::jsonb) as value
    from jsonb_array_elements(coalesce(summary.value -> 'targets', '[]'::jsonb)) target(value)
  ) target_rows
  where profile.is_agent is true
    and profile.employment_status::text in ('active', 'on_leave')
    and public.workforce_can_manage_user(profile.user_id, 'view_team_attendance')
  order by coalesce(nullif(btrim(profile.full_name), ''), profile.email), profile.user_id;
end;
$function$;
revoke all on function public.workforce_list_team_committed_hours(date, date)
  from public, anon, authenticated;
grant execute on function public.workforce_list_team_committed_hours(date, date)
  to authenticated, service_role;
comment on function public.workforce_list_team_committed_hours(date, date) is
  'Returns period-level Committed Hours status for active agents visible to Team Attendance; no payroll amounts or legacy balances are returned.';
-- Payroll V2 consumes the same projection used by the Attendance RPCs above.
-- Keep its result shape and all payroll lifecycle/calculation procedures intact.
do $patch$
declare
  v_definition text;
  v_offset integer;
  v_start integer;
  v_end integer;
  v_marker text := '  select coalesce(jsonb_agg(jsonb_build_object('
    || chr(10) || '    ''work_date'', schedule.shift_date';
  v_replacement text := '  v_commitment_summary := public.payroll_get_expected_committed_hours_summary('
    || 'p_employee_user_id, v_period.period_start, v_period.period_end);' || chr(10);
begin
  v_definition := replace(
    pg_catalog.pg_get_functiondef(
      'public.payroll_v2_get_individual_payslip_data(uuid, uuid)'::regprocedure
    ),
    chr(13), ''
  );
  v_start := strpos(v_definition, '  with current_targets as (');
  if v_start = 0 then
    raise exception 'Payroll V2 Committed Hours target projection was not found.';
  end if;
  v_offset := strpos(substring(v_definition from v_start), v_marker);
  if v_offset = 0 then
    raise exception 'Payroll V2 Committed Hours projection end marker was not found.';
  end if;
  v_end := v_start + v_offset - 1;
  v_definition := substring(v_definition from 1 for v_start - 1)
    || v_replacement
    || substring(v_definition from v_end);
  execute v_definition;
end;
$patch$;
commit;
