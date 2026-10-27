-- Read-only Payroll V2 employee calculation preview. Every persisted input
-- comes from live workforce sources or V2 manual earnings; this function
-- creates no V2 or V1 records, items, or snapshots.
create or replace function public.payroll_v2_preview_employee(
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
  v_read_model jsonb;
  v_attendance jsonb;
  v_committed_hours jsonb;
  v_targets jsonb;
  v_leave jsonb := '[]'::jsonb;
  v_manual jsonb := '[]'::jsonb;
  v_blockers jsonb := '[]'::jsonb;
  v_rate_blockers jsonb := '[]'::jsonb;
  v_daily_breakdown jsonb := '[]'::jsonb;
  v_rate_breakdown jsonb := '[]'::jsonb;
  v_currency_code text := 'USD';
  v_ready boolean := false;
  v_attendance_minutes integer := 0;
  v_attendance_earnings numeric(14,2) := 0;
  v_leave_minutes integer := 0;
  v_leave_earnings numeric(14,2) := 0;
  v_committed_earnings numeric(14,2) := 0;
  v_manual_earnings numeric(14,2) := 0;
  v_gross_pay numeric(14,2);
  v_net_pay numeric(14,2);
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
      message = 'You do not have permission to preview Payroll Dashboard V2 employee pay.';
  end if;

  if p_payroll_v2_period_id is null or p_employee_user_id is null then
    raise exception using errcode = '22023',
      message = 'A Payroll V2 period and employee are required.';
  end if;

  select period.* into v_period
  from public.payroll_v2_periods period
  where period.id = p_payroll_v2_period_id;

  if not found then
    raise exception using errcode = 'P0002',
      message = 'Payroll V2 period not found.';
  end if;

  if v_period.status = 'void' then
    raise exception using errcode = '55000',
      message = 'A Void Payroll V2 period cannot be previewed.';
  end if;

  -- Reuse the exact live V2 attendance/readiness, employee, and Committed
  -- Hours read model already used by Individual Payslip.
  v_read_model := public.payroll_v2_get_individual_payslip_data(
    p_payroll_v2_period_id,
    p_employee_user_id
  );
  v_attendance := coalesce(v_read_model -> 'attendance', '[]'::jsonb);
  v_committed_hours := coalesce(v_read_model -> 'committed_hours', '{}'::jsonb);
  v_targets := coalesce(v_committed_hours -> 'targets', '[]'::jsonb);

  -- Any source readiness blocker blocks the monetary preview. Preserve the
  -- work date, blocker code, and all source attendance IDs for review.
  with attendance_rows as (
    select row_data
    from jsonb_array_elements(v_attendance) as source(row_data)
    where (row_data ->> 'work_date')::date between v_period.period_start and v_period.period_end
  ), row_blockers as (
    select
      row_data ->> 'work_date' as work_date,
      blocker.code as blocker_code,
      coalesce(row_data -> 'source_attendance_ids', '[]'::jsonb) as source_attendance_ids,
      coalesce(row_data -> 'source_schedule_ids', '[]'::jsonb) as source_schedule_ids
    from attendance_rows
    cross join lateral jsonb_array_elements_text(
      case when jsonb_typeof(row_data -> 'readiness_blockers') = 'array'
        then row_data -> 'readiness_blockers' else '[]'::jsonb end
    ) as blocker(code)
    union all
    select
      row_data ->> 'work_date',
      'source_not_payroll_ready',
      coalesce(row_data -> 'source_attendance_ids', '[]'::jsonb),
      coalesce(row_data -> 'source_schedule_ids', '[]'::jsonb)
    from attendance_rows
    where coalesce((row_data ->> 'is_payroll_ready')::boolean, false) is false
      and jsonb_array_length(case when jsonb_typeof(row_data -> 'readiness_blockers') = 'array'
        then row_data -> 'readiness_blockers' else '[]'::jsonb end) = 0
    union all
    select
      row_data ->> 'work_date',
      'attendance_not_approved',
      coalesce(row_data -> 'source_attendance_ids', '[]'::jsonb),
      coalesce(row_data -> 'source_schedule_ids', '[]'::jsonb)
    from attendance_rows
    where coalesce((row_data ->> 'total_payable_minutes')::integer, 0) > 0
      and lower(coalesce(row_data ->> 'approval_status', '')) not in ('approved', 'locked')
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'work_date', blocker.work_date,
    'code', blocker.blocker_code,
    'message', pg_catalog.replace(blocker.blocker_code, '_', ' '),
    'source_attendance_ids', blocker.source_attendance_ids,
    'source_schedule_ids', blocker.source_schedule_ids
  ) order by blocker.work_date, blocker.blocker_code), '[]'::jsonb)
  into v_blockers
  from (select distinct * from row_blockers) blocker;

  -- Paid leave uses the current approved request/schedule sources. The V1
  -- payroll leave rule pays one fixed 480-minute entitlement per leave date;
  -- worked attendance remains additional on the same date.
  with approved_leave_dates as (
    select distinct on (schedule.shift_date)
      schedule.shift_date as work_date,
      coalesce(nullif(schedule.leave_type, ''), request.leave_type) as leave_type,
      schedule.id as schedule_id
    from public.work_schedules schedule
    join public.leave_requests request on request.id = schedule.leave_request_id
    where schedule.user_id = p_employee_user_id
      and schedule.shift_date between v_period.period_start and v_period.period_end
      and schedule.status in ('published', 'changed', 'completed')
      and schedule.is_leave
      and request.status = 'approved'
      and public.workforce_is_paid_leave_type(
        coalesce(nullif(schedule.leave_type, ''), request.leave_type)
      )
    order by schedule.shift_date, schedule.updated_at desc, schedule.id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'work_date', leave_date.work_date,
    'leave_type', leave_date.leave_type,
    'paid_minutes', 480,
    'status', 'Approved',
    'source_schedule_id', leave_date.schedule_id
  ) order by leave_date.work_date), '[]'::jsonb)
  into v_leave
  from approved_leave_dates leave_date;

  -- Report missing effective-dated rates for any nonzero attendance, leave,
  -- or Committed Hours earning input.
  with required_dates as (
    select (row_data ->> 'work_date')::date as work_date
    from jsonb_array_elements(v_attendance) as source(row_data)
    where (row_data ->> 'work_date')::date between v_period.period_start and v_period.period_end
      and coalesce((row_data ->> 'total_payable_minutes')::integer, 0) > 0
    union
    select (leave_row ->> 'work_date')::date
    from jsonb_array_elements(v_leave) as source(leave_row)
    where coalesce((leave_row ->> 'paid_minutes')::integer, 0) > 0
    union
    select (target ->> 'work_date')::date
    from jsonb_array_elements(v_targets) as source(target)
    where coalesce((target ->> 'remaining_minutes')::integer, 0) > 0
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'work_date', required.work_date,
    'code', 'missing_effective_agent_rate',
    'message', 'No Agent Rate is effective for ' || required.work_date::text || '.'
  ) order by required.work_date), '[]'::jsonb)
  into v_rate_blockers
  from required_dates required
  where not exists (
    select 1
    from public.agent_rates rate
    where rate.employee_id = p_employee_user_id
      and rate.effective_date <= required.work_date
  );

  v_blockers := v_blockers || v_rate_blockers;
  v_ready := jsonb_array_length(v_blockers) = 0;

  select rate.currency_code into v_currency_code
  from public.agent_rates rate
  where rate.employee_id = p_employee_user_id
    and rate.effective_date <= v_period.period_end
  order by rate.effective_date desc, rate.created_at desc
  limit 1;
  v_currency_code := coalesce(v_currency_code, 'USD');

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', earning.id,
    'description', earning.description,
    'amount', earning.amount,
    'currency_code', v_currency_code,
    'status', pg_catalog.initcap(pg_catalog.replace(earning.status, '_', ' ')),
    'included_in_preview', earning.status = 'approved'
  ) order by earning.created_at, earning.id), '[]'::jsonb)
  into v_manual
  from public.payroll_v2_manual_earnings earning
  where earning.payroll_v2_period_id = p_payroll_v2_period_id
    and earning.employee_user_id = p_employee_user_id;

  select coalesce(sum(earning.amount) filter (where earning.status = 'approved'), 0)::numeric(14,2)
  into v_manual_earnings
  from public.payroll_v2_manual_earnings earning
  where earning.payroll_v2_period_id = p_payroll_v2_period_id
    and earning.employee_user_id = p_employee_user_id;

  -- A rate is selected independently for each work date. Attendance, paid
  -- leave, and Committed Hours all use the effective hourly rate on that date.
  -- Daily monetary amounts are rounded to cents, matching the USD payroll
  -- currency used by the existing payroll model. No overtime premium applies.
  with attendance_by_date as (
    select
      (row_data ->> 'work_date')::date as work_date,
      coalesce(sum((row_data ->> 'regular_minutes')::integer), 0)::integer as regular_minutes,
      coalesce(sum((row_data ->> 'additional_ot_minutes')::integer), 0)::integer as additional_minutes,
      coalesce(sum((row_data ->> 'total_payable_minutes')::integer), 0)::integer as payable_minutes
    from jsonb_array_elements(v_attendance) as source(row_data)
    where (row_data ->> 'work_date')::date between v_period.period_start and v_period.period_end
    group by (row_data ->> 'work_date')::date
  ), attendance_ids_by_date as (
    select
      (row_data ->> 'work_date')::date as work_date,
      coalesce(jsonb_agg(distinct source_ids.value), '[]'::jsonb) as source_attendance_ids
    from jsonb_array_elements(v_attendance) as source(row_data)
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(row_data -> 'source_attendance_ids') = 'array'
        then row_data -> 'source_attendance_ids' else '[]'::jsonb end
    ) as source_ids(value)
    where (row_data ->> 'work_date')::date between v_period.period_start and v_period.period_end
    group by (row_data ->> 'work_date')::date
  ), schedule_ids_by_date as (
    select
      (row_data ->> 'work_date')::date as work_date,
      coalesce(jsonb_agg(distinct schedule_ids.value), '[]'::jsonb) as source_schedule_ids
    from jsonb_array_elements(v_attendance) as source(row_data)
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(row_data -> 'source_schedule_ids') = 'array'
        then row_data -> 'source_schedule_ids' else '[]'::jsonb end
    ) as schedule_ids(value)
    where (row_data ->> 'work_date')::date between v_period.period_start and v_period.period_end
    group by (row_data ->> 'work_date')::date
  ), leave_by_date as (
    select
      (leave_row ->> 'work_date')::date as work_date,
      coalesce(sum((leave_row ->> 'paid_minutes')::integer), 0)::integer as leave_minutes,
      jsonb_agg(leave_row order by leave_row ->> 'leave_type') as leave_rows
    from jsonb_array_elements(v_leave) as leave_items(leave_row)
    group by (leave_row ->> 'work_date')::date
  ), commitment_by_date as (
    select
      (target ->> 'work_date')::date as work_date,
      coalesce(sum((target ->> 'remaining_minutes')::integer), 0)::integer as committed_minutes,
      jsonb_agg(target order by target ->> 'commitment_version') as targets
    from jsonb_array_elements(v_targets) as commitment_items(target)
    group by (target ->> 'work_date')::date
  ), day_inputs as (
    select work_date from attendance_by_date
    union select work_date from leave_by_date
    union select work_date from commitment_by_date
  ), dated_inputs as (
    select
      day.work_date,
      coalesce(attendance.regular_minutes, 0)::integer as regular_minutes,
      coalesce(attendance.additional_minutes, 0)::integer as additional_minutes,
      coalesce(attendance.payable_minutes, 0)::integer as payable_minutes,
      coalesce(attendance_ids.source_attendance_ids, '[]'::jsonb) as source_attendance_ids,
      coalesce(schedule_ids.source_schedule_ids, '[]'::jsonb) as source_schedule_ids,
      coalesce(leave.leave_minutes, 0)::integer as leave_minutes,
      coalesce(leave.leave_rows, '[]'::jsonb) as leave_rows,
      coalesce(commitment.committed_minutes, 0)::integer as committed_minutes,
      coalesce(commitment.targets, '[]'::jsonb) as commitment_targets
    from day_inputs day
    left join attendance_by_date attendance using (work_date)
    left join attendance_ids_by_date attendance_ids using (work_date)
    left join schedule_ids_by_date schedule_ids using (work_date)
    left join leave_by_date leave using (work_date)
    left join commitment_by_date commitment using (work_date)
  ), priced as (
    select
      inputs.*,
      rate.id as rate_id,
      rate.effective_date as rate_effective_date,
      rate.hourly_rate,
      coalesce(rate.currency_code, v_currency_code) as currency_code,
      case when v_ready then
        case when inputs.payable_minutes > 0
          then round(inputs.payable_minutes::numeric / 60 * rate.hourly_rate, 2)
          else 0::numeric end
        else null::numeric end as attendance_amount,
      case when v_ready then
        case when inputs.leave_minutes > 0
          then round(inputs.leave_minutes::numeric / 60 * rate.hourly_rate, 2)
          else 0::numeric end
        else null::numeric end as leave_amount,
      case when v_ready then
        case when inputs.committed_minutes > 0
          then round(inputs.committed_minutes::numeric / 60 * rate.hourly_rate, 2)
          else 0::numeric end
        else null::numeric end as committed_amount
    from dated_inputs inputs
    left join lateral (
      select current_rate.*
      from public.agent_rates current_rate
      where current_rate.employee_id = p_employee_user_id
        and current_rate.effective_date <= inputs.work_date
      order by current_rate.effective_date desc, current_rate.created_at desc
      limit 1
    ) rate on true
  ), rate_summary as (
    select
      rate_id,
      rate_effective_date,
      hourly_rate,
      currency_code,
      array_agg(work_date order by work_date) as work_dates,
      sum(payable_minutes)::integer as attendance_minutes,
      sum(leave_minutes)::integer as leave_minutes,
      sum(committed_minutes)::integer as committed_minutes,
      sum(attendance_amount)::numeric(14,2) as attendance_amount,
      sum(leave_amount)::numeric(14,2) as leave_amount,
      sum(committed_amount)::numeric(14,2) as committed_amount
    from priced
    where rate_id is not null
      and (payable_minutes > 0 or leave_minutes > 0 or committed_minutes > 0)
    group by rate_id, rate_effective_date, hourly_rate, currency_code
  )
  select
    coalesce(sum(payable_minutes), 0)::integer,
    case when v_ready then coalesce(sum(attendance_amount), 0)::numeric(14,2) else 0::numeric end,
    coalesce(sum(leave_minutes), 0)::integer,
    case when v_ready then coalesce(sum(leave_amount), 0)::numeric(14,2) else 0::numeric end,
    case when v_ready then coalesce(sum(committed_amount), 0)::numeric(14,2) else 0::numeric end,
    coalesce((select jsonb_agg(jsonb_build_object(
      'work_date', row.work_date,
      'regular_minutes', row.regular_minutes,
      'additional_minutes', row.additional_minutes,
      'payable_minutes', row.payable_minutes,
      'source_attendance_ids', row.source_attendance_ids,
      'source_schedule_ids', row.source_schedule_ids,
      'rate_id', row.rate_id,
      'rate_effective_date', row.rate_effective_date,
      'hourly_rate', row.hourly_rate,
      'currency_code', row.currency_code,
      'attendance_amount', row.attendance_amount,
      'leave_minutes', row.leave_minutes,
      'leave_amount', row.leave_amount,
      'leave_rows', row.leave_rows,
      'committed_minutes', row.committed_minutes,
      'committed_hours_targets', row.commitment_targets,
      'committed_hours_amount', row.committed_amount,
      'total_amount', case when v_ready then
        coalesce(row.attendance_amount, 0) + coalesce(row.leave_amount, 0) + coalesce(row.committed_amount, 0)
        else null::numeric end
    ) order by row.work_date) from priced row), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object(
      'rate_id', summary.rate_id,
      'effective_date', summary.rate_effective_date,
      'hourly_rate', summary.hourly_rate,
      'currency_code', summary.currency_code,
      'work_dates', summary.work_dates,
      'attendance_minutes', summary.attendance_minutes,
      'leave_minutes', summary.leave_minutes,
      'committed_minutes', summary.committed_minutes,
      'attendance_earnings', case when v_ready then summary.attendance_amount else null::numeric end,
      'leave_earnings', case when v_ready then summary.leave_amount else null::numeric end,
      'committed_hours_earnings', case when v_ready then summary.committed_amount else null::numeric end
    ) order by summary.rate_effective_date, summary.rate_id) from rate_summary summary), '[]'::jsonb)
  into v_attendance_minutes, v_attendance_earnings, v_leave_minutes,
    v_leave_earnings, v_committed_earnings, v_daily_breakdown, v_rate_breakdown
  from priced;

  if v_ready then
    v_gross_pay := round(
      v_attendance_earnings + v_leave_earnings + v_committed_earnings + v_manual_earnings, 2
    );
    v_net_pay := v_gross_pay;
  end if;

  return jsonb_build_object(
    'status', case when v_ready then 'Ready to Preview' else 'Blocked' end,
    'ready_to_preview', v_ready,
    'blockers', v_blockers,
    'period', jsonb_build_object(
      'period_id', v_period.id,
      'period_start', v_period.period_start,
      'period_end', v_period.period_end
    ),
    'employee', v_read_model -> 'employee',
    'currency_code', v_currency_code,
    'total_payable_minutes', v_attendance_minutes,
    'total_payable_hours', round(v_attendance_minutes::numeric / 60, 2),
    'rate_breakdown', v_rate_breakdown,
    'attendance_earnings', case when v_ready then v_attendance_earnings else null end,
    'paid_leave_minutes', v_leave_minutes,
    'paid_leave_earnings', case when v_ready then v_leave_earnings else null end,
    'paid_leave_rows', v_leave,
    'committed_hours', v_committed_hours || jsonb_build_object(
      'monetary_effect', case when v_ready then v_committed_earnings else null end,
      'monetary_rule', 'Remaining Committed Hours minutes are paid at the hourly rate effective on each target work date.'
    ),
    'manual_earnings', jsonb_build_object(
      'rows', v_manual,
      'approved_amount', case when v_ready then v_manual_earnings else null end,
      'approved_count', (select count(*) from public.payroll_v2_manual_earnings earning
        where earning.payroll_v2_period_id = p_payroll_v2_period_id
          and earning.employee_user_id = p_employee_user_id and earning.status = 'approved'),
      'excluded_count', (select count(*) from public.payroll_v2_manual_earnings earning
        where earning.payroll_v2_period_id = p_payroll_v2_period_id
          and earning.employee_user_id = p_employee_user_id and earning.status <> 'approved')
    ),
    'gross_pay', v_gross_pay,
    'total_deductions', case when v_ready then 0::numeric else null::numeric end,
    'net_pay', v_net_pay,
    'net_pay_basis', 'No V2 deductions are configured; net equals gross in this preview.',
    'daily_breakdown', v_daily_breakdown,
    'persistence', jsonb_build_object(
      'saved', false,
      'message', 'Read-only preview. No payroll records, items, or snapshots were created.'
    )
  );
end;
$function$;

revoke all on function public.payroll_v2_preview_employee(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_v2_preview_employee(uuid, uuid)
  to authenticated, service_role;

comment on function public.payroll_v2_preview_employee(uuid, uuid) is
  'Read-only Payroll V2 employee preview. Uses V2 period/employee scope, current payroll readiness, date-effective Agent Rates, current Committed Hours targets, approved paid leave, and approved V2 manual earnings. Never writes payroll records, items, or snapshots.';

-- Follow-up migration: fail closed when payable attendance is not approved or locked.

;
