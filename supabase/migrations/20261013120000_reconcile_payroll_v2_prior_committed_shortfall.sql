create or replace function public.payroll_v2_prior_committed_hours_shortfall(
  p_payroll_v2_period_id uuid,
  p_employee_user_id uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_current public.payroll_v2_periods%rowtype;
  v_prior public.payroll_v2_periods%rowtype;
  v_coverage jsonb := '{}'::jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_source_rows jsonb := '[]'::jsonb;
  v_amount numeric(14,2) := 0;
  v_total_minutes integer := 0;
  v_count integer := 0;
  v_currency_count integer := 0;
  v_currency_code text;
  v_rate_missing boolean := false;
begin
  if p_payroll_v2_period_id is null or p_employee_user_id is null then
    return jsonb_build_object('rows', '[]'::jsonb, 'amount', 0, 'count', 0, 'rate_missing', false);
  end if;

  select period.*
  into v_current
  from public.payroll_v2_periods period
  where period.id = p_payroll_v2_period_id;

  if not found or v_current.status = 'void' or v_current.period_end < date '2026-10-01' then
    return jsonb_build_object('rows', '[]'::jsonb, 'amount', 0, 'count', 0, 'rate_missing', false);
  end if;

  select period.*
  into v_prior
  from public.payroll_v2_periods period
  where period.id <> v_current.id
    and period.status <> 'void'
    and period.period_end < v_current.period_start
  order by period.period_end desc, period.period_start desc, period.created_at desc, period.id desc
  limit 1;

  if not found then
    return jsonb_build_object('rows', '[]'::jsonb, 'amount', 0, 'count', 0, 'rate_missing', false);
  end if;

  -- Reuse the canonical FIFO calculation so attendance approved after the
  -- original payroll calculation is considered without rewriting that snapshot.
  v_coverage := public.payroll_get_expected_committed_hours_summary(
    p_employee_user_id,
    v_prior.period_start,
    v_prior.period_end
  );

  with source as (
    select
      snapshot.id as snapshot_id,
      snapshot.work_date,
      snapshot.commitment_source_id,
      record.id as source_record_id,
      item.id as paid_item_id,
      item.minutes as paid_minutes,
      item.rate as paid_rate,
      item.metadata as paid_metadata,
      live.target as coverage_target,
      greatest(coalesce((live.target ->> 'remaining_minutes')::integer, 0), 0) as remaining_minutes,
      count(item.id) over (partition by snapshot.id)::integer as paid_item_count
    from public.payroll_v2_committed_hours_snapshots snapshot
    join public.payroll_v2_records record
      on record.id = snapshot.payroll_v2_record_id
     and record.employee_user_id = snapshot.employee_user_id
    left join public.payroll_v2_items item
      on item.payroll_v2_record_id = record.id
     and item.item_type = 'committed_hours'
     and item.source_type = 'payroll_prepaid_commitments'
     and item.source_id = snapshot.commitment_source_id
    join lateral (
      select target.value
      from jsonb_array_elements(coalesce(v_coverage -> 'payroll_targets', '[]'::jsonb)) target(value)
      where target.value ->> 'commitment_id' = snapshot.commitment_source_id::text
      limit 1
    ) live(target) on true
    where record.payroll_v2_period_id = v_prior.id
      and record.employee_user_id = p_employee_user_id
      and record.status <> 'void'
      and snapshot.employee_user_id = p_employee_user_id
  ), priced as (
    select
      source.*,
      case
        when source.paid_item_count = 1
          and source.paid_rate is not null
          and source.paid_rate > 0
          and source.paid_minutes is not null
          then least(source.remaining_minutes, greatest(source.paid_minutes, 0))::integer
        else 0
      end as deductible_minutes,
      case
        when source.paid_item_count = 1
          and source.paid_rate is not null
          and source.paid_rate > 0
          and source.paid_minutes is not null
          then round(
            least(source.remaining_minutes, greatest(source.paid_minutes, 0))::numeric
              / 60 * source.paid_rate,
            2
          )::numeric(14,2)
        else 0::numeric(14,2)
      end as deduction_amount,
      source.remaining_minutes > 0 and (
        source.paid_item_count <> 1
        or source.paid_rate is null
        or source.paid_rate <= 0
        or source.paid_minutes is null
      ) as missing_paid_rate
    from source
  )
  select
    coalesce(sum(priced.deduction_amount), 0)::numeric(14,2),
    coalesce(sum(priced.deductible_minutes) filter (where priced.deduction_amount > 0), 0)::integer,
    coalesce(jsonb_agg(jsonb_build_object(
      'snapshot_id', priced.snapshot_id,
      'work_date', priced.work_date,
      'commitment_source_id', priced.commitment_source_id,
      'prior_payroll_record_id', priced.source_record_id,
      'paid_item_id', priced.paid_item_id,
      'originally_paid_minutes', priced.paid_minutes,
      'original_expected_minutes', (priced.coverage_target ->> 'expected_minutes')::integer,
      'covered_minutes', (priced.coverage_target ->> 'covered_minutes')::integer,
      'remaining_minutes', priced.remaining_minutes,
      'source_attendance_ids', coalesce(priced.coverage_target -> 'source_attendance_ids', '[]'::jsonb),
      'attendance_sources', coalesce(priced.coverage_target -> 'attendance_sources', '[]'::jsonb),
      'minutes', priced.deductible_minutes,
      'rate', priced.paid_rate,
      'amount', priced.deduction_amount,
      'rate_effective_date', priced.paid_metadata -> 'rate_effective_date'
    ) order by priced.work_date, priced.snapshot_id)
      filter (where priced.deduction_amount > 0), '[]'::jsonb),
    (count(distinct coalesce(priced.paid_metadata ->> 'currency_code', 'USD'))
      filter (where priced.deduction_amount > 0))::integer,
    min(coalesce(priced.paid_metadata ->> 'currency_code', 'USD'))
      filter (where priced.deduction_amount > 0),
    coalesce(bool_or(priced.missing_paid_rate), false)
  into v_amount, v_total_minutes, v_source_rows, v_currency_count, v_currency_code, v_rate_missing
  from priced;

  if v_currency_count > 1 then
    v_rate_missing := true;
  end if;

  if not v_rate_missing and v_amount > 0 then
    v_rows := jsonb_build_array(jsonb_build_object(
      'id', v_prior.id,
      'source_type', 'payroll_v2_committed_hours_shortfall',
      'kind', 'deduction',
      'description', 'Committed Hours Shortfall — Prior Cutoff '
        || to_char(v_prior.period_start, 'YYYY-MM-DD') || ' to '
        || to_char(v_prior.period_end, 'YYYY-MM-DD'),
      'amount', v_amount,
      'currency_code', coalesce(v_currency_code, 'USD'),
      'status', 'Approved',
      'included_in_preview', true,
      'can_void', false,
      'work_date', v_prior.period_end,
      'minutes', v_total_minutes,
      'rate', null,
      'prior_period_id', v_prior.id,
      'prior_period_start', v_prior.period_start,
      'prior_period_end', v_prior.period_end,
      'source_snapshots', v_source_rows
    ));
    v_count := 1;
  end if;

  return jsonb_build_object(
    'rows', v_rows,
    'amount', case when v_rate_missing then 0 else v_amount end,
    'count', v_count,
    'rate_missing', v_rate_missing,
    'prior_period_id', v_prior.id,
    'prior_period_start', v_prior.period_start,
    'prior_period_end', v_prior.period_end
  );
end;
$$;

comment on function public.payroll_v2_prior_committed_hours_shortfall(uuid, uuid) is
  'Reconciles prior-cutoff Committed Hours against current approved payroll-ready FIFO coverage while preserving original paid rates and source snapshots.';

revoke all on function public.payroll_v2_prior_committed_hours_shortfall(uuid, uuid) from public;
grant all on function public.payroll_v2_prior_committed_hours_shortfall(uuid, uuid) to service_role;
