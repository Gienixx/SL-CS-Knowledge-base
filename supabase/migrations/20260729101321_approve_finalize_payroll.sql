-- Phase 2 Step 10: reviewed approval, atomic finalization, immutable finalized
-- payroll, and controlled audited reopening.

begin;

alter table public.payroll_periods
  add column reviewed_by uuid
    references public.profiles(user_id) on delete restrict,
  add column reviewed_at timestamptz,
  add column review_notes text,
  add column approval_notes text,
  add column review_evidence jsonb not null default '{}'::jsonb,
  add column finalization_evidence jsonb not null default '{}'::jsonb,
  add column finalization_version integer not null default 0;

alter table public.payroll_periods
  add constraint payroll_periods_review_pair_check
  check ((reviewed_by is null) = (reviewed_at is null)),
  add constraint payroll_periods_review_notes_check
  check (
    review_notes is null
    or length(trim(review_notes)) between 3 and 2000
  ),
  add constraint payroll_periods_approval_notes_check
  check (
    approval_notes is null
    or length(trim(approval_notes)) between 3 and 2000
  ),
  add constraint payroll_periods_review_evidence_object_check
  check (jsonb_typeof(review_evidence) = 'object'),
  add constraint payroll_periods_finalization_evidence_object_check
  check (jsonb_typeof(finalization_evidence) = 'object'),
  add constraint payroll_periods_finalization_version_check
  check (finalization_version >= 0);

comment on column public.payroll_periods.review_evidence is
  'Calculation, snapshot, rate, rounding, and prepaid-balance evidence captured when payroll is submitted for approval.';
comment on column public.payroll_periods.finalization_evidence is
  'Immutable-at-finalization evidence for the latest completed finalization cycle. Earlier cycles remain in payroll_audit_logs.';
comment on column public.payroll_periods.finalization_version is
  'Monotonic controlled-finalization cycle number. Reopening never resets it.';

