-- Controlled historical payroll-period retirement.
--
-- A voided period remains queryable and keeps every financial/provenance
-- child row. The existing overlap gate already excludes status = 'void'.

begin;

create or replace function public.payroll_void_period(
  p_payroll_period_id uuid,
  p_void_reason text,
  p_replacement_period_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_user_id uuid := public.workforce_current_profile_id();
  v_period public.payroll_periods%rowtype;
  v_reason text := trim(coalesce(p_void_reason, ''));
  v_voided_at timestamptz := statement_timestamp();
  v_record_count bigint;
  v_item_count bigint;
  v_attendance_snapshot_count bigint;
  v_schedule_snapshot_count bigint;
  v_gross_pay numeric(14,2);
  v_net_pay numeric(14,2);
  v_total_deductions numeric(14,2);
  v_expected_records bigint;
  v_expected_items bigint;
  v_expected_attendance_snapshots bigint;
  v_expected_schedule_snapshots bigint;
  v_expected_gross numeric(14,2);
  v_expected_net numeric(14,2);
  v_expected_deductions numeric(14,2);
begin
  if auth.uid() is null
     or v_actor_user_id is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_has_permission('reopen_payroll') then
    raise exception
      using errcode = '42501',
        message = 'You do not have permission to retire payroll periods.';
  end if;

  if p_payroll_period_id is null then
    raise exception using errcode = '22023', message = 'Payroll period is required.';
  end if;

  if length(v_reason) < 5 or length(v_reason) > 2000 then
    raise exception
      using errcode = '22023',
        message = 'Retiring a payroll period requires a reason between 5 and 2,000 characters.';
  end if;

  -- Coordinate retirement with both period creation and other lifecycle
  -- operations. This prevents a create/void race around the overlap gate.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('public.payroll_periods:create', 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.payroll_lifecycle:' || p_payroll_period_id::text,
      0
    )
  );

  select period.*
  into v_period
  from public.payroll_periods period
  where period.id = p_payroll_period_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Payroll period was not found.';
  end if;

  if v_period.status = 'void' then
    raise exception using errcode = '55000', message = 'Payroll period is already voided.';
  end if;

  if v_period.status not in ('finalized', 'reopened') then
    raise exception
      using errcode = '55000',
        message = 'Only finalized or evidence-checked reopened payroll can be retired.';
  end if;

  if p_replacement_period_id is not null
     and not exists (
       select 1
       from public.payroll_periods replacement
       where replacement.id = p_replacement_period_id
     ) then
    raise exception using errcode = '22023', message = 'Replacement payroll period was not found.';
  end if;

  -- Reopened historical payroll is eligible only when the immutable
  -- finalization evidence still agrees with the current financial projection.
  -- This permits the known Aug 12–13 lifecycle state without silently
  -- restoring it to finalized and without recalculating anything.
  if v_period.status = 'reopened' then
    v_expected_records := nullif(v_period.finalization_evidence ->> 'record_count', '')::bigint;
    v_expected_items := nullif(v_period.finalization_evidence ->> 'payroll_item_count', '')::bigint;
    v_expected_attendance_snapshots := nullif(v_period.finalization_evidence ->> 'attendance_snapshot_count', '')::bigint;
    v_expected_schedule_snapshots := nullif(v_period.finalization_evidence ->> 'schedule_snapshot_count', '')::bigint;
    v_expected_gross := nullif(v_period.finalization_evidence ->> 'gross_pay', '')::numeric(14,2);
    v_expected_net := nullif(v_period.finalization_evidence ->> 'net_pay', '')::numeric(14,2);
    v_expected_deductions := nullif(v_period.finalization_evidence ->> 'total_deductions', '')::numeric(14,2);

    select
      count(*),
      coalesce(sum(record.gross_pay), 0)::numeric(14,2),
      coalesce(sum(record.net_pay), 0)::numeric(14,2),
      coalesce(sum(record.total_deductions), 0)::numeric(14,2)
    into v_record_count, v_gross_pay, v_net_pay, v_total_deductions
    from public.payroll_records record
    where record.payroll_period_id = v_period.id
      and record.status <> 'void';

    select count(*)
    into v_item_count
    from public.payroll_items item
    join public.payroll_records record on record.id = item.payroll_record_id
    where record.payroll_period_id = v_period.id;

    select count(*)
    into v_attendance_snapshot_count
    from public.payroll_attendance_snapshots snapshot
    join public.payroll_records record on record.id = snapshot.payroll_record_id
    where record.payroll_period_id = v_period.id;

    select count(*)
    into v_schedule_snapshot_count
    from public.payroll_schedule_snapshots snapshot
    join public.payroll_records record on record.id = snapshot.payroll_record_id
    where record.payroll_period_id = v_period.id;

    if jsonb_typeof(v_period.finalization_evidence) <> 'object'
       or v_expected_records is null
       or v_expected_items is null
       or v_expected_gross is null
       or v_expected_net is null
       or v_expected_deductions is null
       or v_expected_attendance_snapshots is null
       or v_expected_schedule_snapshots is null
       or v_expected_records <> v_record_count
       or v_expected_items <> v_item_count
       or v_expected_attendance_snapshots <> v_attendance_snapshot_count
       or v_expected_schedule_snapshots <> v_schedule_snapshot_count
       or v_expected_gross is distinct from v_gross_pay
       or v_expected_net is distinct from v_net_pay
       or v_expected_deductions is distinct from v_total_deductions
       or jsonb_array_length(coalesce(v_period.finalization_evidence -> 'calculation_records', '[]'::jsonb)) <> v_record_count
       or exists (
         select 1
         from public.payroll_records record
         where record.payroll_period_id = v_period.id
           and record.status <> 'void'
           and not exists (
             select 1
             from jsonb_array_elements(v_period.finalization_evidence -> 'calculation_records') evidence
             where evidence ->> 'payroll_record_id' = record.id::text
               and (evidence ->> 'gross_pay')::numeric is not distinct from record.gross_pay
               and (evidence ->> 'net_pay')::numeric is not distinct from record.net_pay
               and (evidence ->> 'total_deductions')::numeric is not distinct from record.total_deductions
               and (evidence ->> 'calculation_version')::integer is not distinct from record.calculation_version
           )
       ) then
      raise exception
        using errcode = '55000',
          message = 'Reopened payroll financial evidence no longer matches the finalized baseline; retirement is blocked.';
    end if;
  end if;

  -- The finalized-period guard is bypassed only inside this narrowly scoped
  -- SECURITY DEFINER transition. No child rows or financial fields are edited.
  perform pg_catalog.set_config('app.payroll_controlled_reopen', 'on', true);

  update public.payroll_periods
  set status = 'void', updated_at = v_voided_at
  where id = v_period.id;

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
  ) values (
    v_actor_user_id,
    'payroll_period_voided',
    'payroll_period',
    v_period.id,
    v_period.id,
    jsonb_build_object(
      'status', v_period.status,
      'period_start', v_period.period_start,
      'period_end', v_period.period_end,
      'payment_date', v_period.payment_date,
      'finalized_by', v_period.finalized_by,
      'finalized_at', v_period.finalized_at,
      'finalization_version', v_period.finalization_version,
      'gross_pay', coalesce(v_period.finalization_evidence ->> 'gross_pay', null),
      'net_pay', coalesce(v_period.finalization_evidence ->> 'net_pay', null)
    ),
    jsonb_build_object(
      'status', 'void',
      'voided_by', v_actor_user_id,
      'voided_at', v_voided_at,
      'period_start', v_period.period_start,
      'period_end', v_period.period_end,
      'replacement_period_id', p_replacement_period_id,
      'financial_rows_preserved', true
    ),
    v_reason,
    jsonb_build_object(
      'replacement_period_id', p_replacement_period_id,
      'previous_status', v_period.status,
      'finalization_evidence_preserved', true,
      'payroll_records_preserved', true,
      'payroll_items_preserved', true,
      'snapshots_preserved', true,
      'prepaid_and_allocations_preserved', true,
      'payslips_preserved', true
    )
  );

  return jsonb_build_object(
    'payroll_period_id', v_period.id,
    'status', 'void',
    'period_start', v_period.period_start,
    'period_end', v_period.period_end,
    'previous_status', v_period.status,
    'voided_at', v_voided_at,
    'replacement_period_id', p_replacement_period_id,
    'financial_rows_preserved', true
  );
end;
$function$;

revoke all on function public.payroll_void_period(uuid, text, uuid)
  from public, anon;
grant execute on function public.payroll_void_period(uuid, text, uuid)
  to authenticated, service_role;

comment on function public.payroll_void_period(uuid, text, uuid) is
  'Audited lifecycle-only retirement of finalized or evidence-checked reopened payroll. Preserves all financial and provenance rows and releases the period from active overlap checks.';

commit;

;
