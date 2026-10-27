-- Committed Hours are scoped to Payroll V2 period boundaries. Shortfalls from
-- a policy-effective cutoff are derived into the immediately following
-- employee calculation and persisted as source-linked Payroll V2 deduction
-- items. No legacy payroll rows or historical finalized snapshots are edited.

create or replace function public.payroll_v2_prior_committed_hours_shortfall(
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
  v_current public.payroll_v2_periods%rowtype;
  v_prior public.payroll_v2_periods%rowtype;
  v_rows jsonb := '[]'::jsonb;
  v_amount numeric(14,2) := 0;
  v_count integer := 0;
  v_rate_missing boolean := false;
begin
  if p_payroll_v2_period_id is null or p_employee_user_id is null then
    return jsonb_build_object('rows', '[]'::jsonb, 'amount', 0, 'count', 0, 'rate_missing', false);
  end if;

  select period.*
  into v_current
  from public.payroll_v2_periods period
  where period.id = p_payroll_v2_period_id;

  -- Rollout boundary: Payroll V2 periods beginning before deployment remain
  -- grandfathered. The date is a policy activation date, not a payroll-period
  -- definition; period starts and ends always come from payroll_v2_periods.
  if not found or v_current.status = 'void' or v_current.period_start < date '2026-10-06' then
    return jsonb_build_object('rows', '[]'::jsonb, 'amount', 0, 'count', 0, 'rate_missing', false);
  end if;

  select period.*
  into v_prior
  from public.payroll_v2_periods period
  where period.id <> v_current.id
    and period.status <> 'void'
    and period.period_end < v_current.period_start
    and period.period_start >= date '2026-10-06'
  order by period.period_end desc, period.period_start desc, period.created_at desc, period.id desc
  limit 1;

  if not found then
    return jsonb_build_object('rows', '[]'::jsonb, 'amount', 0, 'count', 0, 'rate_missing', false);
  end if;

  with source as (
    select
      snapshot.id as snapshot_id,
      snapshot.work_date,
      snapshot.commitment_source_id,
      snapshot.remaining_committed_minutes,
      record.id as source_record_id,
      item.id as paid_item_id,
      item.minutes as paid_minutes,
      item.rate as paid_rate,
      item.metadata as paid_metadata,
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
    where record.payroll_v2_period_id = v_prior.id
      and record.employee_user_id = p_employee_user_id
      and record.status <> 'void'
      and snapshot.employee_user_id = p_employee_user_id
      and snapshot.remaining_committed_minutes > 0
  ), priced as (
    select
      source.*,
      case
        when source.paid_item_count = 1
          and source.paid_rate is not null
          and source.paid_rate > 0
          and source.paid_minutes is not null
          then least(
            greatest(source.remaining_committed_minutes, 0),
            greatest(source.paid_minutes, 0)
          )::integer
        else 0
      end as deductible_minutes,
      case
        when source.paid_item_count = 1
          and source.paid_rate is not null
          and source.paid_rate > 0
          and source.paid_minutes is not null
          then round(
            least(
              greatest(source.remaining_committed_minutes, 0),
              greatest(source.paid_minutes, 0)
            )::numeric / 60 * source.paid_rate,
            2
          )::numeric(14,2)
        else 0::numeric(14,2)
      end as deduction_amount,
      source.paid_item_count <> 1
        or source.paid_rate is null
        or source.paid_rate <= 0
        or source.paid_minutes is null as missing_paid_rate
    from source
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'id', priced.snapshot_id,
      'source_type', 'payroll_v2_committed_hours_snapshots',
      'kind', 'deduction',
      'description', 'Committed Hours Shortfall — Prior Cutoff '
        || to_char(v_prior.period_start, 'YYYY-MM-DD') || ' to '
        || to_char(v_prior.period_end, 'YYYY-MM-DD') || ' ('
        || to_char(priced.work_date, 'YYYY-MM-DD') || ')',
      'amount', priced.deduction_amount,
      'currency_code', coalesce(priced.paid_metadata ->> 'currency_code', 'USD'),
      'status', 'Approved',
      'included_in_preview', true,
      'can_void', false,
      'work_date', priced.work_date,
      'minutes', priced.deductible_minutes,
      'rate', priced.paid_rate,
      'prior_period_id', v_prior.id,
      'prior_period_start', v_prior.period_start,
      'prior_period_end', v_prior.period_end,
      'prior_payroll_record_id', priced.source_record_id,
      'commitment_source_id', priced.commitment_source_id,
      'paid_item_id', priced.paid_item_id,
      'rate_effective_date', priced.paid_metadata -> 'rate_effective_date'
    ) order by priced.work_date, priced.snapshot_id)
      filter (where priced.deduction_amount > 0), '[]'::jsonb),
    coalesce(sum(priced.deduction_amount), 0)::numeric(14,2),
    count(*) filter (where priced.deduction_amount > 0)::integer,
    coalesce(bool_or(priced.missing_paid_rate), false)
  into v_rows, v_amount, v_count, v_rate_missing
  from priced;

  return jsonb_build_object(
    'rows', v_rows,
    'amount', v_amount,
    'count', v_count,
    'rate_missing', v_rate_missing,
    'prior_period_id', v_prior.id,
    'prior_period_start', v_prior.period_start,
    'prior_period_end', v_prior.period_end
  );
