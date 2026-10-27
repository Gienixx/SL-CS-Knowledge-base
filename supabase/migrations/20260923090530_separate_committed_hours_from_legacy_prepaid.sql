-- Keep new Committed Hours targets in their own model. Legacy payroll_prepaid_hours
-- rows and their FIFO reconciliation remain historical and are not rewritten.

do $patch$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.payroll_get_expected_prepaid_commitment_candidates(uuid)'::regprocedure
  ) into v_definition;

  v_old := '    coalesce(balance.remaining_minutes, 0),';
  v_new := $replacement$
    case when target.id is null then 0 else greatest(
      target.expected_minutes - coalesce((
        select sum(case
          when public.payroll_expected_commitment_day_type(profile.user_id, dates.work_date::date) = 'rest_day'
            then greatest(readiness.rest_day_overtime_minutes, 0)
          else greatest(readiness.regular_minutes, 0)
        end)::integer
        from public.workforce_attendance_payroll_readiness readiness
        where readiness.user_id = profile.user_id
          and readiness.work_date = dates.work_date
          and readiness.is_payroll_ready
          and readiness.review_status in ('approved', 'locked')
      ), 0),
      0
    ) end::integer,
$replacement$;
  if pg_catalog.strpos(v_definition, v_old) = 0 then
    raise exception 'Expected Committed Hours candidate balance marker was not found.';
  end if;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);

  v_old := '  left join public.payroll_prepaid_hours balance' || pg_catalog.chr(10) ||
    '    on balance.commitment_id = target.id and balance.voided_at is null' || pg_catalog.chr(10);
  if pg_catalog.strpos(v_definition, v_old) = 0 then
    raise exception 'Expected compatibility-balance join was not found in Committed Hours reader.';
  end if;
  v_definition := pg_catalog.replace(v_definition, v_old, '');
  if pg_catalog.strpos(v_definition, 'payroll_prepaid_hours') > 0 then
    raise exception 'Committed Hours candidate reader still references legacy prepaid.';
  end if;
  execute v_definition;
end;
$patch$;

do $patch$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.payroll_save_expected_prepaid_commitment(uuid,uuid,date,integer,text)'::regprocedure
  ) into v_definition;

  v_old := $old$
  if v_old.id is not null then
    select coalesce(sum(allocation.allocated_minutes), 0)::integer into v_prior_settled
    from public.payroll_prepaid_commitments c
    join public.payroll_prepaid_hours prepaid on prepaid.commitment_id = c.id
    join public.payroll_hour_allocations allocation
      on allocation.prepaid_hour_id = prepaid.id
     and allocation.employee_id = prepaid.employee_id
     and allocation.allocation_type = 'settlement'
     and not exists (
       select 1
       from public.payroll_hour_allocations reversal
       where reversal.reverses_allocation_id = allocation.id
     )
    where c.payroll_period_id = p_payroll_period_id and c.employee_id = p_employee_id
      and c.work_date = p_work_date and c.prepaid_day_type = v_day_type;
    if v_old.root_commitment_id is null then
      v_root_baseline := v_old.payroll_ready_minutes_at_creation;
    else
      select coalesce(root.payroll_ready_minutes_at_creation, v_old.payroll_ready_minutes_at_creation)
      into v_root_baseline
      from public.payroll_prepaid_commitments root
      where root.id = coalesce(v_old.root_commitment_id, v_old.id);
    end if;
    v_version := v_old.commitment_version + 1;
  else
    v_root_baseline := v_ready;
  end if;
$old$;
  v_new := $new$
  if v_old.id is not null then
    v_version := v_old.commitment_version + 1;
  end if;
$new$;
  if pg_catalog.strpos(v_definition, v_old) = 0 then
    raise exception 'Expected Committed Hours settlement-history block was not found.';
  end if;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);

  v_old := '  v_replacement := greatest(p_expected_minutes - coalesce(v_root_baseline, v_ready) - v_prior_settled, 0);';
  v_new := '  v_replacement := v_coverage;';
  if pg_catalog.strpos(v_definition, v_old) = 0 then
    raise exception 'Expected Committed Hours replacement coverage formula was not found.';
  end if;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);

  v_old := $old$
  if v_old.id is not null then
    update public.payroll_prepaid_hours old_balance
    set voided_at = statement_timestamp(), voided_by = v_actor,
        void_reason = 'Replaced by expected Committed Hours target version ' || v_version::text || '.',
        superseded_by_id = v_balance_id
    where old_balance.commitment_id = v_old.id and old_balance.voided_at is null;
  end if;

  if v_replacement > 0 then
    insert into public.payroll_prepaid_hours (
      source_payroll_record_id, source_schedule_snapshot_id, commitment_id,
      employee_id, prepaid_minutes, settled_minutes, created_by, created_at, updated_at
    ) values (
      v_record.id, null, v_commitment_id, p_employee_id, v_replacement,
      0, v_actor, statement_timestamp(), statement_timestamp()
    ) returning id into v_balance_id;

    if v_old.id is not null then
      update public.payroll_prepaid_hours old_balance
      set superseded_by_id = v_balance_id
      where old_balance.commitment_id = v_old.id and old_balance.voided_at is not null
        and old_balance.superseded_by_id is null;
    end if;
  end if;

