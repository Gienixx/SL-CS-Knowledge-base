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

  with attendance_sources as (
    select
      readiness.id as attendance_id,
      readiness.schedule_id,
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
        when schedule.is_leave then 'Leave'
        else initcap(replace(coalesce(readiness.attendance_status, 'unknown'), '_', ' '))
      end as attendance_type,
      greatest(coalesce(readiness.regular_minutes, 0), 0)::integer as regular_minutes,
      greatest(coalesce(readiness.total_overtime_minutes, 0), 0)::integer as additional_ot_minutes,
      (greatest(coalesce(readiness.regular_minutes, 0), 0)
        + greatest(coalesce(readiness.total_overtime_minutes, 0), 0))::integer as total_payable_minutes,
      initcap(replace(coalesce(readiness.review_status, 'not reviewed'), '_', ' ')) as approval_status,
      readiness.is_payroll_ready,
      coalesce(readiness.payroll_readiness_blockers, '{}'::text[]) as readiness_blockers
    from public.workforce_attendance_payroll_readiness readiness
    left join public.work_schedules schedule on schedule.id = readiness.schedule_id
    where readiness.user_id = p_employee_user_id
      and readiness.work_date between v_period.period_start and v_period.period_end

    union all

    select
      null::uuid as attendance_id,
      schedule.id as schedule_id,
      schedule.shift_date as work_date,
      case
        when schedule.is_rest_day then 'Rest Day'
        when schedule.is_holiday then coalesce(nullif(schedule.holiday_name, ''), 'Holiday')
        when schedule.is_leave then 'Leave'
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
      array['no_attendance_record']::text[] as readiness_blockers
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
  ), daily_base as (
    select
      source.work_date,
      coalesce(array_agg(distinct source.attendance_id order by source.attendance_id)
        filter (where source.attendance_id is not null), '{}'::uuid[]) as source_attendance_ids,
      coalesce(array_agg(distinct source.schedule_id order by source.schedule_id)
        filter (where source.schedule_id is not null), '{}'::uuid[]) as source_schedule_ids,
      count(*)::integer as source_record_count,
      count(*) filter (where source.attendance_id is not null)::integer as attendance_source_count,
      count(distinct source.schedule_id) filter (where source.schedule_id is not null)::integer as linked_schedule_count,
      coalesce(array_agg(distinct source.schedule order by source.schedule)
        filter (where source.schedule is not null), '{}'::text[]) as schedule_variants,
      coalesce(array_agg(distinct source.attendance_type order by source.attendance_type)
        filter (where source.attendance_type is not null), '{}'::text[]) as attendance_types,
      min(source.schedule) filter (where source.schedule_id is not null) as linked_schedule,
      min(source.schedule) as any_schedule,
      sum(source.regular_minutes)::integer as regular_minutes,
      sum(source.additional_ot_minutes)::integer as additional_ot_minutes,
      sum(source.total_payable_minutes)::integer as total_payable_minutes,
      case
        when bool_and(lower(source.approval_status) = 'locked') then 'Locked'
        when bool_and(lower(source.approval_status) in ('approved', 'locked')) then 'Approved'
        else coalesce(
          min(source.approval_status) filter (where lower(source.approval_status) not in ('approved', 'locked')),
          'Requires review'
        )
      end as approval_status,
      bool_and(source.is_payroll_ready
        and lower(source.approval_status) in ('approved', 'locked')) as all_sources_ready,
      coalesce((
        select array_agg(distinct blocker order by blocker)
        from attendance_sources blocker_source
        cross join lateral unnest(blocker_source.readiness_blockers) as blockers(blocker)
        where blocker_source.work_date = source.work_date
          and nullif(btrim(blocker), '') is not null
      ), '{}'::text[]) as source_readiness_blockers
    from attendance_sources source
    group by source.work_date
  ), daily_rows as (
    select
      daily_base.*,
      (daily_base.linked_schedule_count > 1) as schedule_review_required,
      (daily_base.all_sources_ready
        and daily_base.linked_schedule_count <= 1
        and cardinality(daily_base.source_readiness_blockers) = 0) as is_payroll_ready,
      case
        when daily_base.linked_schedule_count > 1 then 'Multiple schedules (review)'
        else coalesce(daily_base.linked_schedule, daily_base.any_schedule, 'Schedule not linked')
      end as schedule,
      case
        when 'Leave' = any(daily_base.attendance_types) then 'Leave'
        when 'Rest Day' = any(daily_base.attendance_types) then 'Rest Day'
        when cardinality(daily_base.attendance_types) = 1 then daily_base.attendance_types[1]
        when cardinality(daily_base.attendance_types) = 0 then 'No attendance record'
        else 'Mixed attendance (review)'
      end as attendance_type,
      (case
        when cardinality(daily_base.source_readiness_blockers) > 0 then daily_base.source_readiness_blockers
        else '{}'::text[]
      end)
      || case when daily_base.linked_schedule_count > 1
          then array['multiple_schedules_on_work_date']::text[] else '{}'::text[] end
      || case when not daily_base.all_sources_ready and cardinality(daily_base.source_readiness_blockers) = 0
          then array['source_not_payroll_ready']::text[] else '{}'::text[] end as readiness_blockers
    from daily_base
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'attendance_id', case when cardinality(daily.source_attendance_ids) = 1
      then daily.source_attendance_ids[1] else null end,
    'source_attendance_ids', daily.source_attendance_ids,
    'source_schedule_ids', daily.source_schedule_ids,
    'source_record_count', daily.source_record_count,
    'attendance_source_count', daily.attendance_source_count,
    'schedule_variants', daily.schedule_variants,
    'schedule_review_required', daily.schedule_review_required,
    'work_date', daily.work_date,
    'schedule', daily.schedule,
    'attendance_type', daily.attendance_type,
    'regular_minutes', daily.regular_minutes,
    'additional_ot_minutes', daily.additional_ot_minutes,
    'total_payable_minutes', daily.total_payable_minutes,
    'approval_status', daily.approval_status,
    'is_payroll_ready', daily.is_payroll_ready,
    'readiness_blockers', daily.readiness_blockers,
    'payroll_readiness', case when daily.is_payroll_ready then 'Ready'
      else array_to_string(daily.readiness_blockers, ', ')
    end
  ) order by daily.work_date), '[]'::jsonb)
  into v_attendance
  from daily_rows daily;

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
revoke all on function public.payroll_v2_get_individual_payslip_data(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_v2_get_individual_payslip_data(uuid, uuid)
  to authenticated, service_role;


;