end;
$function$;

revoke all on function public.payroll_v2_prior_committed_hours_shortfall(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_v2_prior_committed_hours_shortfall(uuid, uuid)
  to service_role;
comment on function public.payroll_v2_prior_committed_hours_shortfall(uuid, uuid) is
  'Derives prior-cutoff Committed Hours shortfall rows from Payroll V2 snapshots and the exact committed-hours earning rates paid in that cutoff.';

-- Patch the shared FIFO engine in place so all attendance and payroll callers
-- use the same period-aware queue while preserving the latest deployed
-- readiness, overtime, and paid-minute behavior in the existing definition.
do $patch$
declare
  v_definition text;
  v_old_declaration text := $old$  v_opening_carryover integer := 0;$old$;
  v_new_declaration text := $new$  v_opening_carryover integer := 0;
  v_period_ranges jsonb := '[]'::jsonb;
  v_day_period_id uuid;
  v_previous_period_id uuid;
  v_period_match_count integer := 0;$new$;
  v_old_period_prefetch text := $old$  -- Read eligible attendance once for the full FIFO window instead of$old$;
  v_new_period_prefetch text := $new$  -- Use Payroll V2's stored dates to decide when FIFO balances reset.
  select coalesce(jsonb_agg(jsonb_build_object(
    'period_id', period.id,
    'period_start', period.period_start,
    'period_end', period.period_end
  ) order by period.period_start, period.period_end, period.created_at, period.id), '[]'::jsonb)
  into v_period_ranges
  from public.payroll_v2_periods period
  where period.status <> 'void'
    and period.period_start <= p_end_date
    and period.period_end >= v_first_date;

  -- Read eligible attendance once for the full FIFO window instead of$new$;
  v_old_loop text := $old$  loop
    -- Capture the debt at the boundary before this range's first target is due.$old$;
  v_new_loop text := $new$  loop
    select count(*)::integer, max(period_range.value ->> 'period_id')::uuid
    into v_period_match_count, v_day_period_id
    from jsonb_array_elements(v_period_ranges) period_range(value)
    where v_day between (period_range.value ->> 'period_start')::date
      and (period_range.value ->> 'period_end')::date;

    if v_period_match_count > 1 then
      raise exception using errcode = '22023',
        message = 'Overlapping Payroll V2 periods prevent safe Committed Hours allocation.';
    end if;

    -- An unassigned date has no canonical Payroll V2 period to carry within.
    -- Resetting on every such date keeps the engine fail-closed until a period
    -- is created; attendance on that date can still cover that date's target.
    if v_day_period_id is distinct from v_previous_period_id or v_day_period_id is null then
      v_queue := '[]'::jsonb;
    end if;
    v_previous_period_id := v_day_period_id;

    -- Capture the debt at the boundary before this range's first target is due.$new$;
begin
  v_definition := replace(
    pg_catalog.pg_get_functiondef(
      'public.payroll_get_expected_committed_hours_summary(uuid, date, date)'::regprocedure
    ),
    chr(13),
    ''
  );

  if pg_catalog.strpos(v_definition, v_old_declaration) = 0
     or pg_catalog.strpos(v_definition, v_old_period_prefetch) = 0
     or pg_catalog.strpos(v_definition, v_old_loop) = 0 then
    raise exception 'Committed Hours FIFO function changed; cutoff-scope patch aborted.';
  end if;

  v_definition := pg_catalog.replace(v_definition, v_old_declaration, v_new_declaration);
  v_definition := pg_catalog.replace(v_definition, v_old_period_prefetch, v_new_period_prefetch);
  v_definition := pg_catalog.replace(v_definition, v_old_loop, v_new_loop);

  if pg_catalog.strpos(v_definition, 'v_period_ranges') = 0
     or pg_catalog.strpos(v_definition, 'Overlapping Payroll V2 periods prevent safe Committed Hours allocation.') = 0 then
    raise exception 'Committed Hours cutoff-scope patch failed verification.';
  end if;

  execute v_definition;
end;
$patch$;

-- Add the derived shortfall to the existing read-only employee calculation
-- payload. The original CH earnings and rate snapshot remain untouched.
do $patch$
declare
  v_definition text;
  v_old_declaration text := $old$  v_deduction_rows jsonb := '[]'::jsonb;$old$;
  v_new_declaration text := $new$  v_deduction_rows jsonb := '[]'::jsonb;
  v_prior_shortfall jsonb := '{}'::jsonb;$new$;
  v_old_calculation text := $old$  if v_ready then
    v_gross_pay := round($old$;
  v_new_calculation text := $new$  v_prior_shortfall := public.payroll_v2_prior_committed_hours_shortfall(
    p_payroll_v2_period_id,
    p_employee_user_id
  );
  v_deduction_rows := coalesce(v_deduction_rows, '[]'::jsonb)
    || coalesce(v_prior_shortfall -> 'rows', '[]'::jsonb);
  v_deductions := coalesce(v_deductions, 0)
    + coalesce((v_prior_shortfall ->> 'amount')::numeric, 0);

  if coalesce((v_prior_shortfall ->> 'rate_missing')::boolean, false) then
    v_rate_blockers := v_rate_blockers || jsonb_build_array(
      'A prior-cutoff Committed Hours deduction cannot be priced because its paid source rate is unavailable.'
    );
    v_blockers := v_blockers || jsonb_build_array(
      'A prior-cutoff Committed Hours deduction cannot be priced because its paid source rate is unavailable.'
    );
  end if;
  v_ready := jsonb_array_length(v_rate_blockers) = 0;

  if v_ready then
    v_gross_pay := round($new$;
  v_old_approved_count text := $old$'approved_count', (select count(*) from public.payroll_v2_deductions d where d.payroll_v2_period_id = p_payroll_v2_period_id and d.employee_user_id = p_employee_user_id and d.status = 'approved'),$old$;
  v_new_approved_count text := $new$'approved_count', (select count(*) from public.payroll_v2_deductions d where d.payroll_v2_period_id = p_payroll_v2_period_id and d.employee_user_id = p_employee_user_id and d.status = 'approved') + coalesce((v_prior_shortfall ->> 'count')::integer, 0),$new$;
begin
  v_definition := replace(
    pg_catalog.pg_get_functiondef(
      'public.payroll_v2_employee_calculation_payload(uuid, uuid)'::regprocedure
    ),
    chr(13),
    ''
  );

  if pg_catalog.strpos(v_definition, v_old_declaration) = 0
     or pg_catalog.strpos(v_definition, v_old_calculation) = 0
     or pg_catalog.strpos(v_definition, v_old_approved_count) = 0 then
    raise exception 'Payroll V2 calculation payload changed; shortfall patch aborted.';
  end if;

  v_definition := pg_catalog.replace(v_definition, v_old_declaration, v_new_declaration);
  v_definition := pg_catalog.replace(v_definition, v_old_calculation, v_new_calculation);
  v_definition := pg_catalog.replace(v_definition, v_old_approved_count, v_new_approved_count);

  if pg_catalog.strpos(v_definition, 'payroll_v2_prior_committed_hours_shortfall') = 0
     or pg_catalog.strpos(v_definition, 'Committed Hours deduction cannot be priced') = 0 then
    raise exception 'Payroll V2 shortfall payload patch failed verification.';
  end if;

  execute v_definition;
end;
$patch$;

-- Persist each derived row in the existing Payroll V2 item ledger. Manual
-- deduction rows keep their existing source table and lifecycle.
do $patch$
declare
  v_definition text;
  v_old_deduction_filter text := $old$  for v_item in
    select value from jsonb_array_elements(coalesce(v_calculation -> 'deductions' -> 'rows', '[]'::jsonb))
    where coalesce((value ->> 'included_in_preview')::boolean, false)
  loop
    insert into public.payroll_v2_items ($old$;
  v_new_deduction_filter text := $new$  for v_item in
    select value from jsonb_array_elements(coalesce(v_calculation -> 'deductions' -> 'rows', '[]'::jsonb))
    where coalesce((value ->> 'included_in_preview')::boolean, false)
      and coalesce(value ->> 'source_type', 'payroll_v2_deductions') = 'payroll_v2_deductions'
  loop
    insert into public.payroll_v2_items ($new$;
  v_old_snapshot_anchor text := $old$  -- Snapshot one attendance aggregation per actual payroll-facing work date.$old$;
  v_new_snapshot_anchor text := $new$  for v_item in
    select value
    from jsonb_array_elements(coalesce(v_calculation -> 'deductions' -> 'rows', '[]'::jsonb))
    where coalesce((value ->> 'included_in_preview')::boolean, false)
      and value ->> 'source_type' = 'payroll_v2_committed_hours_snapshots'
  loop
    insert into public.payroll_v2_items (
      payroll_v2_record_id, item_type, description, work_date,
      source_type, source_id, minutes, rate, amount, metadata
    ) values (
      v_record_id,
      'deduction',
      coalesce(nullif(v_item ->> 'description', ''), 'Committed Hours Shortfall — Prior Cutoff'),
      nullif(v_item ->> 'work_date', '')::date,
      'payroll_v2_committed_hours_snapshots',
      (v_item ->> 'id')::uuid,
      coalesce((v_item ->> 'minutes')::integer, 0),
      (v_item ->> 'rate')::numeric,
      (v_item ->> 'amount')::numeric(12,2),
      jsonb_build_object(
        'status', v_item -> 'status',
        'currency_code', v_item -> 'currency_code',
        'prior_period_id', v_item -> 'prior_period_id',
        'prior_period_start', v_item -> 'prior_period_start',
        'prior_period_end', v_item -> 'prior_period_end',
        'prior_payroll_record_id', v_item -> 'prior_payroll_record_id',
        'commitment_source_id', v_item -> 'commitment_source_id',
        'paid_item_id', v_item -> 'paid_item_id',
        'rate_effective_date', v_item -> 'rate_effective_date'
      )
    );
  end loop;

  -- Snapshot one attendance aggregation per actual payroll-facing work date.$new$;
begin
  v_definition := replace(
    pg_catalog.pg_get_functiondef('public.payroll_v2_calculate_employee(uuid, uuid)'::regprocedure),
    chr(13),
    ''
  );

  if pg_catalog.strpos(v_definition, v_old_deduction_filter) = 0
     or pg_catalog.strpos(v_definition, v_old_snapshot_anchor) = 0 then
    raise exception 'Payroll V2 item writer changed; shortfall persistence patch aborted.';
  end if;

  v_definition := pg_catalog.replace(v_definition, v_old_deduction_filter, v_new_deduction_filter);
  v_definition := pg_catalog.replace(v_definition, v_old_snapshot_anchor, v_new_snapshot_anchor);

  if pg_catalog.strpos(v_definition, 'payroll_v2_committed_hours_snapshots') = 0 then
    raise exception 'Payroll V2 shortfall item writer patch failed verification.';
  end if;

  execute v_definition;
end;
$patch$;

-- Recalculation replaces all child items transactionally; this additional key
-- makes duplicate prior-cutoff source rows impossible within one employee pay.
create unique index payroll_v2_items_prior_cutoff_ch_shortfall_source_key
  on public.payroll_v2_items (payroll_v2_record_id, source_id)
  where item_type = 'deduction'
    and source_type = 'payroll_v2_committed_hours_snapshots';

comment on index public.payroll_v2_items_prior_cutoff_ch_shortfall_source_key is
  'One derived prior-cutoff Committed Hours deduction per source snapshot in a Payroll V2 employee record.';

;