$old$;
  if pg_catalog.strpos(v_definition, v_old) = 0 then
    raise exception 'Expected Committed Hours compatibility-balance writer was not found.';
  end if;
  v_definition := pg_catalog.replace(v_definition, v_old, '');

  v_definition := pg_catalog.replace(v_definition,
    '  v_prior_settled integer := 0;' || pg_catalog.chr(10) ||
    '  v_root_baseline integer;' || pg_catalog.chr(10), '');
  v_old := '      ''supersedes_commitment_id'', v_old.id, ''prior_settled_minutes'', v_prior_settled,' || pg_catalog.chr(10);
  v_new := '      ''supersedes_commitment_id'', v_old.id,' || pg_catalog.chr(10);
  if pg_catalog.strpos(v_definition, v_old) = 0 then
    raise exception 'Expected settlement-history audit field was not found.';
  end if;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  v_definition := pg_catalog.replace(v_definition,
    '      ''rendered_minutes_used_as_baseline'', false, ''balance_id'', v_balance_id' || pg_catalog.chr(10),
    '      ''rendered_minutes_used_as_baseline'', false' || pg_catalog.chr(10));
  v_definition := pg_catalog.replace(v_definition,
    '    ''replacement_coverage_minutes'', v_replacement, ''prepaid_hour_id'', v_balance_id,' || pg_catalog.chr(10),
    '    ''replacement_coverage_minutes'', v_replacement,' || pg_catalog.chr(10));
  v_definition := pg_catalog.replace(v_definition, '  v_balance_id uuid;' || pg_catalog.chr(10), '');

  if pg_catalog.strpos(pg_catalog.lower(v_definition), 'insert into public.payroll_prepaid_hours') > 0
     or pg_catalog.strpos(pg_catalog.lower(v_definition), 'join public.payroll_prepaid_hours') > 0
     or pg_catalog.strpos(pg_catalog.lower(v_definition), 'update public.payroll_prepaid_hours') > 0
     or pg_catalog.strpos(v_definition, 'v_prior_settled') > 0
     or pg_catalog.strpos(v_definition, 'v_root_baseline') > 0 then
    raise exception 'Committed Hours save RPC still references legacy prepaid rows.';
  end if;
  execute v_definition;
end;
$patch$;

