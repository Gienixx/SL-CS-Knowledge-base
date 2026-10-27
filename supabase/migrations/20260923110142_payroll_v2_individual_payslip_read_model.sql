-- Read-only employee detail for the detached Payroll Dashboard V2 workflow.
-- This intentionally does not create payroll records, items, or snapshots.

create or replace function public.payroll_v2_list_individual_employees(
  p_payroll_v2_period_id uuid
)
returns table (
  employee_user_id uuid,
  employee_name text,
  employee_number text,
  employment_status text,
  rate_id uuid,
  rate_effective_date date,
  currency_code text,
  hourly_rate numeric,
  daily_rate numeric,
  monthly_rate numeric,
  overtime_rate numeric,
  holiday_rate numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_period public.payroll_v2_periods%rowtype;
begin
  if auth.uid() is null
     or public.workforce_current_profile_id() is null
     or not public.workforce_current_user_is_active()
     or not (
       public.workforce_has_permission('create_payroll')
       or public.workforce_has_permission('review_payroll')
       or public.workforce_has_permission('finalize_payroll')
       or public.workforce_has_permission('reopen_payroll')
       or public.workforce_has_permission('view_all_payslips')
       or public.workforce_has_permission('export_payslips')
     ) then
    raise exception using errcode = '42501',
      message = 'You do not have permission to view Payroll Dashboard V2 employees.';
  end if;

  select period.* into v_period
  from public.payroll_v2_periods period
  where period.id = p_payroll_v2_period_id;

  if not found then
    raise exception using errcode = 'P0002',
      message = 'Payroll V2 period not found.';
  end if;

  return query
  select
    profile.user_id,
    coalesce(nullif(btrim(profile.full_name), ''), profile.email),
    profile.employee_id,
    profile.employment_status::text,
    rate.id,
    rate.effective_date,
    rate.currency_code,
    rate.hourly_rate,
    rate.daily_rate,
    rate.monthly_rate,
    rate.overtime_rate,
    rate.holiday_rate
  from public.profiles profile
  left join lateral (
    select agent_rate.*
    from public.agent_rates agent_rate
    where agent_rate.employee_id = profile.user_id
      and agent_rate.effective_date <= v_period.period_end
    order by agent_rate.effective_date desc, agent_rate.created_at desc
    limit 1
  ) rate on true
  where profile.is_agent is true
    and profile.is_payroll_eligible is true
    and profile.employment_status::text in ('active', 'on_leave')
  order by coalesce(nullif(btrim(profile.full_name), ''), profile.email),
    profile.user_id;
end;
$function$;

create or replace function public.payroll_v2_get_individual_payslip_data(
  p_payroll_v2_period_id uuid,
  p_employee_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_period public.payroll_v2_periods%rowtype;
  v_profile public.profiles%rowtype;
  v_rate public.agent_rates%rowtype;
  v_rate_changes integer := 0;
  v_expected_minutes integer := 0;
  v_payroll_ready_minutes integer := 0;
  v_covered_minutes integer := 0;
  v_remaining_minutes integer := 0;
  v_attendance jsonb := '[]'::jsonb;
  v_commitment_targets jsonb := '[]'::jsonb;
  v_commitment_summary jsonb;
  v_leave jsonb := '[]'::jsonb;
begin
  if auth.uid() is null
     or public.workforce_current_profile_id() is null
     or not public.workforce_current_user_is_active()
     or not (
       public.workforce_has_permission('create_payroll')
       or public.workforce_has_permission('review_payroll')
       or public.workforce_has_permission('finalize_payroll')
       or public.workforce_has_permission('reopen_payroll')
       or public.workforce_has_permission('view_all_payslips')
       or public.workforce_has_permission('export_payslips')
     ) then
    raise exception using errcode = '42501',
      message = 'You do not have permission to view Payroll Dashboard V2 employee details.';
  end if;

  select period.* into v_period
  from public.payroll_v2_periods period
  where period.id = p_payroll_v2_period_id;

  if not found then
    raise exception using errcode = 'P0002',
      message = 'Payroll V2 period not found.';
  end if;

  select profile.* into v_profile
  from public.profiles profile
  where profile.user_id = p_employee_user_id
    and profile.is_agent is true
    and profile.is_payroll_eligible is true
    and profile.employment_status::text in ('active', 'on_leave');

  if not found then
    raise exception using errcode = 'P0002',
      message = 'Employee is not active and payroll eligible.';
  end if;

  select agent_rate.* into v_rate
  from public.agent_rates agent_rate
  where agent_rate.employee_id = p_employee_user_id
    and agent_rate.effective_date <= v_period.period_end
  order by agent_rate.effective_date desc, agent_rate.created_at desc
  limit 1;

  select count(*)::integer into v_rate_changes
  from public.agent_rates agent_rate
  where agent_rate.employee_id = p_employee_user_id
    and agent_rate.effective_date > v_period.period_start
    and agent_rate.effective_date <= v_period.period_end;

  select coalesce(jsonb_agg(to_jsonb(attendance_row)
    order by attendance_row.work_date, attendance_row.schedule_start, attendance_row.attendance_id), '[]'::jsonb)
  into v_attendance
  from (
    select
      readiness.id as attendance_id,
      readiness.work_date,
      coalesce(
        case when schedule.is_rest_day then 'Rest Day'
             when schedule.is_holiday then coalesce(nullif(schedule.holiday_name, ''), 'Holiday')
             when schedule.is_leave then 'Leave'
             when schedule.shift_start is not null and schedule.shift_end is not null
               then to_char(schedule.shift_start at time zone coalesce(nullif(schedule.timezone, ''), 'America/New_York'), 'HH12:MI AM')
                 || '–' || to_char(schedule.shift_end at time zone coalesce(nullif(schedule.timezone, ''), 'America/New_York'), 'HH12:MI AM')
             else 'Schedule not linked'
        end,
        'Schedule not linked'
      ) as schedule,
      case
        when schedule.is_rest_day then 'Rest Day'
        when schedule.is_holiday then coalesce(nullif(schedule.holiday_name, ''), 'Holiday')
        else initcap(replace(coalesce(readiness.attendance_status, 'unknown'), '_', ' '))
      end as attendance_type,
      greatest(coalesce(readiness.regular_minutes, 0), 0)::integer as regular_minutes,
      greatest(coalesce(readiness.total_overtime_minutes, 0), 0)::integer as additional_ot_minutes,
      (greatest(coalesce(readiness.regular_minutes, 0), 0)
        + greatest(coalesce(readiness.total_overtime_minutes, 0), 0))::integer as total_payable_minutes,
      initcap(replace(coalesce(readiness.review_status, 'not reviewed'), '_', ' ')) as approval_status,
      readiness.is_payroll_ready,
      coalesce(readiness.payroll_readiness_blockers, '{}'::text[]) as readiness_blockers,
      case when readiness.is_payroll_ready then 'Ready'
        else array_to_string(coalesce(readiness.payroll_readiness_blockers, '{}'::text[]), ', ')
      end as payroll_readiness,
      schedule.shift_start as schedule_start
    from public.workforce_attendance_payroll_readiness readiness
    left join public.work_schedules schedule on schedule.id = readiness.schedule_id
    where readiness.user_id = p_employee_user_id
      and readiness.work_date between v_period.period_start and v_period.period_end

    union all

    select
      null::uuid as attendance_id,
      schedule.shift_date as work_date,
      case
        when schedule.is_rest_day then 'Rest Day'
        when schedule.is_holiday then coalesce(nullif(schedule.holiday_name, ''), 'Holiday')
        when schedule.shift_start is not null and schedule.shift_end is not null
          then to_char(schedule.shift_start at time zone coalesce(nullif(schedule.timezone, ''), 'America/New_York'), 'HH12:MI AM')
            || '–' || to_char(schedule.shift_end at time zone coalesce(nullif(schedule.timezone, ''), 'America/New_York'), 'HH12:MI AM')
        else 'Scheduled shift'
      end as schedule,
      case when schedule.is_absent then 'Scheduled absence' else 'No attendance record' end as attendance_type,
      0::integer as regular_minutes,
      0::integer as additional_ot_minutes,
      0::integer as total_payable_minutes,
      'No attendance'::text as approval_status,
      false as is_payroll_ready,
      array['no_attendance_record']::text[] as readiness_blockers,
      'No attendance record for a due scheduled shift'::text as payroll_readiness,
      schedule.shift_start as schedule_start
    from public.work_schedules schedule
    where schedule.user_id = p_employee_user_id
      and schedule.shift_date between v_period.period_start and v_period.period_end
      and schedule.status in ('published', 'changed', 'completed')
      and not schedule.is_rest_day
      and not schedule.is_holiday
      and not schedule.is_leave
      and public.payroll_attendance_is_due(schedule.id, statement_timestamp())
      and not exists (
        select 1 from public.attendance existing_attendance
        where existing_attendance.user_id = p_employee_user_id
          and (existing_attendance.schedule_id = schedule.id
            or existing_attendance.work_date = schedule.shift_date)
          and existing_attendance.voided_at is null
      )
  ) attendance_row;

  with current_targets as (
    select distinct on (commitment.work_date)
      commitment.id,
      commitment.work_date,
      commitment.expected_minutes,
      commitment.prepaid_day_type,
      commitment.commitment_version
    from public.payroll_prepaid_commitments commitment
    where commitment.employee_id = p_employee_user_id
      and commitment.work_date between v_period.period_start and v_period.period_end
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
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'work_date', work_date,
      'expected_minutes', expected_minutes,
      'payroll_ready_minutes', payroll_ready_minutes,
      'covered_minutes', covered_minutes,
      'remaining_minutes', remaining_minutes,
      'day_type', prepaid_day_type,
      'commitment_version', commitment_version
    ) order by work_date), '[]'::jsonb),
    coalesce(sum(expected_minutes), 0)::integer,
    coalesce(sum(payroll_ready_minutes), 0)::integer,
    coalesce(sum(covered_minutes), 0)::integer,
    coalesce(sum(remaining_minutes), 0)::integer
  into v_commitment_targets, v_expected_minutes, v_payroll_ready_minutes,
    v_covered_minutes, v_remaining_minutes
  from target_coverage;

  -- Keep the summary's source data limited to current Committed Hours targets.
  v_commitment_summary := jsonb_build_object(
    'expected_minutes', v_expected_minutes,
    'payroll_ready_minutes', v_payroll_ready_minutes,
    'covered_minutes', v_covered_minutes,
    'remaining_minutes', v_remaining_minutes,
    'status', case
      when jsonb_array_length(v_commitment_targets) = 0 then 'No commitment required'
      when v_remaining_minutes = 0 then 'Covered'
      when v_payroll_ready_minutes = 0 then 'Outstanding'
      else 'Partially covered'
    end,
    'targets', v_commitment_targets
  );

  select coalesce(jsonb_agg(jsonb_build_object(
    'work_date', schedule.shift_date,
    'leave_type', coalesce(nullif(schedule.leave_type, ''), request.leave_type),
    'paid_minutes', greatest(coalesce(schedule.planned_paid_minutes, request.requested_planned_paid_minutes, 0), 0),
    'status', 'Approved'
  ) order by schedule.shift_date, schedule.shift_sequence), '[]'::jsonb)
  into v_leave
  from public.work_schedules schedule
  join public.leave_requests request on request.id = schedule.leave_request_id
  where schedule.user_id = p_employee_user_id
    and schedule.shift_date between v_period.period_start and v_period.period_end
    and schedule.is_leave
    and request.status = 'approved'
    and public.workforce_is_paid_leave_type(coalesce(nullif(schedule.leave_type, ''), request.leave_type));

  return jsonb_build_object(
    'period', jsonb_build_object(
      'period_id', v_period.id,
      'period_start', v_period.period_start,
      'period_end', v_period.period_end,
      'payment_date', v_period.payment_date,
      'status', v_period.status
    ),
    'employee', jsonb_build_object(
      'employee_user_id', v_profile.user_id,
      'employee_name', coalesce(nullif(btrim(v_profile.full_name), ''), v_profile.email),
      'employee_number', v_profile.employee_id,
      'employment_status', v_profile.employment_status,
      'payslip_status', 'Not Calculated',
      'agent_rate', case when v_rate.id is null then null else jsonb_build_object(
        'rate_id', v_rate.id,
        'effective_date', v_rate.effective_date,
        'currency_code', v_rate.currency_code,
        'hourly_rate', v_rate.hourly_rate,
        'daily_rate', v_rate.daily_rate,
        'monthly_rate', v_rate.monthly_rate,
        'overtime_rate', v_rate.overtime_rate,
        'holiday_rate', v_rate.holiday_rate
      ) end,
      'rate_changes_in_period', v_rate_changes
    ),
    'attendance', v_attendance,
    'committed_hours', v_commitment_summary,
    'leave', v_leave,
    'manual_earnings', jsonb_build_object(
      'available', false,
      'rows', '[]'::jsonb,
      'reason', 'Manual earnings are stored on payroll_items through a payroll_record_id. Payroll V2 has no employee payslip record link yet, so existing rows cannot be matched safely to this V2 period.'
    ),
    'payroll_preview', jsonb_build_object(
      'available', false,
      'reason', 'There is no side-effect-free employee-level payroll preview RPC. The existing employee draft calculator requires a payroll_record_id and invokes the legacy draft calculation path, which may write payroll items and attendance snapshots.'
    )
  );
end;
$function$;

revoke all on function public.payroll_v2_list_individual_employees(uuid)
  from public, anon, authenticated;
revoke all on function public.payroll_v2_get_individual_payslip_data(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_v2_list_individual_employees(uuid)
  to authenticated, service_role;
grant execute on function public.payroll_v2_get_individual_payslip_data(uuid, uuid)
  to authenticated, service_role;

;