create or replace function public.payroll_refresh_period_totals(
  p_payroll_period_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  with item_totals as (
    select
      record.id as payroll_record_id,
      coalesce(sum(item.amount) filter (
        where item.item_type = 'earning'
          and item.item_code = 'regular_earnings'
      ), 0)::numeric(14,2) as basic_pay,
      coalesce(sum(item.amount) filter (
        where item.item_type = 'earning'
          and item.item_code = 'prepaid_scheduled_earnings'
      ), 0)::numeric(14,2) as prepaid_pay,
      coalesce(sum(item.amount) filter (
        where item.item_type = 'earning'
          and item.item_code in (
            'pre_shift_overtime',
            'post_shift_overtime'
          )
      ), 0)::numeric(14,2) as overtime_pay,
      coalesce(sum(item.amount) filter (
        where item.item_type = 'earning'
          and item.item_code in ('rest_day_work', 'rest_day_excess')
      ), 0)::numeric(14,2) as rest_day_pay,
      coalesce(sum(item.amount) filter (
        where item.item_type = 'earning'
          and item.item_code in (
            'holiday_guarantee',
            'holiday_work',
            'holiday_excess'
          )
      ), 0)::numeric(14,2) as holiday_pay,
      coalesce(sum(item.amount) filter (
        where item.item_type = 'earning'
          and item.item_code not in (
            'regular_earnings',
            'prepaid_scheduled_earnings',
            'pre_shift_overtime',
            'post_shift_overtime',
            'rest_day_work',
            'rest_day_excess',
            'holiday_guarantee',
            'holiday_work',
            'holiday_excess'
          )
      ), 0)::numeric(14,2) as other_earnings,
      coalesce(sum(item.amount) filter (
        where item.item_type = 'earning'
      ), 0)::numeric(14,2) as gross_pay,
      coalesce(sum(item.amount) filter (
        where item.item_type = 'deduction'
          and item.item_code = 'late_deduction'
      ), 0)::numeric(14,2) as late_deduction,
      coalesce(sum(item.amount) filter (
        where item.item_type = 'deduction'
          and item.item_code = 'undertime_deduction'
      ), 0)::numeric(14,2) as undertime_deduction,
      coalesce(sum(item.amount) filter (
        where item.item_type = 'deduction'
          and item.item_code = 'unpaid_absence'
      ), 0)::numeric(14,2) as unpaid_absence_deduction,
      coalesce(sum(item.amount) filter (
        where item.item_type = 'deduction'
          and item.item_code not in (
            'late_deduction',
            'undertime_deduction',
            'unpaid_absence',
            'government_deduction',
            'statutory_deduction'
          )
      ), 0)::numeric(14,2) as other_deductions,
      coalesce(sum(item.amount) filter (
        where item.item_type = 'deduction'
      ), 0)::numeric(14,2) as total_deductions
    from public.payroll_records as record
    left join public.payroll_items as item
      on item.payroll_record_id = record.id
    where record.payroll_period_id = p_payroll_period_id
      and record.status <> 'void'
    group by record.id
  )
  update public.payroll_records as record
  set
    basic_pay = totals.basic_pay,
    prepaid_pay = totals.prepaid_pay,
    overtime_pay = totals.overtime_pay,
    rest_day_pay = totals.rest_day_pay,
    holiday_pay = totals.holiday_pay,
    other_earnings = totals.other_earnings,
    gross_pay = totals.gross_pay,
    late_deduction = totals.late_deduction,
    undertime_deduction = totals.undertime_deduction,
    unpaid_absence_deduction = totals.unpaid_absence_deduction,
    government_deductions = 0,
    other_deductions = totals.other_deductions,
    total_deductions = totals.total_deductions,
    net_pay = totals.gross_pay - totals.total_deductions,
    updated_at = statement_timestamp()
  from item_totals as totals
  where record.id = totals.payroll_record_id
    and totals.total_deductions <= totals.gross_pay;

  if exists (
    select 1
    from public.payroll_records as record
    join lateral (
      select
        coalesce(sum(item.amount) filter (
          where item.item_type = 'earning'
        ), 0) as gross_pay,
        coalesce(sum(item.amount) filter (
          where item.item_type = 'deduction'
        ), 0) as deductions
      from public.payroll_items as item
      where item.payroll_record_id = record.id
    ) as totals on true
    where record.payroll_period_id = p_payroll_period_id
      and record.status <> 'void'
      and totals.deductions > totals.gross_pay
  ) then
    raise exception
      using
        errcode = '22023',
        message = 'Finalization was blocked because an employee net pay would be negative.';
  end if;
end;
$$;

revoke all on function public.payroll_refresh_period_totals(uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_refresh_period_totals(uuid)
  to service_role;

create or replace function public.payroll_collect_finalization_evidence(
  p_payroll_period_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with target_period as (
    select period.*
    from public.payroll_periods as period
    where period.id = p_payroll_period_id
  ),
  period_records as (
    select record.*
    from public.payroll_records as record
    where record.payroll_period_id = p_payroll_period_id
      and record.status <> 'void'
  ),
  active_allocations as (
    select allocation.*
    from public.payroll_hour_allocations as allocation
    where allocation.allocation_type = 'settlement'
      and not exists (
        select 1
        from public.payroll_hour_allocations as reversal
        where reversal.reverses_allocation_id = allocation.id
      )
  ),
  balance_employees as (
    select record.employee_id
    from period_records as record
    union
    select prepaid.employee_id
    from public.payroll_prepaid_hours as prepaid
    join public.payroll_schedule_snapshots as source_snapshot
      on source_snapshot.id = prepaid.source_schedule_snapshot_id
    cross join target_period as period
    where source_snapshot.work_date <= period.period_end
  ),
  balance_totals as (
    select
      employee.employee_id,
      coalesce((
        select sum(prepaid.prepaid_minutes)
        from public.payroll_prepaid_hours as prepaid
        join public.payroll_schedule_snapshots as source_snapshot
          on source_snapshot.id = prepaid.source_schedule_snapshot_id
        cross join target_period as period
        where prepaid.employee_id = employee.employee_id
          and prepaid.voided_at is null
          and source_snapshot.work_date < period.period_start
      ), 0)
      -
      coalesce((
        select sum(allocation.allocated_minutes)
        from active_allocations as allocation
        join public.payroll_attendance_snapshots as attendance_snapshot
          on attendance_snapshot.id = allocation.attendance_snapshot_id
        cross join target_period as period
        where allocation.employee_id = employee.employee_id
          and attendance_snapshot.work_date < period.period_start
      ), 0) as opening_minutes,
      coalesce((
        select sum(prepaid.prepaid_minutes)
        from public.payroll_prepaid_hours as prepaid
        join public.payroll_schedule_snapshots as source_snapshot
          on source_snapshot.id = prepaid.source_schedule_snapshot_id
        cross join target_period as period
        where prepaid.employee_id = employee.employee_id
          and prepaid.voided_at is null
          and source_snapshot.work_date
            between period.period_start and period.period_end
      ), 0) as added_minutes,
      coalesce((
        select sum(allocation.allocated_minutes)
        from active_allocations as allocation
        join public.payroll_attendance_snapshots as attendance_snapshot
          on attendance_snapshot.id = allocation.attendance_snapshot_id
        cross join target_period as period
        where allocation.employee_id = employee.employee_id
          and attendance_snapshot.work_date
            between period.period_start and period.period_end
      ), 0) as applied_minutes
    from balance_employees as employee
  ),
  balance_json as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'employee_id', totals.employee_id,
          'employee_name', profile.full_name,
          'employee_number', profile.employee_id,
          'opening_minutes', totals.opening_minutes,
          'added_minutes', totals.added_minutes,
          'applied_minutes', totals.applied_minutes,
          'closing_minutes',
            totals.opening_minutes
            + totals.added_minutes
            - totals.applied_minutes
        )
        order by coalesce(profile.full_name, profile.email)
      ),
      '[]'::jsonb
    ) as value
    from balance_totals as totals
    join public.profiles as profile
      on profile.user_id = totals.employee_id
  ),
  rate_json as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'rate_id', rate.id,
          'employee_id', rate.employee_id,
          'effective_date', rate.effective_date,
          'hourly_rate', rate.hourly_rate,
          'overtime_rate', rate.overtime_rate,
          'holiday_rate', rate.holiday_rate
        )
        order by rate.employee_id, rate.effective_date, rate.id
      ),
      '[]'::jsonb
    ) as value
    from (
      select distinct rate.*
      from public.agent_rates as rate
      join public.payroll_items as item
        on item.rate_id = rate.id
      join period_records as record
        on record.id = item.payroll_record_id
      where not item.is_manual
    ) as rate
  ),
  version_json as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'payroll_record_id', record.id,
          'employee_id', record.employee_id,
          'calculation_version', record.calculation_version,
          'calculated_at', record.calculated_at,
          'gross_pay', record.gross_pay,
          'total_deductions', record.total_deductions,
          'net_pay', record.net_pay
        )
        order by record.employee_id
      ),
      '[]'::jsonb
    ) as value
    from period_records as record
  )
  select jsonb_build_object(
    'captured_at', statement_timestamp(),
    'currency_code', period.currency_code,
    'rounding_rules', period.rounding_rules,
    'record_count', (select count(*) from period_records),
    'payroll_item_count', (
      select count(*)
      from public.payroll_items as item
      join period_records as record
        on record.id = item.payroll_record_id
    ),
    'attendance_snapshot_count', (
      select count(*)
      from public.payroll_attendance_snapshots as snapshot
      join period_records as record
        on record.id = snapshot.payroll_record_id
    ),
    'schedule_snapshot_count', (
      select count(*)
      from public.payroll_schedule_snapshots as snapshot
      join period_records as record
        on record.id = snapshot.payroll_record_id
    ),
    'active_allocation_count', (
      select count(*)
      from active_allocations as allocation
      join period_records as record
        on record.id = allocation.destination_payroll_record_id
    ),
    'calculation_records', version.value,
    'rates_used', rate.value,
    'prepaid_minute_balances', balance.value,
    'formula_version', 'phase2_step7_v1',
    'prepaid_allocation_method', 'fifo_minutes',
    'government_deductions_enabled', false
  )
  from target_period as period
  cross join balance_json as balance
  cross join rate_json as rate
  cross join version_json as version;