-- Recalculate the Committed Hours earning directly from the commitment target
-- and approved/payroll-ready attendance. Keep the generated-item cleanup and
-- all legacy prepaid calculation paths intact.
create or replace function public.payroll_insert_expected_commitment_earnings(
  p_payroll_record_id uuid,
  p_actor uuid,
  p_money_scale integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  delete from public.payroll_items
  where payroll_record_id = p_payroll_record_id
    and not is_manual
    and metadata ->> 'display_only_target_reference' = 'true'
    and metadata ? 'commitment_id';

  insert into public.payroll_items (
    payroll_record_id, item_type, item_code, description, quantity,
    unit_rate, amount, rate_id, work_date, calculation_version,
    metadata, is_manual, created_by, created_at
  )
  select
    record.id, 'earning', 'regular_earnings',
    'Committed Hours included in payroll',
    coverage.remaining_minutes::numeric / 60,
    rate.hourly_rate,
    round(coverage.remaining_minutes::numeric / 60 * rate.hourly_rate, p_money_scale),
    rate.id, commitment.work_date, record.calculation_version,
    jsonb_build_object(
      'commitment_id', commitment.id,
      'expected_minutes', commitment.expected_minutes,
      'payroll_ready_minutes_at_creation', commitment.payroll_ready_minutes_at_creation,
      'payroll_ready_minutes', readiness.payroll_ready_minutes,
      'coverage_minutes', greatest(commitment.expected_minutes - readiness.payroll_ready_minutes, 0),
      'remaining_minutes', coverage.remaining_minutes,
      'prepaid_day_type', commitment.prepaid_day_type,
      'display_only_target_reference', true
    ), false, p_actor, statement_timestamp()
  from public.payroll_records record
  join public.payroll_prepaid_commitments commitment
    on commitment.payroll_record_id = record.id and commitment.employee_id = record.employee_id
   and commitment.superseded_at is null
  left join lateral (
    select coalesce(sum(case
      when commitment.prepaid_day_type = 'rest_day' then greatest(r.rest_day_overtime_minutes, 0)
      else greatest(r.regular_minutes, 0)
    end), 0)::integer as payroll_ready_minutes
    from public.workforce_attendance_payroll_readiness r
    where r.user_id = commitment.employee_id
      and r.work_date = commitment.work_date
      and r.is_payroll_ready
      and r.review_status in ('approved', 'locked')
  ) readiness on true
  cross join lateral (
    select greatest(commitment.expected_minutes - readiness.payroll_ready_minutes, 0)::integer as remaining_minutes
  ) coverage
  join lateral (
    select r.* from public.agent_rates r
    where r.employee_id = record.employee_id and r.effective_date <= commitment.work_date
    order by r.effective_date desc limit 1
  ) rate on true
  where (p_payroll_record_id is null or record.id = p_payroll_record_id)
    and record.status <> 'void'
    and coverage.remaining_minutes > 0;
end;
$function$;

-- Commitment fulfillment is now derived from approved/payroll-ready evidence
-- at read/calculation time. Do not create or mutate prepaid allocations for it.
drop trigger if exists payroll_attendance_snapshot_reconcile_expected_commitment
  on public.payroll_attendance_snapshots;

create or replace function public.payroll_reconcile_expected_commitment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  return new;
end;
$function$;

-- Keep the finalized payslip's historical prepaid summary separate. Add a
-- commitment-only view derived from payroll_prepaid_commitments and the stored
-- Committed Hours payroll item, never from prepaid_summary.
do $patch$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.payroll_get_payslip_preview(uuid)'::regprocedure
  ) into v_definition;

  v_old := '    ''earnings'', v_earnings,' || pg_catalog.chr(10) ||
    '    ''deductions'', v_deductions,';
  v_new := $replacement$
    'earnings', v_earnings,
    'committed_hours', coalesce((
      select jsonb_agg(jsonb_build_object(
        'commitment_id', commitment.id,
        'work_date', commitment.work_date,
        'expected_minutes', commitment.expected_minutes,
        'payroll_ready_minutes_at_creation', commitment.payroll_ready_minutes_at_creation,
        'payroll_ready_minutes', readiness.payroll_ready_minutes,
        'coverage_minutes', greatest(commitment.expected_minutes - readiness.payroll_ready_minutes, 0),
        'included_minutes', coalesce(round(item.quantity * 60)::integer, 0),
        'amount', coalesce(item.amount, 0),
        'prepaid_day_type', commitment.prepaid_day_type
      ) order by commitment.work_date, commitment.commitment_version)
      from public.payroll_prepaid_commitments commitment
      left join lateral (
        select coalesce(sum(case
          when commitment.prepaid_day_type = 'rest_day' then greatest(r.rest_day_overtime_minutes, 0)
          else greatest(r.regular_minutes, 0)
        end), 0)::integer as payroll_ready_minutes
        from public.workforce_attendance_payroll_readiness r
        where r.user_id = commitment.employee_id
          and r.work_date = commitment.work_date
          and r.is_payroll_ready
          and r.review_status in ('approved', 'locked')
      ) readiness on true
      left join lateral (
        select payroll_item.quantity, payroll_item.amount
        from public.payroll_items payroll_item
        where payroll_item.payroll_record_id = v_record.id
          and payroll_item.metadata ->> 'commitment_id' = commitment.id::text
          and payroll_item.metadata ->> 'display_only_target_reference' = 'true'
          and not payroll_item.is_manual
        order by payroll_item.created_at desc, payroll_item.id desc
        limit 1
      ) item on true
      where commitment.payroll_record_id = v_record.id
        and commitment.employee_id = v_record.employee_id
        and commitment.superseded_at is null
    ), '[]'::jsonb),
    'deductions', v_deductions,
$replacement$;
  if pg_catalog.strpos(v_definition, v_old) = 0 then
    raise exception 'Expected payslip earnings projection marker was not found.';
  end if;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  execute v_definition;
end;
$patch$;

;
