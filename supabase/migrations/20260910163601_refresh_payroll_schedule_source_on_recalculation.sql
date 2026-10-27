-- Refresh schedule-backed payroll provenance from the current authoritative
-- schedule during recalculation. Historical prepaid source snapshots remain
-- immutable and continue to identify the original prepaid source.

create or replace function public.payroll_ensure_current_schedule_snapshot(
  p_payroll_record_id uuid,
  p_schedule_id uuid,
  p_employee_id uuid,
  p_actor_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_schedule public.work_schedules%rowtype;
  v_snapshot_id uuid;
  v_approved_by uuid;
begin
  select schedule.*
  into v_schedule
  from public.work_schedules as schedule
  where schedule.id = p_schedule_id
    and schedule.user_id = p_employee_id
  for share;

  if not found then
    raise exception
      using errcode = 'P0002',
        message = 'Current payroll source schedule was not found.';
  end if;

  if v_schedule.status not in ('published', 'changed', 'completed') then
    raise exception
      using errcode = '55000',
        message = 'Current payroll source schedule is not payable.';
  end if;

  select snapshot.id
  into v_snapshot_id
  from public.payroll_schedule_snapshots as snapshot
  where snapshot.payroll_record_id = p_payroll_record_id
    and snapshot.employee_id = p_employee_id
    and snapshot.schedule_id = v_schedule.id
    and snapshot.schedule_version = v_schedule.schedule_version
  order by snapshot.approved_at desc
  limit 1;

  if v_snapshot_id is not null then
    return v_snapshot_id;
  end if;

  select snapshot.approved_by
  into v_approved_by
  from public.payroll_schedule_snapshots as snapshot
  where snapshot.payroll_record_id = p_payroll_record_id
    and snapshot.employee_id = p_employee_id
    and snapshot.schedule_id = v_schedule.id
  order by snapshot.schedule_version desc, snapshot.approved_at desc
  limit 1;

  v_approved_by := coalesce(v_approved_by, p_actor_user_id);

  if v_approved_by is null then
    raise exception
      using errcode = '42501',
        message = 'Current payroll schedule provenance needs an approving actor.';
  end if;

  insert into public.payroll_schedule_snapshots (
    payroll_record_id,
    schedule_id,
    employee_id,
    work_date,
    shift_start,
    shift_end,
    timezone,
    schedule_status,
    is_rest_day,
    is_holiday,
    holiday_name,
    schedule_version,
    schedule_updated_at,
    approved_by,
    approved_at,
    approval_reason,
    source_type,
    source_metadata
  )
  values (
    p_payroll_record_id,
    v_schedule.id,
    p_employee_id,
    v_schedule.shift_date,
    v_schedule.shift_start,
    v_schedule.shift_end,
    v_schedule.timezone,
    v_schedule.status,
    v_schedule.is_rest_day,
    v_schedule.is_holiday,
    v_schedule.holiday_name,
    v_schedule.schedule_version,
    v_schedule.updated_at,
    v_approved_by,
    pg_catalog.now(),
    'Current authoritative schedule captured during payroll recalculation',
    'payroll_recalculation',
    jsonb_build_object(
      'source', 'current_work_schedule',
      'previous_snapshot_preserved', true
    )
  )
  on conflict (payroll_record_id, schedule_id, schedule_version) do nothing
  returning id into v_snapshot_id;

  if v_snapshot_id is null then
    select snapshot.id
    into v_snapshot_id
    from public.payroll_schedule_snapshots as snapshot
    where snapshot.payroll_record_id = p_payroll_record_id
      and snapshot.employee_id = p_employee_id
      and snapshot.schedule_id = v_schedule.id
      and snapshot.schedule_version = v_schedule.schedule_version
    order by snapshot.approved_at desc
    limit 1;
  end if;

  return v_snapshot_id;
end;
$function$;

revoke all on function public.payroll_ensure_current_schedule_snapshot(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_ensure_current_schedule_snapshot(uuid, uuid, uuid, uuid)
  to service_role;

do $patch$
declare
  v_definition text;
  v_old text := $old$
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
    'regular_earnings',
    'New prepaid hours included in Total Billed Hours',
    prepaid.prepaid_minutes::numeric / 60,
    rate.hourly_rate,
    round(
      prepaid.prepaid_minutes::numeric / 60 * rate.hourly_rate,
      v_money_scale
    ),
    rate.id,
    coalesce(prepaid.effective_work_date, snapshot.work_date),
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
      and effective_rate.effective_date <= coalesce(prepaid.effective_work_date, snapshot.work_date)
    order by effective_rate.effective_date desc
    limit 1
  ) as rate on true
  where record.payroll_period_id = v_period.id
    and (p_payroll_record_id is null or record.id = p_payroll_record_id)
    and record.status <> 'void'
    and coalesce(snapshot.source_metadata ->> 'historical_restore', 'false') <> 'true';
$old$;
  v_new text := $new$
  -- Approved pre-plotted schedules are paid in their source payroll period.
  -- The prepaid row remains tied to its historical source snapshot, while the
  -- payroll item is tied to an immutable snapshot of the current schedule.
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
    'regular_earnings',
    'New prepaid hours included in Total Billed Hours',
    prepaid.prepaid_minutes::numeric / 60,
    rate.hourly_rate,
    round(
      prepaid.prepaid_minutes::numeric / 60 * rate.hourly_rate,
      v_money_scale
    ),
    rate.id,
    coalesce(prepaid.effective_work_date, snapshot.work_date),
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
  join public.payroll_schedule_snapshots as source_snapshot
    on source_snapshot.id = prepaid.source_schedule_snapshot_id
  join lateral (
    select public.payroll_ensure_current_schedule_snapshot(
      record.id,
      source_snapshot.schedule_id,
      record.employee_id,
      v_actor_user_id
    ) as snapshot_id
  ) as refreshed on true
  join public.payroll_schedule_snapshots as snapshot
    on snapshot.id = refreshed.snapshot_id
  join lateral (
    select effective_rate.*
    from public.agent_rates as effective_rate
    where effective_rate.employee_id = record.employee_id
      and effective_rate.effective_date <= coalesce(prepaid.effective_work_date, snapshot.work_date)
    order by effective_rate.effective_date desc
    limit 1
  ) as rate on true
  where record.payroll_period_id = v_period.id
    and (p_payroll_record_id is null or record.id = p_payroll_record_id)
    and record.status <> 'void'
    and coalesce(snapshot.source_metadata ->> 'historical_restore', 'false') <> 'true';
$new$;
begin
  select pg_catalog.pg_get_functiondef(
    'public.payroll_calculate_draft_for_record(uuid,uuid)'::regprocedure
  ) into v_definition;

  if position(v_old in v_definition) = 0 then
    raise exception 'Expected prepaid payroll source block was not found.';
  end if;

  v_definition := replace(v_definition, v_old, v_new);
  execute v_definition;
end;
$patch$;

do $guard$
declare
  v_definition text;
  v_anchor text := $anchor$
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
$anchor$;
  v_guard text := $body$
  if exists (
    select 1
    from public.payroll_items as item
    join public.payroll_records as record
      on record.id = item.payroll_record_id
    join public.work_schedules as schedule
      on schedule.id = item.source_schedule_id
    where record.payroll_period_id = v_period.id
      and (p_payroll_record_id is null or record.id = p_payroll_record_id)
      and record.status <> 'void'
      and item.source_schedule_version is not null
      and item.source_schedule_version < schedule.schedule_version
  ) then
    raise exception
      using errcode = '55000',
        message = 'Payroll calculation left stale schedule provenance.';
  end if;

$body$;
begin
  select pg_catalog.pg_get_functiondef(
    'public.payroll_calculate_draft_for_record(uuid,uuid)'::regprocedure
  ) into v_definition;

  if position(v_anchor in v_definition) = 0 then
    raise exception 'Calculation completion anchor was not found.';
  end if;

  v_definition := replace(v_definition, v_anchor, v_guard || v_anchor);
  execute v_definition;
end;
$guard$;

comment on function public.payroll_ensure_current_schedule_snapshot(uuid, uuid, uuid, uuid) is
  'Creates or reuses an immutable current schedule snapshot for payroll recalculation without mutating historical prepaid snapshots.';

;