$$;

revoke all on function public.payroll_collect_finalization_evidence(uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_collect_finalization_evidence(uuid)
  to service_role;

create or replace function public.payroll_assert_ready_for_approval(
  p_payroll_period_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period public.payroll_periods%rowtype;
  v_blocking_count bigint;
  v_evidence jsonb;
begin
  select period.*
  into v_period
  from public.payroll_periods as period
  where period.id = p_payroll_period_id;

  if not found then
    raise exception
      using errcode = 'P0002', message = 'Payroll period was not found.';
  end if;

  if v_period.currency_code <> 'USD'
     or v_period.rounding_rules <>
       '{"money_scale":2,"minute_conversion":"exact","rounding_mode":"half_up"}'::jsonb then
    raise exception
      using
        errcode = '22023',
        message = 'Approval requires USD, exact-minute conversion, half-up rounding, and two-decimal money values.';
  end if;

  select count(*)
  into v_blocking_count
  from public.payroll_get_period_exceptions(
    p_payroll_period_id
  ) as issue
  where issue.is_blocking;

  if v_blocking_count > 0 then
    raise exception
      using
        errcode = '55000',
        message = format(
          'Resolve %s blocking payroll exception%s before approval.',
          v_blocking_count,
          case when v_blocking_count = 1 then '' else 's' end
        );
  end if;

  if not exists (
    select 1
    from public.payroll_records as record
    where record.payroll_period_id = p_payroll_period_id
      and record.status <> 'void'
  ) then
    raise exception
      using errcode = '55000', message = 'Payroll has no employee records.';
  end if;

  if exists (
    select 1
    from public.payroll_records as record
    where record.payroll_period_id = p_payroll_period_id
      and record.status <> 'void'
      and (
        record.calculated_at is null
        or record.requires_recalculation
        or record.government_deductions <> 0
      )
  ) then
    raise exception
      using
        errcode = '55000',
        message = 'Every employee must have a current calculation with no recalculation flag or statutory deduction.';
  end if;

  if exists (
    select 1
    from public.payroll_items as item
    join public.payroll_records as record
      on record.id = item.payroll_record_id
    where record.payroll_period_id = p_payroll_period_id
      and not item.is_manual
      and (
        item.rate_id is null
        or item.work_date is null
        or item.rate_id is distinct from (
          select rate.id
          from public.agent_rates as rate
          where rate.employee_id = record.employee_id
            and rate.effective_date <= item.work_date
          order by rate.effective_date desc
          limit 1
        )
      )
  ) then
    raise exception
      using
        errcode = '55000',
        message = 'A payroll line does not use the currently effective rate. Recalculate payroll before approval.';
  end if;

  if exists (
    select 1
    from public.payroll_items as item
    join public.payroll_records as record
      on record.id = item.payroll_record_id
    join public.payroll_attendance_snapshots as snapshot
      on snapshot.id = item.source_attendance_snapshot_id
    join public.attendance as attendance_row
      on attendance_row.id = snapshot.attendance_id
    where record.payroll_period_id = p_payroll_period_id
      and attendance_row.attendance_version <>
        snapshot.attendance_version
  ) then
    raise exception
      using
        errcode = '55000',
        message = 'Attendance changed after calculation. Import the corrected snapshot and recalculate.';
  end if;

  if exists (
    select 1
    from public.payroll_items as item
    join public.payroll_records as record
      on record.id = item.payroll_record_id
    join public.work_schedules as schedule
      on schedule.id = item.source_schedule_id
    where record.payroll_period_id = p_payroll_period_id
      and item.source_schedule_version is not null
      and schedule.schedule_version <> item.source_schedule_version
  ) then
    raise exception
      using
        errcode = '55000',
        message = 'A source schedule changed after calculation. Review and recalculate payroll.';
  end if;

  v_evidence :=
    public.payroll_collect_finalization_evidence(p_payroll_period_id);

  if v_evidence is null then
    raise exception
      using errcode = '55000', message = 'Finalization evidence could not be collected.';
  end if;

  return v_evidence;
end;
$$;

revoke all on function public.payroll_assert_ready_for_approval(uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_assert_ready_for_approval(uuid)
  to service_role;

create or replace function public.payroll_review_period(
  p_payroll_period_id uuid,
  p_review_notes text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := public.workforce_current_profile_id();
  v_period public.payroll_periods%rowtype;
  v_notes text := trim(coalesce(p_review_notes, ''));
  v_evidence jsonb;
  v_record_count bigint;
begin
  if auth.uid() is null
     or v_actor_user_id is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_has_permission('review_payroll') then
    raise exception
      using
        errcode = '42501',
        message = 'You do not have permission to review payroll.';
  end if;

  if p_payroll_period_id is null then
    raise exception
      using errcode = '22023', message = 'Payroll period is required.';
  end if;

  if length(v_notes) < 3 or length(v_notes) > 2000 then
    raise exception
      using
        errcode = '22023',
        message = 'Review notes must be between 3 and 2,000 characters.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.payroll_lifecycle:' || p_payroll_period_id::text,
      0
    )
  );

  select period.*
  into v_period
  from public.payroll_periods as period
  where period.id = p_payroll_period_id
  for update;

  if not found then
    raise exception
      using errcode = 'P0002', message = 'Payroll period was not found.';
  end if;

  if v_period.status not in ('draft', 'reopened') then
    raise exception
      using
        errcode = '55000',
        message = 'Only draft or reopened payroll can be submitted for approval.';
  end if;

  perform public.payroll_refresh_period_totals(p_payroll_period_id);
  v_evidence :=
    public.payroll_assert_ready_for_approval(p_payroll_period_id);

  update public.payroll_records
  set
    status = 'approved',
    reviewed_by = v_actor_user_id,
    reviewed_at = statement_timestamp(),
    updated_at = statement_timestamp()
  where payroll_period_id = p_payroll_period_id
    and status <> 'void';

  get diagnostics v_record_count = row_count;

  update public.payroll_periods
  set
    status = 'review',
    reviewed_by = v_actor_user_id,
    reviewed_at = statement_timestamp(),
    review_notes = v_notes,
    review_evidence = v_evidence,
    approved_by = null,
    approved_at = null,
    approval_notes = null,
    finalized_by = null,
    finalized_at = null,
    updated_at = statement_timestamp()
  where id = p_payroll_period_id;

  insert into public.payroll_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    payroll_period_id,
    before_data,
    after_data,
    reason,
    metadata
  )
  values (
    v_actor_user_id,
    'payroll_period_reviewed',
    'payroll_period',
    p_payroll_period_id,
    p_payroll_period_id,
    jsonb_build_object('status', v_period.status),
    jsonb_build_object(
      'status', 'review',
      'reviewed_by', v_actor_user_id,
      'record_count', v_record_count
    ),
    v_notes,
    jsonb_build_object('review_evidence', v_evidence)
  );

  return jsonb_build_object(
    'payroll_period_id', p_payroll_period_id,
    'status', 'review',
    'record_count', v_record_count,
    'reviewed_by', v_actor_user_id,
    'reviewed_at', statement_timestamp(),
    'evidence', v_evidence
  );
end;
$$;

revoke all on function public.payroll_review_period(uuid, text)
  from public, anon;
grant execute on function public.payroll_review_period(uuid, text)
  to authenticated, service_role;

create or replace function public.payroll_finalize_period(
  p_payroll_period_id uuid,
  p_approval_notes text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := public.workforce_current_profile_id();
  v_period public.payroll_periods%rowtype;
  v_notes text := trim(coalesce(p_approval_notes, ''));
  v_evidence jsonb;
  v_record_count bigint;
  v_gross numeric(14,2);
  v_deductions numeric(14,2);
  v_net numeric(14,2);
  v_finalized_at timestamptz := statement_timestamp();
begin
  if auth.uid() is null
     or v_actor_user_id is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_has_permission('finalize_payroll') then
    raise exception
      using
        errcode = '42501',
        message = 'You do not have permission to finalize payroll.';
  end if;

  if p_payroll_period_id is null then
    raise exception
      using errcode = '22023', message = 'Payroll period is required.';
  end if;

  if length(v_notes) < 3 or length(v_notes) > 2000 then
    raise exception
      using
        errcode = '22023',
        message = 'Approval notes must be between 3 and 2,000 characters.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.payroll_lifecycle:' || p_payroll_period_id::text,
      0
    )
  );

  select period.*
  into v_period
  from public.payroll_periods as period
  where period.id = p_payroll_period_id
  for update;

  if not found then
    raise exception
      using errcode = 'P0002', message = 'Payroll period was not found.';
  end if;

  if v_period.status <> 'review'
     or v_period.reviewed_by is null
     or v_period.reviewed_at is null then
    raise exception
      using
        errcode = '55000',
        message = 'Payroll must be reviewed before it can be finalized.';
  end if;

  perform public.payroll_refresh_period_totals(p_payroll_period_id);
  v_evidence :=
    public.payroll_assert_ready_for_approval(p_payroll_period_id);

  if exists (
    select 1
    from public.payroll_records as record
    where record.payroll_period_id = p_payroll_period_id
      and record.status <> 'void'
      and (
        record.status <> 'approved'
        or record.reviewed_by is null
        or record.reviewed_at is null
      )
  ) then
    raise exception
      using
        errcode = '55000',
        message = 'Every employee payroll record must have review approval.';
  end if;

  update public.payroll_records
  set
    status = 'finalized',
    finalized_at = v_finalized_at,
    updated_at = v_finalized_at
  where payroll_period_id = p_payroll_period_id
    and status <> 'void';

  get diagnostics v_record_count = row_count;

  select
    coalesce(sum(record.gross_pay), 0),
    coalesce(sum(record.total_deductions), 0),
    coalesce(sum(record.net_pay), 0)
  into v_gross, v_deductions, v_net
  from public.payroll_records as record
  where record.payroll_period_id = p_payroll_period_id
    and record.status = 'finalized';

  v_evidence := v_evidence || jsonb_build_object(
    'finalized_at', v_finalized_at,
    'reviewed_by', v_period.reviewed_by,
    'approved_by', v_actor_user_id,
    'gross_pay', v_gross,
    'total_deductions', v_deductions,
    'net_pay', v_net,
    'finalization_version', v_period.finalization_version + 1
  );

  update public.payroll_periods
  set
    status = 'finalized',
    approved_by = v_actor_user_id,
    approved_at = v_finalized_at,
    approval_notes = v_notes,
    finalized_by = v_actor_user_id,
    finalized_at = v_finalized_at,
    finalization_evidence = v_evidence,
    finalization_version = finalization_version + 1,
    updated_at = v_finalized_at
  where id = p_payroll_period_id;

  insert into public.payroll_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    payroll_period_id,
    before_data,
    after_data,
    reason,
    metadata
  )
  values (
    v_actor_user_id,
    'payroll_period_finalized',
    'payroll_period',
    p_payroll_period_id,
    p_payroll_period_id,
    jsonb_build_object(
      'status', v_period.status,
      'reviewed_by', v_period.reviewed_by,
      'reviewed_at', v_period.reviewed_at
    ),
    jsonb_build_object(
      'status', 'finalized',
      'approved_by', v_actor_user_id,
      'finalized_at', v_finalized_at,
      'record_count', v_record_count,
      'gross_pay', v_gross,
      'total_deductions', v_deductions,
      'net_pay', v_net
    ),
    v_notes,
    jsonb_build_object('finalization_evidence', v_evidence)
  );

  return jsonb_build_object(
    'payroll_period_id', p_payroll_period_id,
    'status', 'finalized',
    'record_count', v_record_count,
    'gross_pay', v_gross,
    'total_deductions', v_deductions,
    'net_pay', v_net,
    'finalized_by', v_actor_user_id,
    'finalized_at', v_finalized_at,
    'finalization_version', v_period.finalization_version + 1
  );
