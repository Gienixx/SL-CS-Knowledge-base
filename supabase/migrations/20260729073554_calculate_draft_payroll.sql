-- Phase 2 Step 7: atomic draft payroll calculation.
-- Monetary values are USD, rounded per the period rules, and calculated only
-- from current immutable attendance/prepaid snapshots plus effective-dated
-- rates. Prepaid allocations reduce payable actual minutes without changing
-- attendance.

begin;

alter table public.payroll_records
  add column prepaid_minutes integer not null default 0,
  add column applied_prepaid_minutes integer not null default 0,
  add column rest_day_overtime_minutes integer not null default 0,
  add column holiday_overtime_minutes integer not null default 0,
  add column late_minutes integer not null default 0,
  add column undertime_minutes integer not null default 0,
  add column prepaid_pay numeric(14,2) not null default 0,
  add column rest_day_pay numeric(14,2) not null default 0;

alter table public.payroll_records
  add constraint payroll_records_calculation_minutes_nonnegative_check
  check (
    prepaid_minutes >= 0
    and applied_prepaid_minutes >= 0
    and rest_day_overtime_minutes >= 0
    and holiday_overtime_minutes >= 0
    and late_minutes >= 0
    and undertime_minutes >= 0
  ),
  add constraint payroll_records_calculation_amounts_nonnegative_check
  check (
    prepaid_pay >= 0
    and rest_day_pay >= 0
  );

alter table public.payroll_items
  add column work_date date,
  add column source_schedule_snapshot_id uuid
    references public.payroll_schedule_snapshots(id) on delete restrict,
  add column source_schedule_id uuid
    references public.work_schedules(id) on delete restrict,
  add column source_schedule_version bigint,
  add column calculation_version integer not null default 1,
  add column metadata jsonb not null default '{}'::jsonb;

alter table public.payroll_items
  add constraint payroll_items_calculation_version_positive_check
  check (calculation_version > 0),
  add constraint payroll_items_source_schedule_version_check
  check (
    source_schedule_version is null
    or source_schedule_version > 0
  ),
  add constraint payroll_items_metadata_object_check
  check (jsonb_typeof(metadata) = 'object'),
  add constraint payroll_items_automatic_source_date_check
  check (is_manual or work_date is not null);

create index payroll_items_record_calculation_idx
  on public.payroll_items (
    payroll_record_id,
    calculation_version,
    item_type,
    item_code
  );

create index payroll_items_schedule_snapshot_idx
  on public.payroll_items (source_schedule_snapshot_id)
  where source_schedule_snapshot_id is not null;

create index payroll_items_schedule_source_idx
  on public.payroll_items (
    source_schedule_id,
    source_schedule_version
  )
  where source_schedule_id is not null;

-- Agents may see only finalized own payroll data. Draft calculations remain
-- limited to explicit payroll processors.
drop policy if exists "Authorized users can view payroll periods"
on public.payroll_periods;
create policy "Authorized users can view payroll periods"
on public.payroll_periods
for select
to authenticated
using (
  (select public.workforce_has_permission('create_payroll'))
  or (select public.workforce_has_permission('review_payroll'))
  or (select public.workforce_has_permission('finalize_payroll'))
  or (select public.workforce_has_permission('view_all_payslips'))
  or (select public.workforce_has_permission('export_payslips'))
  or (select public.workforce_has_permission('reopen_payroll'))
  or (
    (select public.workforce_has_permission('view_own_payslips'))
    and exists (
      select 1
      from public.payroll_records as own_record
      where own_record.payroll_period_id = payroll_periods.id
        and own_record.status = 'finalized'
        and public.workforce_is_current_identity(own_record.employee_id)
    )
  )
);

drop policy if exists "Authorized users can view payroll records"
on public.payroll_records;
create policy "Authorized users can view payroll records"
on public.payroll_records
for select
to authenticated
using (
  (select public.workforce_has_permission('create_payroll'))
  or (select public.workforce_has_permission('review_payroll'))
  or (select public.workforce_has_permission('finalize_payroll'))
  or (select public.workforce_has_permission('view_all_payslips'))
  or (select public.workforce_has_permission('export_payslips'))
  or (select public.workforce_has_permission('reopen_payroll'))
  or (
    status = 'finalized'
    and (select public.workforce_has_permission('view_own_payslips'))
    and public.workforce_is_current_identity(employee_id)
  )
);

drop policy if exists "Authorized users can view payroll items"
on public.payroll_items;
create policy "Authorized users can view payroll items"
on public.payroll_items
for select
to authenticated
using (
  (select public.workforce_has_permission('create_payroll'))
  or (select public.workforce_has_permission('review_payroll'))
  or (select public.workforce_has_permission('finalize_payroll'))
  or (select public.workforce_has_permission('view_all_payslips'))
  or (select public.workforce_has_permission('export_payslips'))
  or (select public.workforce_has_permission('reopen_payroll'))
  or (
    (select public.workforce_has_permission('view_own_payslips'))
    and exists (
      select 1
      from public.payroll_records as own_record
      where own_record.id = payroll_items.payroll_record_id
        and own_record.status = 'finalized'
        and public.workforce_is_current_identity(own_record.employee_id)
    )
  )
);

