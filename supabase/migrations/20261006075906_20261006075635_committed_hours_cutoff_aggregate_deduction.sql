-- Present one aggregate deduction line for the prior cutoff while retaining
-- each paid Committed Hours source in the ledger item's audit metadata.
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
    coalesce(sum(priced.deduction_amount), 0)::numeric(14,2),
    coalesce(sum(priced.deductible_minutes) filter (where priced.deduction_amount > 0), 0)::integer,
    coalesce(jsonb_agg(jsonb_build_object(
      'snapshot_id', priced.snapshot_id,
      'work_date', priced.work_date,
      'commitment_source_id', priced.commitment_source_id,
      'prior_payroll_record_id', priced.source_record_id,
      'paid_item_id', priced.paid_item_id,
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
$function$;

comment on function public.payroll_v2_prior_committed_hours_shortfall(uuid, uuid) is
  'Derives one aggregate prior-cutoff Committed Hours deduction while retaining each paid snapshot and exact rate in source metadata.';

-- The aggregate line points to its prior payroll period. Full source-level
-- provenance remains in metadata.source_snapshots.
do $patch$
declare
  v_definition text;
  v_old_filter text := $old$      and value ->> 'source_type' = 'payroll_v2_committed_hours_snapshots'$old$;
  v_new_filter text := $new$      and value ->> 'source_type' = 'payroll_v2_committed_hours_shortfall'$new$;
  v_old_source_type text := $old$      'payroll_v2_committed_hours_snapshots',$old$;
  v_new_source_type text := $new$      'payroll_v2_committed_hours_shortfall',$new$;
  v_old_metadata text := $old$        'rate_effective_date', v_item -> 'rate_effective_date'
      )$old$;
  v_new_metadata text := $new$        'rate_effective_date', v_item -> 'rate_effective_date',
        'source_snapshots', v_item -> 'source_snapshots'
      )$new$;
begin
  v_definition := pg_catalog.replace(
    pg_catalog.pg_get_functiondef('public.payroll_v2_calculate_employee(uuid, uuid)'::regprocedure),
    chr(13),
    ''
  );

  if pg_catalog.strpos(v_definition, v_old_filter) = 0
     or pg_catalog.strpos(v_definition, v_old_source_type) = 0
     or pg_catalog.strpos(v_definition, v_old_metadata) = 0 then
    raise exception 'Payroll V2 shortfall writer changed; aggregate-line patch aborted.';
  end if;

  v_definition := pg_catalog.replace(v_definition, v_old_filter, v_new_filter);
  v_definition := pg_catalog.replace(v_definition, v_old_source_type, v_new_source_type);
  v_definition := pg_catalog.replace(v_definition, v_old_metadata, v_new_metadata);

  if pg_catalog.strpos(v_definition, 'payroll_v2_committed_hours_shortfall') = 0
     or pg_catalog.strpos(v_definition, '''source_snapshots'', v_item -> ''source_snapshots''') = 0 then
    raise exception 'Payroll V2 aggregate shortfall writer patch failed verification.';
  end if;

  execute v_definition;
end;
$patch$;

drop index if exists public.payroll_v2_items_prior_cutoff_ch_shortfall_source_key;
create unique index payroll_v2_items_prior_cutoff_ch_shortfall_period_key
  on public.payroll_v2_items (payroll_v2_record_id, source_id)
  where item_type = 'deduction'
    and source_type = 'payroll_v2_committed_hours_shortfall';

comment on index public.payroll_v2_items_prior_cutoff_ch_shortfall_period_key is
  'One aggregate derived prior-cutoff Committed Hours deduction per source period in a Payroll V2 employee record.';

-- Use a single clear readiness message for unavailable or incompatible paid
-- source data. Existing manual and attendance blocker behavior stays intact.
do $patch$
declare
  v_definition text;
  v_old text := 'A prior-cutoff Committed Hours deduction cannot be priced because its paid source rate is unavailable.';
  v_new text := 'A prior-cutoff Committed Hours deduction cannot be safely priced from its paid source data.';
begin
  v_definition := pg_catalog.replace(
    pg_catalog.pg_get_functiondef('public.payroll_v2_employee_calculation_payload(uuid, uuid)'::regprocedure),
    chr(13),
    ''
  );

  if pg_catalog.strpos(v_definition, v_old) = 0 then
    raise exception 'Payroll V2 shortfall readiness message changed; aggregate-line patch aborted.';
  end if;

  execute pg_catalog.replace(v_definition, v_old, v_new);
end;
$patch$;

;