end;
$$;

revoke all on function public.payroll_finalize_period(uuid, text)
  from public, anon;
grant execute on function public.payroll_finalize_period(uuid, text)
  to authenticated, service_role;

create or replace function public.payroll_reopen_period(
  p_payroll_period_id uuid,
  p_reopen_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := public.workforce_current_profile_id();
  v_period public.payroll_periods%rowtype;
  v_reason text := trim(coalesce(p_reopen_reason, ''));
  v_reopened_at timestamptz := statement_timestamp();
  v_record_count bigint;
begin
  if auth.uid() is null
     or v_actor_user_id is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_has_permission('reopen_payroll') then
    raise exception
      using
        errcode = '42501',
        message = 'You do not have permission to reopen payroll.';
  end if;

  if p_payroll_period_id is null then
    raise exception
      using errcode = '22023', message = 'Payroll period is required.';
  end if;

  if length(v_reason) < 5 or length(v_reason) > 2000 then
    raise exception
      using
        errcode = '22023',
        message = 'Reopening requires a reason between 5 and 2,000 characters.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.payroll_lifecycle:' || p_payroll_period_id::text,
      0
    )
  );

  select period.*
  into v_period
  from public.payroll_periods as period
  where period.id = p_payroll_period_id
  for update;

  if not found then
    raise exception
      using errcode = 'P0002', message = 'Payroll period was not found.';
  end if;

  if v_period.status <> 'finalized' then
    raise exception
      using
        errcode = '55000',
        message = 'Only finalized payroll can be reopened.';
  end if;

  if exists (
    select 1
    from public.payslips as payslip
    join public.payroll_records as record
      on record.id = payslip.payroll_record_id
    where record.payroll_period_id = p_payroll_period_id
  ) then
    raise exception
      using
        errcode = '55000',
        message = 'This payroll has generated payslips. Use the controlled payslip regeneration workflow before reopening.';
  end if;

  perform pg_catalog.set_config(
    'app.payroll_controlled_reopen',
    'on',
    true
  );

  update public.payroll_periods
  set
    status = 'reopened',
    reviewed_by = null,
    reviewed_at = null,
    review_notes = null,
    review_evidence = '{}'::jsonb,
    approved_by = null,
    approved_at = null,
    approval_notes = null,
    finalized_by = null,
    finalized_at = null,
    reopened_by = v_actor_user_id,
    reopened_at = v_reopened_at,
    reopen_reason = v_reason,
    updated_at = v_reopened_at
  where id = p_payroll_period_id;

  update public.payroll_records
  set
    status = 'ready_for_review',
    requires_recalculation = true,
    recalculation_reason =
      'Payroll reopened for controlled recalculation: ' || v_reason,
    reviewed_by = null,
    reviewed_at = null,
    finalized_at = null,
    updated_at = v_reopened_at
  where payroll_period_id = p_payroll_period_id
    and status <> 'void';

  get diagnostics v_record_count = row_count;

  insert into public.payroll_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    payroll_period_id,
    before_data,
    after_data,
    reason,
    metadata
  )
  values (
    v_actor_user_id,
    'payroll_period_reopened',
    'payroll_period',
    p_payroll_period_id,
    p_payroll_period_id,
    jsonb_build_object(
      'status', v_period.status,
      'reviewed_by', v_period.reviewed_by,
      'approved_by', v_period.approved_by,
      'finalized_by', v_period.finalized_by,
      'finalized_at', v_period.finalized_at,
      'finalization_version', v_period.finalization_version,
      'finalization_evidence', v_period.finalization_evidence
    ),
    jsonb_build_object(
      'status', 'reopened',
      'reopened_by', v_actor_user_id,
      'reopened_at', v_reopened_at,
      'record_count', v_record_count,
      'requires_recalculation', true
    ),
    v_reason,
    jsonb_build_object(
      'controlled_reopening', true,
      'future_adjustment_alternative_available', true
    )
  );

  return jsonb_build_object(
    'payroll_period_id', p_payroll_period_id,
    'status', 'reopened',
    'record_count', v_record_count,
    'reopened_by', v_actor_user_id,
    'reopened_at', v_reopened_at,
    'requires_recalculation', true
  );