create function public.payroll_calculate_draft(
  p_payroll_period_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := public.workforce_current_profile_id();
  v_period public.payroll_periods%rowtype;
  v_money_scale integer;
  v_rounding_mode text;
  v_minute_conversion text;
  v_blocking_exception_count bigint := 0;
  v_record_count bigint := 0;
  v_item_count bigint := 0;
  v_total_gross numeric(14,2) := 0;
  v_total_deductions numeric(14,2) := 0;
  v_total_net numeric(14,2) := 0;
  v_before_data jsonb;
  v_after_data jsonb;
begin
  if auth.uid() is null
     or v_actor_user_id is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_has_permission('create_payroll') then
    raise exception
      using
        errcode = '42501',
        message = 'You do not have permission to calculate payroll.';
  end if;

  if p_payroll_period_id is null then
    raise exception
      using errcode = '22023', message = 'Payroll period is required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.payroll_calculate_draft:' ||
        p_payroll_period_id::text,
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
        message = 'Payroll can only be calculated while the period is draft or reopened.';
  end if;

  v_money_scale := coalesce(
    (v_period.rounding_rules ->> 'money_scale')::integer,
    2
  );
  v_rounding_mode := coalesce(
    v_period.rounding_rules ->> 'rounding_mode',
    'half_up'
  );
  v_minute_conversion := coalesce(
    v_period.rounding_rules ->> 'minute_conversion',
    'exact'
  );

  if v_money_scale <> 2
     or v_rounding_mode <> 'half_up'
     or v_minute_conversion <> 'exact' then
    raise exception
      using
        errcode = '22023',
        message = 'This calculator requires money_scale 2, half_up rounding, and exact minute conversion.';
  end if;

  select count(*)
  into v_blocking_exception_count
  from public.payroll_get_period_exceptions(
    p_payroll_period_id
  ) as issue
  where issue.is_blocking;

  if v_blocking_exception_count > 0 then
    raise exception
      using
        errcode = '55000',
        message = format(
          'Resolve %s blocking payroll exception%s before calculation.',
          v_blocking_exception_count,
          case when v_blocking_exception_count = 1 then '' else 's' end
        );
  end if;

  if exists (
    select 1
    from public.payroll_records as record
    join lateral (
      select distinct on (
        snapshot.payroll_record_id,
        snapshot.attendance_id
      )
        snapshot.*
      from public.payroll_attendance_snapshots as snapshot
      join public.attendance as attendance_row
        on attendance_row.id = snapshot.attendance_id
       and attendance_row.attendance_version =
         snapshot.attendance_version
      where snapshot.payroll_record_id = record.id
      order by
        snapshot.payroll_record_id,
        snapshot.attendance_id,
        snapshot.attendance_version desc
    ) as current_snapshot on true
    where record.payroll_period_id = v_period.id
      and record.status <> 'void'
      and current_snapshot.special_day_type = 'unknown'
  ) then
    raise exception
      using
        errcode = '55000',
        message = 'Every attendance snapshot needs a verified ordinary, rest-day, or holiday classification.';
  end if;

  if exists (
    select 1
    from public.payroll_items as item
    join public.payroll_records as record
      on record.id = item.payroll_record_id
    where record.payroll_period_id = v_period.id
      and item.is_manual
      and item.item_code in (
        'government_deduction',
        'statutory_deduction'
      )
  ) then
    raise exception
      using
        errcode = '55000',
        message = 'Government and statutory deductions are not supported.';
  end if;

  select jsonb_build_object(
    'record_count', count(*),
    'gross_pay', coalesce(sum(record.gross_pay), 0),
    'total_deductions', coalesce(sum(record.total_deductions), 0),
    'net_pay', coalesce(sum(record.net_pay), 0)
  )
  into v_before_data
  from public.payroll_records as record
  where record.payroll_period_id = v_period.id
    and record.status <> 'void';

  perform 1
  from public.payroll_records as record
  where record.payroll_period_id = v_period.id
    and record.status <> 'void'
  for update;

  delete from public.payroll_items as item
  using public.payroll_records as record
  where record.id = item.payroll_record_id
    and record.payroll_period_id = v_period.id
    and not item.is_manual;

  update public.payroll_records as record
  set
    status = 'ready_for_review',
    currency_code = 'USD',
    regular_minutes = 0,
    regular_days = 0,
    overtime_minutes = 0,
    prepaid_minutes = 0,
    applied_prepaid_minutes = 0,
    rest_day_overtime_minutes = 0,
    holiday_overtime_minutes = 0,
    late_minutes = 0,
    undertime_minutes = 0,
    basic_pay = 0,
    prepaid_pay = 0,
    overtime_pay = 0,
    rest_day_pay = 0,
    holiday_pay = 0,
    other_earnings = 0,
    gross_pay = 0,
    late_deduction = 0,
    undertime_deduction = 0,
    unpaid_absence_deduction = 0,
    government_deductions = 0,
    other_deductions = 0,
    total_deductions = 0,
    net_pay = 0,
    requires_recalculation = false,
    recalculation_reason = null,
    calculation_version = case
      when record.calculated_at is null then record.calculation_version
      else record.calculation_version + 1
    end,
    calculated_by = v_actor_user_id,
    calculated_at = statement_timestamp(),
    updated_at = statement_timestamp()
  where record.payroll_period_id = v_period.id
    and record.status <> 'void';

  -- Ordinary approved attendance: allocations remove already-prepaid minutes.
  with current_snapshots as materialized (
    select distinct on (
      snapshot.payroll_record_id,
      snapshot.attendance_id
    )
      snapshot.*
    from public.payroll_attendance_snapshots as snapshot
    join public.attendance as attendance_row
      on attendance_row.id = snapshot.attendance_id
     and attendance_row.attendance_version =
       snapshot.attendance_version
    join public.payroll_records as record
      on record.id = snapshot.payroll_record_id
    where record.payroll_period_id = v_period.id
      and record.status <> 'void'
    order by
      snapshot.payroll_record_id,
      snapshot.attendance_id,
      snapshot.attendance_version desc
  ),
  active_allocations as materialized (
    select
      allocation.attendance_snapshot_id,
      allocation.minute_category,
      sum(allocation.allocated_minutes)::integer as allocated_minutes
    from public.payroll_hour_allocations as allocation
    where allocation.allocation_type = 'settlement'
      and not exists (
        select 1
        from public.payroll_hour_allocations as reversal
        where reversal.allocation_type = 'reversal'
          and reversal.reverses_allocation_id = allocation.id
      )
    group by
      allocation.attendance_snapshot_id,
      allocation.minute_category
  ),
  payable as materialized (
    select
      snapshot.*,
      record.calculation_version as record_calculation_version,
      greatest(
        snapshot.regular_minutes -
          coalesce(regular_allocation.allocated_minutes, 0),
        0
      )::integer as payable_regular_minutes,
      greatest(
        snapshot.pre_shift_overtime_minutes -
          coalesce(pre_allocation.allocated_minutes, 0),
        0
      )::integer as payable_pre_overtime_minutes,
      greatest(
        snapshot.post_shift_overtime_minutes -
          coalesce(post_allocation.allocated_minutes, 0),
        0
      )::integer as payable_post_overtime_minutes,
      coalesce(regular_allocation.allocated_minutes, 0)::integer
        as applied_regular_minutes,
      coalesce(pre_allocation.allocated_minutes, 0)::integer
        as applied_pre_overtime_minutes,
      coalesce(post_allocation.allocated_minutes, 0)::integer
        as applied_post_overtime_minutes,
      rate.id as rate_id,
      rate.effective_date as rate_effective_date,
      rate.hourly_rate,
      coalesce(rate.overtime_rate, rate.hourly_rate)
        as effective_overtime_rate,
      coalesce(rate.holiday_rate, rate.hourly_rate)
        as effective_holiday_rate
    from current_snapshots as snapshot
    join public.payroll_records as record
      on record.id = snapshot.payroll_record_id
    left join active_allocations as regular_allocation
      on regular_allocation.attendance_snapshot_id = snapshot.id
     and regular_allocation.minute_category = 'regular'
    left join active_allocations as pre_allocation
      on pre_allocation.attendance_snapshot_id = snapshot.id
     and pre_allocation.minute_category = 'pre_shift_overtime'
    left join active_allocations as post_allocation
      on post_allocation.attendance_snapshot_id = snapshot.id
     and post_allocation.minute_category = 'post_shift_overtime'
    join lateral (
      select effective_rate.*
      from public.agent_rates as effective_rate
      where effective_rate.employee_id = snapshot.employee_id
        and effective_rate.effective_date <= snapshot.work_date
      order by effective_rate.effective_date desc
      limit 1
    ) as rate on true
  ),
  lines as (
    select
      payable.payroll_record_id,
      'earning'::text as item_type,
      'regular_earnings'::text as item_code,
      'Approved regular earnings'::text as description,
      payable.payable_regular_minutes::numeric / 60 as quantity,
      payable.hourly_rate as unit_rate,
      round(
        payable.payable_regular_minutes::numeric /
          60 * payable.hourly_rate,
        v_money_scale
      ) as amount,
      payable.rate_id,
      payable.id as source_attendance_snapshot_id,
      payable.work_date,
      null::uuid as source_schedule_snapshot_id,
      null::uuid as source_schedule_id,
      null::bigint as source_schedule_version,
      payable.record_calculation_version as calculation_version,
      jsonb_build_object(
        'rate_effective_date', payable.rate_effective_date,
        'source_regular_minutes', payable.regular_minutes,
        'applied_prepaid_minutes', payable.applied_regular_minutes,
        'rounding_mode', v_rounding_mode
      ) as metadata
    from payable
    where payable.special_day_type = 'ordinary'
      and payable.payable_regular_minutes > 0

    union all

    select
      payable.payroll_record_id,
      'earning',
      'pre_shift_overtime',
      'Approved pre-shift overtime',
      payable.payable_pre_overtime_minutes::numeric / 60,
      payable.effective_overtime_rate,
      round(
        payable.payable_pre_overtime_minutes::numeric /
          60 * payable.effective_overtime_rate,
        v_money_scale
      ),
      payable.rate_id,
      payable.id,
      payable.work_date,
      null::uuid,
      null::uuid,
      null::bigint,
      payable.record_calculation_version,
      jsonb_build_object(
        'rate_effective_date', payable.rate_effective_date,
        'source_overtime_minutes',
          payable.pre_shift_overtime_minutes,
        'applied_prepaid_minutes',
          payable.applied_pre_overtime_minutes,
        'rounding_mode', v_rounding_mode
      )
    from payable
    where payable.special_day_type = 'ordinary'
      and payable.payable_pre_overtime_minutes > 0

    union all

    select
      payable.payroll_record_id,
      'earning',
      'post_shift_overtime',
      'Approved post-shift overtime',
      payable.payable_post_overtime_minutes::numeric / 60,
      payable.effective_overtime_rate,
      round(
        payable.payable_post_overtime_minutes::numeric /
          60 * payable.effective_overtime_rate,
        v_money_scale
      ),
      payable.rate_id,
      payable.id,
      payable.work_date,
      null::uuid,
      null::uuid,
      null::bigint,
      payable.record_calculation_version,
      jsonb_build_object(
        'rate_effective_date', payable.rate_effective_date,
        'source_overtime_minutes',
          payable.post_shift_overtime_minutes,
        'applied_prepaid_minutes',
          payable.applied_post_overtime_minutes,
        'rounding_mode', v_rounding_mode
      )
    from payable
    where payable.special_day_type = 'ordinary'
      and payable.payable_post_overtime_minutes > 0

    union all

    select
      payable.payroll_record_id,
      'earning',
      'rest_day_work',
      'Additional rest-day work',
      least(
        coalesce(payable.rest_day_overtime_minutes, 0),
        480
      )::numeric / 60,
      payable.effective_overtime_rate,
      round(
        least(
          coalesce(payable.rest_day_overtime_minutes, 0),
          480
        )::numeric / 60 * payable.effective_overtime_rate,
        v_money_scale
      ),
      payable.rate_id,
      payable.id,
      payable.work_date,
      null::uuid,
      null::uuid,
      null::bigint,
      payable.record_calculation_version,
      jsonb_build_object(
        'rate_effective_date', payable.rate_effective_date,
        'special_day_type', 'rest_day',
        'double_rate_after_minutes', 480,
        'rounding_mode', v_rounding_mode
      )
    from payable
    where payable.special_day_type = 'rest_day'
      and coalesce(payable.rest_day_overtime_minutes, 0) > 0

    union all

    select
      payable.payroll_record_id,
      'earning',
      'rest_day_excess',
      'Rest-day work over 8 hours at double rate',
      greatest(
        coalesce(payable.rest_day_overtime_minutes, 0) - 480,
        0
      )::numeric / 60,
      payable.effective_overtime_rate * 2,
      round(
        greatest(
          coalesce(payable.rest_day_overtime_minutes, 0) - 480,
          0
        )::numeric / 60 * payable.effective_overtime_rate * 2,
        v_money_scale
      ),
      payable.rate_id,
      payable.id,
      payable.work_date,
      null::uuid,
      null::uuid,
      null::bigint,
      payable.record_calculation_version,
      jsonb_build_object(
        'rate_effective_date', payable.rate_effective_date,
        'special_day_type', 'rest_day',
        'rate_multiplier', 2,
        'rounding_mode', v_rounding_mode
      )
    from payable
    where payable.special_day_type = 'rest_day'
      and coalesce(payable.rest_day_overtime_minutes, 0) > 480

    union all

    select
      payable.payroll_record_id,
      'earning',
      'holiday_work',
      'Additional holiday work',
      least(
        coalesce(payable.holiday_overtime_minutes, 0),
        480
      )::numeric / 60,
      payable.effective_holiday_rate,
      round(
        least(
          coalesce(payable.holiday_overtime_minutes, 0),
          480
        )::numeric / 60 * payable.effective_holiday_rate,
        v_money_scale
      ),
      payable.rate_id,
      payable.id,
      payable.work_date,
      null::uuid,
      null::uuid,
      null::bigint,
      payable.record_calculation_version,
      jsonb_build_object(
        'rate_effective_date', payable.rate_effective_date,
        'special_day_type', 'holiday',
        'double_rate_after_minutes', 480,
        'rounding_mode', v_rounding_mode
      )
    from payable
    where payable.special_day_type = 'holiday'
      and coalesce(payable.holiday_overtime_minutes, 0) > 0

    union all

    select
      payable.payroll_record_id,
      'earning',
      'holiday_excess',
      'Holiday work over 8 hours at double rate',
      greatest(
        coalesce(payable.holiday_overtime_minutes, 0) - 480,
        0
      )::numeric / 60,
      payable.effective_holiday_rate * 2,
      round(
        greatest(
          coalesce(payable.holiday_overtime_minutes, 0) - 480,
          0
        )::numeric / 60 * payable.effective_holiday_rate * 2,
        v_money_scale
      ),
      payable.rate_id,
      payable.id,
      payable.work_date,
      null::uuid,
      null::uuid,
      null::bigint,
      payable.record_calculation_version,
      jsonb_build_object(
        'rate_effective_date', payable.rate_effective_date,
        'special_day_type', 'holiday',
        'rate_multiplier', 2,
        'rounding_mode', v_rounding_mode
      )
    from payable
    where payable.special_day_type = 'holiday'
      and coalesce(payable.holiday_overtime_minutes, 0) > 480

    union all

    select
      payable.payroll_record_id,
      'deduction',
      'late_deduction',
      'Late minutes already excluded from approved regular earnings',
      payable.late_minutes::numeric / 60,
      payable.hourly_rate,
      0::numeric,
      payable.rate_id,
      payable.id,
      payable.work_date,
      null::uuid,
      null::uuid,
      null::bigint,
      payable.record_calculation_version,
      jsonb_build_object(
        'rate_effective_date', payable.rate_effective_date,
        'informational_only', true,
        'prevents_double_deduction', true
      )
    from payable
    where payable.special_day_type = 'ordinary'
      and payable.late_minutes > 0

    union all

    select
      payable.payroll_record_id,
      'deduction',
      'undertime_deduction',
      'Undertime already excluded from approved regular earnings',
      payable.undertime_minutes::numeric / 60,
      payable.hourly_rate,
      0::numeric,
      payable.rate_id,
      payable.id,
      payable.work_date,
      null::uuid,
      null::uuid,
      null::bigint,
      payable.record_calculation_version,
      jsonb_build_object(
        'rate_effective_date', payable.rate_effective_date,
        'informational_only', true,
        'prevents_double_deduction', true
      )
    from payable
    where payable.special_day_type = 'ordinary'
      and payable.undertime_minutes > 0
  )
  insert into public.payroll_items (
    payroll_record_id,
    item_type,
    item_code,
    description,
    quantity,
    unit_rate,
    amount,
    rate_id,
    source_attendance_snapshot_id,
    work_date,
    source_schedule_snapshot_id,
    source_schedule_id,
    source_schedule_version,
    calculation_version,
    metadata,
    is_manual,
    created_by,
    created_at
  )
  select
    line.payroll_record_id,
    line.item_type,
    line.item_code,
    line.description,
    line.quantity,
    line.unit_rate,
    line.amount,
    line.rate_id,
    line.source_attendance_snapshot_id,
    line.work_date,
    line.source_schedule_snapshot_id,
    line.source_schedule_id,
    line.source_schedule_version,
    line.calculation_version,
    line.metadata,
    false,
    v_actor_user_id,
    statement_timestamp()
  from lines as line;

  -- Approved pre-plotted schedules are paid in their source payroll period.
  insert into public.payroll_items (
    payroll_record_id,
    item_type,
    item_code,
    description,
    quantity,
    unit_rate,
    amount,
    rate_id,
    work_date,
    source_schedule_snapshot_id,
    source_schedule_id,
    source_schedule_version,
    calculation_version,
    metadata,
    is_manual,
    created_by,
    created_at
  )
  select
    record.id,
    'earning',
    'prepaid_scheduled_earnings',
    'Approved prepaid scheduled earnings',
    prepaid.prepaid_minutes::numeric / 60,
    rate.hourly_rate,
    round(
      prepaid.prepaid_minutes::numeric / 60 * rate.hourly_rate,
      v_money_scale
    ),
    rate.id,
    snapshot.work_date,
    snapshot.id,
    snapshot.schedule_id,
    snapshot.schedule_version,
    record.calculation_version,
    jsonb_build_object(
      'rate_effective_date', rate.effective_date,
      'prepaid_hour_id', prepaid.id,
      'prepaid_minutes', prepaid.prepaid_minutes,
      'settled_minutes', prepaid.settled_minutes,
      'remaining_minutes', prepaid.remaining_minutes,
      'balance_status', prepaid.status,
      'rounding_mode', v_rounding_mode
    ),
    false,
    v_actor_user_id,
    statement_timestamp()
  from public.payroll_records as record
  join public.payroll_prepaid_hours as prepaid
    on prepaid.source_payroll_record_id = record.id
   and prepaid.employee_id = record.employee_id
   and prepaid.voided_at is null
  join public.payroll_schedule_snapshots as snapshot
    on snapshot.id = prepaid.source_schedule_snapshot_id
  join lateral (
    select effective_rate.*
    from public.agent_rates as effective_rate
    where effective_rate.employee_id = record.employee_id
      and effective_rate.effective_date <= snapshot.work_date
    order by effective_rate.effective_date desc
    limit 1
  ) as rate on true
  where record.payroll_period_id = v_period.id
    and record.status <> 'void';

  -- A published holiday guarantees one full 8-hour day. Actual holiday work
  -- is paid separately by the attendance lines above.
  with holiday_sources as materialized (
    select distinct on (record.id, schedule.shift_date)
      record.id as payroll_record_id,
      record.employee_id,
      record.calculation_version,
      schedule.id as schedule_id,
      schedule.shift_date as work_date,
      schedule.schedule_version,
      schedule.holiday_name
    from public.payroll_records as record
    join public.work_schedules as schedule
      on schedule.user_id = record.employee_id
     and schedule.shift_date
       between v_period.period_start and v_period.period_end
     and schedule.status in ('published', 'changed', 'completed')
     and schedule.is_holiday
    where record.payroll_period_id = v_period.id
      and record.status <> 'void'
    order by
      record.id,
      schedule.shift_date,
      schedule.updated_at desc,
      schedule.id
  )
  insert into public.payroll_items (
    payroll_record_id,
    item_type,
    item_code,
    description,
    quantity,
    unit_rate,
    amount,
    rate_id,
    work_date,
    source_schedule_id,
    source_schedule_version,
    calculation_version,
    metadata,
    is_manual,
    created_by,
    created_at
  )
  select
    holiday.payroll_record_id,
    'earning',
    'holiday_guarantee',
    coalesce(
      'Guaranteed holiday pay — ' ||
        nullif(trim(holiday.holiday_name), ''),
      'Guaranteed holiday pay'
    ),
    8,
    rate.hourly_rate,
    round(rate.daily_rate, v_money_scale),
    rate.id,
    holiday.work_date,
    holiday.schedule_id,
    holiday.schedule_version,
    holiday.calculation_version,
    jsonb_build_object(
      'rate_effective_date', rate.effective_date,
      'guaranteed_minutes', 480,
      'actual_work_is_additional', true,
      'rounding_mode', v_rounding_mode
    ),
    false,
    v_actor_user_id,
    statement_timestamp()
  from holiday_sources as holiday
  join lateral (
    select effective_rate.*
    from public.agent_rates as effective_rate
    where effective_rate.employee_id = holiday.employee_id
      and effective_rate.effective_date <= holiday.work_date
    order by effective_rate.effective_date desc
    limit 1
  ) as rate on true;

  -- Rebuild non-monetary minute summaries from immutable snapshots and the
  -- append-only allocation ledger.
  with current_snapshots as materialized (
    select distinct on (
      snapshot.payroll_record_id,
      snapshot.attendance_id
    )
      snapshot.*
    from public.payroll_attendance_snapshots as snapshot
    join public.attendance as attendance_row
      on attendance_row.id = snapshot.attendance_id
     and attendance_row.attendance_version =
       snapshot.attendance_version
    join public.payroll_records as record
      on record.id = snapshot.payroll_record_id
    where record.payroll_period_id = v_period.id
      and record.status <> 'void'
    order by
      snapshot.payroll_record_id,
      snapshot.attendance_id,
      snapshot.attendance_version desc
  ),
  active_allocations as materialized (
    select
      allocation.attendance_snapshot_id,
      allocation.minute_category,
      sum(allocation.allocated_minutes)::integer as allocated_minutes
    from public.payroll_hour_allocations as allocation
    where allocation.allocation_type = 'settlement'
      and not exists (
        select 1
        from public.payroll_hour_allocations as reversal
        where reversal.allocation_type = 'reversal'
          and reversal.reverses_allocation_id = allocation.id
      )
    group by
      allocation.attendance_snapshot_id,
      allocation.minute_category
  ),
  attendance_totals as (
    select
      record.id as payroll_record_id,
      coalesce(sum(
        case
          when snapshot.special_day_type = 'ordinary'
            then greatest(
              snapshot.regular_minutes -
                coalesce(regular_allocation.allocated_minutes, 0),
              0
            )
          else 0
        end
      ), 0)::integer as regular_minutes,
      coalesce(sum(
        case
          when snapshot.special_day_type = 'ordinary'
            then greatest(
              snapshot.pre_shift_overtime_minutes -
                coalesce(pre_allocation.allocated_minutes, 0),
              0
            ) + greatest(
              snapshot.post_shift_overtime_minutes -
                coalesce(post_allocation.allocated_minutes, 0),
              0
            )
          else 0
        end
      ), 0)::integer as overtime_minutes,
      coalesce(sum(
        case
          when snapshot.special_day_type = 'rest_day'
            then coalesce(snapshot.rest_day_overtime_minutes, 0)
          else 0
        end
      ), 0)::integer as rest_day_minutes,
      coalesce(sum(
        case
          when snapshot.special_day_type = 'holiday'
            then coalesce(snapshot.holiday_overtime_minutes, 0)
          else 0
        end
      ), 0)::integer as holiday_minutes,
      coalesce(sum(
        coalesce(regular_allocation.allocated_minutes, 0)
        + coalesce(pre_allocation.allocated_minutes, 0)
        + coalesce(post_allocation.allocated_minutes, 0)
      ), 0)::integer as applied_prepaid_minutes,
      coalesce(sum(
        case
          when snapshot.special_day_type = 'ordinary'
            then snapshot.late_minutes
          else 0
        end
      ), 0)::integer as late_minutes,
      coalesce(sum(
        case
          when snapshot.special_day_type = 'ordinary'
            then snapshot.undertime_minutes
          else 0
        end
      ), 0)::integer as undertime_minutes
    from public.payroll_records as record
    left join current_snapshots as snapshot
      on snapshot.payroll_record_id = record.id
    left join active_allocations as regular_allocation
      on regular_allocation.attendance_snapshot_id = snapshot.id
     and regular_allocation.minute_category = 'regular'
    left join active_allocations as pre_allocation
      on pre_allocation.attendance_snapshot_id = snapshot.id
     and pre_allocation.minute_category = 'pre_shift_overtime'
    left join active_allocations as post_allocation
      on post_allocation.attendance_snapshot_id = snapshot.id
     and post_allocation.minute_category = 'post_shift_overtime'
    where record.payroll_period_id = v_period.id
      and record.status <> 'void'
    group by record.id
  ),
  prepaid_totals as (
    select
      record.id as payroll_record_id,
      coalesce(sum(prepaid.prepaid_minutes), 0)::integer
        as prepaid_minutes
    from public.payroll_records as record
    left join public.payroll_prepaid_hours as prepaid
      on prepaid.source_payroll_record_id = record.id
     and prepaid.employee_id = record.employee_id
     and prepaid.voided_at is null
    where record.payroll_period_id = v_period.id
      and record.status <> 'void'
    group by record.id
  )
  update public.payroll_records as record
  set
    regular_minutes = attendance.regular_minutes,
    regular_days = round(
      attendance.regular_minutes::numeric / 480,
      4
    ),
    overtime_minutes = attendance.overtime_minutes,
    prepaid_minutes = prepaid.prepaid_minutes,
    applied_prepaid_minutes =
      attendance.applied_prepaid_minutes,
    rest_day_overtime_minutes = attendance.rest_day_minutes,
    holiday_overtime_minutes = attendance.holiday_minutes,
    late_minutes = attendance.late_minutes,
    undertime_minutes = attendance.undertime_minutes
  from attendance_totals as attendance
  join prepaid_totals as prepaid
    on prepaid.payroll_record_id = attendance.payroll_record_id
  where record.id = attendance.payroll_record_id;

  if exists (
    select 1
    from public.payroll_records as record
    left join public.payroll_items as item
      on item.payroll_record_id = record.id
    where record.payroll_period_id = v_period.id
      and record.status <> 'void'
    group by record.id
    having
      coalesce(
        sum(item.amount) filter (
          where item.item_type = 'deduction'
        ),
        0
      ) >
      coalesce(
        sum(item.amount) filter (
          where item.item_type = 'earning'
        ),
        0
      )
  ) then
    raise exception
      using
        errcode = '22023',
        message = 'Payroll deductions cannot make an employee net pay negative.';
  end if;

  with item_totals as (
    select
      record.id as payroll_record_id,
      coalesce(sum(item.amount) filter (
        where item.item_type = 'earning'
          and item.item_code = 'regular_earnings'
      ), 0) as basic_pay,
      coalesce(sum(item.amount) filter (
        where item.item_type = 'earning'
          and item.item_code = 'prepaid_scheduled_earnings'
      ), 0) as prepaid_pay,
      coalesce(sum(item.amount) filter (
        where item.item_type = 'earning'
          and item.item_code in (
            'pre_shift_overtime',
            'post_shift_overtime'
          )
      ), 0) as overtime_pay,
      coalesce(sum(item.amount) filter (
        where item.item_type = 'earning'
          and item.item_code in (
            'rest_day_work',
            'rest_day_excess'
          )
      ), 0) as rest_day_pay,
      coalesce(sum(item.amount) filter (
        where item.item_type = 'earning'
          and item.item_code in (
            'holiday_guarantee',
            'holiday_work',
            'holiday_excess'
          )
      ), 0) as holiday_pay,
      coalesce(sum(item.amount) filter (
        where item.item_type = 'earning'
          and item.is_manual
      ), 0) as other_earnings,
      coalesce(sum(item.amount) filter (
        where item.item_type = 'earning'
      ), 0) as gross_pay,
      coalesce(sum(item.amount) filter (
        where item.item_type = 'deduction'
          and item.item_code = 'late_deduction'
      ), 0) as late_deduction,
      coalesce(sum(item.amount) filter (
        where item.item_type = 'deduction'
          and item.item_code = 'undertime_deduction'
      ), 0) as undertime_deduction,
      coalesce(sum(item.amount) filter (
        where item.item_type = 'deduction'
          and item.item_code = 'unpaid_absence'
      ), 0) as unpaid_absence_deduction,
      coalesce(sum(item.amount) filter (
        where item.item_type = 'deduction'
          and item.item_code = 'government_deduction'
      ), 0) as government_deductions,
      coalesce(sum(item.amount) filter (
        where item.item_type = 'deduction'
          and item.item_code not in (
            'late_deduction',
            'undertime_deduction',
            'unpaid_absence',
            'government_deduction'
          )
      ), 0) as other_deductions,
      coalesce(sum(item.amount) filter (
        where item.item_type = 'deduction'
      ), 0) as total_deductions
    from public.payroll_records as record
    left join public.payroll_items as item
      on item.payroll_record_id = record.id
    where record.payroll_period_id = v_period.id
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
    unpaid_absence_deduction =
      totals.unpaid_absence_deduction,
    government_deductions = 0,
    other_deductions = totals.other_deductions,
    total_deductions = totals.total_deductions,
    net_pay = totals.gross_pay - totals.total_deductions,
    updated_at = statement_timestamp()
  from item_totals as totals
  where record.id = totals.payroll_record_id;

  select
    count(*),
    coalesce(sum(record.gross_pay), 0),
    coalesce(sum(record.total_deductions), 0),
    coalesce(sum(record.net_pay), 0)
  into
    v_record_count,
    v_total_gross,
    v_total_deductions,
    v_total_net
  from public.payroll_records as record
  where record.payroll_period_id = v_period.id
    and record.status <> 'void';

  select count(*)
  into v_item_count
  from public.payroll_items as item
  join public.payroll_records as record
    on record.id = item.payroll_record_id
  where record.payroll_period_id = v_period.id;

  v_after_data := jsonb_build_object(
    'record_count', v_record_count,
    'item_count', v_item_count,
    'gross_pay', v_total_gross,
    'total_deductions', v_total_deductions,
    'net_pay', v_total_net
  );

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
    'payroll_draft_calculated',
    'payroll_period',
    v_period.id,
    v_period.id,
    v_before_data,
    v_after_data,
    'Calculated draft payroll from immutable approved snapshots',
    jsonb_build_object(
      'formula_version', 'phase2_step7_v1',
      'currency_code', 'USD',
      'rounding_rules', v_period.rounding_rules,
      'prepaid_allocation_method', 'fifo_minutes',
      'late_and_undertime_method',
        'already_excluded_from_approved_regular_minutes',
      'government_deductions_enabled', false,
      'special_day_double_rate_after_minutes', 480
    )
  );

  return jsonb_build_object(
    'payroll_period_id', v_period.id,
    'record_count', v_record_count,
    'item_count', v_item_count,
    'blocking_exception_count', 0,
    'gross_pay', v_total_gross,
    'total_deductions', v_total_deductions,
    'net_pay', v_total_net,
    'currency_code', 'USD',
    'calculated_at', statement_timestamp()
  );
end;
$$;

revoke all on function public.payroll_calculate_draft(uuid)
  from public, anon;
grant execute on function public.payroll_calculate_draft(uuid)
  to authenticated, service_role;

comment on function public.payroll_calculate_draft(uuid) is
  'Atomically recalculates editable USD payroll from current approved snapshots, effective-dated rates, exact minutes, and active prepaid allocations. Requires create_payroll.';

create function public.payroll_get_period_calculation(
  p_payroll_period_id uuid
)
returns table (
  payroll_record_id uuid,
  employee_user_id uuid,
  employee_name text,
  employee_number text,
  employee_email text,
  record_status text,
  regular_minutes integer,
  prepaid_minutes integer,
  applied_prepaid_minutes integer,
  overtime_minutes integer,
  rest_day_minutes integer,
  holiday_minutes integer,
  late_minutes integer,
  undertime_minutes integer,
  basic_pay numeric,
  prepaid_pay numeric,
  overtime_pay numeric,
  rest_day_pay numeric,
  holiday_pay numeric,
  other_earnings numeric,
  gross_pay numeric,
  total_deductions numeric,
  net_pay numeric,
  currency_code text,
  calculation_version integer,
  calculated_at timestamptz,
  calculated_by_name text,
  line_item_count bigint,
  line_items jsonb
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
        message = 'You do not have permission to view draft payroll calculations.';
  end if;

  if p_payroll_period_id is null then
    raise exception
      using errcode = '22023', message = 'Payroll period is required.';
  end if;

  return query
  select
    record.id,
    record.employee_id,
    profile.full_name,
    profile.employee_id,
    profile.email,
    record.status,
    record.regular_minutes,
    record.prepaid_minutes,
    record.applied_prepaid_minutes,
    record.overtime_minutes,
    record.rest_day_overtime_minutes,
    record.holiday_overtime_minutes,
    record.late_minutes,
    record.undertime_minutes,
    record.basic_pay,
    record.prepaid_pay,
    record.overtime_pay,
    record.rest_day_pay,
    record.holiday_pay,
    record.other_earnings,
    record.gross_pay,
    record.total_deductions,
    record.net_pay,
    record.currency_code,
    record.calculation_version,
    record.calculated_at,
    calculator.full_name,
    count(item.id),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', item.id,
          'item_type', item.item_type,
          'item_code', item.item_code,
          'description', item.description,
          'work_date', item.work_date,
          'quantity', item.quantity,
          'unit_rate', item.unit_rate,
          'amount', item.amount,
          'is_manual', item.is_manual,
          'rate_effective_date',
            item.metadata ->> 'rate_effective_date',
          'applied_prepaid_minutes',
            item.metadata ->> 'applied_prepaid_minutes',
          'informational_only',
            coalesce(
              (item.metadata ->> 'informational_only')::boolean,
              false
            )
        )
        order by
          item.work_date nulls last,
          item.item_type,
          item.item_code,
          item.created_at,
          item.id
      ) filter (where item.id is not null),
      '[]'::jsonb
    )
  from public.payroll_records as record
  join public.profiles as profile
    on profile.user_id = record.employee_id
  left join public.profiles as calculator
    on calculator.user_id = record.calculated_by
  left join public.payroll_items as item
    on item.payroll_record_id = record.id
  where record.payroll_period_id = p_payroll_period_id
    and record.status <> 'void'
  group by
    record.id,
    profile.full_name,
    profile.employee_id,
    profile.email,
    calculator.full_name
  order by profile.full_name, profile.email, record.id;
end;
$$;

revoke all on function public.payroll_get_period_calculation(uuid)
  from public, anon;
grant execute on function public.payroll_get_period_calculation(uuid)
  to authenticated, service_role;

comment on function public.payroll_get_period_calculation(uuid) is
  'Returns payroll-processor-only draft totals and calculation lines. Own-payslip access does not grant draft payroll visibility.';

commit;