end;
$$;

revoke all on function public.payroll_reopen_period(uuid, text)
  from public, anon;
grant execute on function public.payroll_reopen_period(uuid, text)
  to authenticated, service_role;

create or replace function public.payroll_get_period_lifecycle(
  p_payroll_period_id uuid
)
returns table (
  payroll_period_id uuid,
  period_status text,
  reviewed_by uuid,
  reviewed_by_name text,
  reviewed_at timestamptz,
  review_notes text,
  approved_by uuid,
  approved_by_name text,
  approved_at timestamptz,
  approval_notes text,
  finalized_by uuid,
  finalized_by_name text,
  finalized_at timestamptz,
  reopened_by uuid,
  reopened_by_name text,
  reopened_at timestamptz,
  reopen_reason text,
  finalization_version integer,
  review_evidence jsonb,
  finalization_evidence jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null
     or public.workforce_current_profile_id() is null
     or not public.workforce_current_user_is_active()
     or not (
       public.workforce_has_permission('create_payroll')
       or public.workforce_has_permission('review_payroll')
       or public.workforce_has_permission('finalize_payroll')
       or public.workforce_has_permission('reopen_payroll')
     ) then
    raise exception
      using
        errcode = '42501',
        message = 'You do not have permission to view payroll approval details.';
  end if;

  return query
  select
    period.id,
    period.status,
    period.reviewed_by,
    reviewer.full_name,
    period.reviewed_at,
    period.review_notes,
    period.approved_by,
    approver.full_name,
    period.approved_at,
    period.approval_notes,
    period.finalized_by,
    finalizer.full_name,
    period.finalized_at,
    period.reopened_by,
    reopener.full_name,
    period.reopened_at,
    period.reopen_reason,
    period.finalization_version,
    period.review_evidence,
    period.finalization_evidence
  from public.payroll_periods as period
  left join public.profiles as reviewer
    on reviewer.user_id = period.reviewed_by
  left join public.profiles as approver
    on approver.user_id = period.approved_by
  left join public.profiles as finalizer
    on finalizer.user_id = period.finalized_by
  left join public.profiles as reopener
    on reopener.user_id = period.reopened_by
  where period.id = p_payroll_period_id;
end;
$$;

revoke all on function public.payroll_get_period_lifecycle(uuid)
  from public, anon;
grant execute on function public.payroll_get_period_lifecycle(uuid)
  to authenticated, service_role;

create or replace function public.payroll_guard_finalized_period()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'finalized'
     and coalesce(
       current_setting('app.payroll_controlled_reopen', true),
       'off'
     ) <> 'on' then
    raise exception
      using
        errcode = '55000',
        message = 'Finalized payroll periods are immutable. Use controlled reopening.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger payroll_periods_finalized_immutable
before update or delete on public.payroll_periods
for each row
execute function public.payroll_guard_finalized_period();

create or replace function public.payroll_guard_finalized_child()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_record_id uuid;
  v_period_status text;
begin
  v_record_id := case
    when tg_op = 'DELETE' then old.payroll_record_id
    else new.payroll_record_id
  end;

  select period.status
  into v_period_status
  from public.payroll_records as record
  join public.payroll_periods as period
    on period.id = record.payroll_period_id
  where record.id = v_record_id;

  if v_period_status = 'finalized' then
    raise exception
      using
        errcode = '55000',
        message = 'Finalized payroll details are immutable. Use controlled reopening.';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger payroll_items_finalized_immutable
before insert or update or delete on public.payroll_items
for each row
execute function public.payroll_guard_finalized_child();

create trigger payroll_attendance_snapshots_finalized_insert_guard
before insert on public.payroll_attendance_snapshots
for each row
execute function public.payroll_guard_finalized_child();

create trigger payroll_schedule_snapshots_finalized_insert_guard
before insert on public.payroll_schedule_snapshots
for each row
execute function public.payroll_guard_finalized_child();

create or replace function public.payroll_guard_finalized_record()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_period_id uuid;
  v_period_status text;
begin
  v_period_id := case
    when tg_op = 'DELETE' then old.payroll_period_id
    else new.payroll_period_id
  end;

  select period.status
  into v_period_status
  from public.payroll_periods as period
  where period.id = v_period_id;

  if v_period_status = 'finalized' then
    raise exception
      using
        errcode = '55000',
        message = 'Finalized payroll records are immutable. Use controlled reopening.';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger payroll_records_finalized_immutable
before insert or update or delete on public.payroll_records
for each row
execute function public.payroll_guard_finalized_record();

create or replace function public.payroll_guard_finalized_allocation_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.payroll_records as record
    join public.payroll_periods as period
      on period.id = record.payroll_period_id
    where record.id = new.destination_payroll_record_id
      and period.status = 'finalized'
  ) then
    raise exception
      using
        errcode = '55000',
        message = 'New hour allocations cannot alter a finalized destination payroll.';
  end if;
  return new;
end;
$$;

create trigger payroll_hour_allocations_finalized_insert_guard
before insert on public.payroll_hour_allocations
for each row
execute function public.payroll_guard_finalized_allocation_insert();

create or replace function public.payroll_prevent_final_history_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    using
      errcode = '55000',
      message = 'Final payroll and audit history is immutable.';
end;
$$;

create trigger payslips_immutable
before update or delete on public.payslips
for each row
execute function public.payroll_prevent_final_history_mutation();

create trigger payroll_audit_logs_immutable
before update or delete on public.payroll_audit_logs
for each row
execute function public.payroll_prevent_final_history_mutation();

revoke all on function public.payroll_guard_finalized_period()
  from public, anon, authenticated;
revoke all on function public.payroll_guard_finalized_child()
  from public, anon, authenticated;
revoke all on function public.payroll_guard_finalized_record()
  from public, anon, authenticated;
revoke all on function public.payroll_guard_finalized_allocation_insert()
  from public, anon, authenticated;
revoke all on function public.payroll_prevent_final_history_mutation()
  from public, anon, authenticated;

grant execute on function public.payroll_guard_finalized_period()
  to service_role;
grant execute on function public.payroll_guard_finalized_child()
  to service_role;
grant execute on function public.payroll_guard_finalized_record()
  to service_role;
grant execute on function public.payroll_guard_finalized_allocation_insert()
  to service_role;
grant execute on function public.payroll_prevent_final_history_mutation()
  to service_role;

comment on function public.payroll_review_period(uuid, text) is
  'Recalculates stored employee totals, verifies all Step 10 gates, records review evidence, and locks the period for approval. Requires review_payroll.';
comment on function public.payroll_finalize_period(uuid, text) is
  'Atomically rechecks totals, exceptions, snapshots, rates, rounding, and prepaid balances before recording approval and finalization. Requires finalize_payroll.';
comment on function public.payroll_reopen_period(uuid, text) is
  'Controlled audited reopening that preserves prior finalization evidence in the append-only audit log and requires complete recalculation. Requires reopen_payroll.';

commit;
