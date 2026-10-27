-- Dedicated, service-only reconciliation for the confirmed valid Jerson
-- legacy attendance.  This function intentionally does not create snapshots,
-- allocations, reversals, or payroll items.  The normal importer remains the
-- only path that creates the v11 snapshot and lets the existing prepaid trigger
-- reverse/rebuild settlements.

begin;

create or replace function public.payroll_reconcile_jerson_legacy_aug18(
  p_payroll_period_id uuid,
  p_manifest jsonb,
  p_actor_user_id uuid,
  p_reason text,
  p_expected_attendance_fingerprint text,
  p_expected_snapshot_fingerprint text,
  p_expected_allocation_fingerprint text,
  p_expected_prepaid_fingerprint text,
  p_expected_period_snapshot_fingerprint text,
  p_expected_period_allocation_fingerprint text
)
returns table (
  attendance_id uuid,
  payroll_record_id uuid,
  previous_work_date date,
  new_work_date date,
  previous_total_worked_minutes integer,
  new_total_worked_minutes integer,
  previous_attendance_version bigint,
  new_attendance_version bigint,
  previous_snapshot_id uuid,
  previous_snapshot_version bigint,
  previous_allocation_count bigint,
  previous_allocation_minutes bigint,
  reconciliation_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period public.payroll_periods%rowtype;
  v_before public.attendance%rowtype;
  v_after public.attendance%rowtype;
  v_snapshot public.payroll_attendance_snapshots%rowtype;
  v_schedule public.work_schedules%rowtype;
  v_record public.payroll_records%rowtype;
  v_input record;
  v_manifest_count integer;
  v_canonical integer;
  v_snapshot_count bigint;
  v_allocation_count bigint;
  v_allocation_minutes bigint;
  v_unexpected_allocation_count bigint;
  v_prepaid_count bigint;
  v_prepaid_fingerprint text;
  v_attendance_fingerprint text;
  v_snapshot_fingerprint text;
  v_allocation_fingerprint text;
  v_period_snapshot_fingerprint text;
  v_period_allocation_fingerprint text;
  v_calculated_record_count bigint;
  v_item_count bigint;
  v_payslip_count bigint;
  v_readiness_blockers text[];
  v_previous_correction_recalculation text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501',
      message = 'This legacy reconciliation is service-role only.';
  end if;

  if p_payroll_period_id is distinct from
      'dd6c75b4-4eb1-4b77-9aa7-82a536eeb15f'::uuid then
    raise exception using errcode = '42501',
      message = 'This reconciliation is restricted to the Aug 16-31, 2026 payroll period.';
  end if;

  if p_actor_user_id is null
     or not exists (
       select 1
       from public.profiles as actor
       where actor.user_id = p_actor_user_id
         and actor.is_system_admin is true
         and actor.account_deleted_at is null
     ) then
    raise exception using errcode = '42501',
      message = 'A non-deleted system administrator actor is required.';
  end if;

  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception using errcode = '22023',
      message = 'A reconciliation reason is required.';
  end if;

  if nullif(trim(coalesce(p_expected_attendance_fingerprint, '')), '') is null
     or nullif(trim(coalesce(p_expected_snapshot_fingerprint, '')), '') is null
     or nullif(trim(coalesce(p_expected_allocation_fingerprint, '')), '') is null
     or nullif(trim(coalesce(p_expected_prepaid_fingerprint, '')), '') is null
     or nullif(trim(coalesce(p_expected_period_snapshot_fingerprint, '')), '') is null
     or nullif(trim(coalesce(p_expected_period_allocation_fingerprint, '')), '') is null then
    raise exception using errcode = '22023',
      message = 'All attendance, snapshot, allocation, prepaid, and period fingerprints are required.';
  end if;

  if p_manifest is null
     or jsonb_typeof(p_manifest) <> 'array'
     or jsonb_array_length(p_manifest) <> 1 then
    raise exception using errcode = '22023',
      message = 'Exactly one explicit legacy reconciliation row is required.';
  end if;

  select count(*)::integer
  into v_manifest_count
  from jsonb_to_recordset(p_manifest) as row_input(
    attendance_id uuid,
    expected_attendance_version bigint,
    expected_old_work_date date,
    expected_new_work_date date,
    expected_old_total_worked_minutes integer,
    expected_new_total_worked_minutes integer,
    expected_schedule_id uuid,
    expected_schedule_shift_date date,
    expected_schedule_version bigint,
    expected_captured_clock_in timestamptz,
    expected_captured_clock_out timestamptz,
    expected_billed_clock_in timestamptz,
    expected_billed_clock_out timestamptz,
    expected_regular_minutes integer,
    expected_pre_shift_overtime_minutes integer,
    expected_post_shift_overtime_minutes integer,
    expected_total_overtime_minutes integer,
    expected_snapshot_id uuid,
    expected_snapshot_version bigint,
    expected_allocation_count integer,
    expected_allocation_minutes bigint
  )
  where row_input.attendance_id =
    '9433080f-5b09-499b-9998-4dca6bfd0ceb'::uuid;

  if v_manifest_count <> 1 then
    raise exception using errcode = '42501',
      message = 'The manifest must be the exact approved Jerson legacy row.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.payroll_lifecycle:' || p_payroll_period_id::text, 0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.payroll_import_attendance:' || p_payroll_period_id::text, 0
    )
  );

  select period.*
  into v_period
  from public.payroll_periods as period
  where period.id = p_payroll_period_id
  for update;

  if not found or v_period.period_start is distinct from date '2026-08-16'
     or v_period.period_end is distinct from date '2026-08-31'
     or v_period.status <> 'draft'
     or v_period.finalization_version is distinct from 0 then
    raise exception using errcode = '55000',
      message = 'The target payroll period is not the expected draft at finalization version 0.';
  end if;

  select count(*)
  into v_calculated_record_count
  from public.payroll_records as record
  where record.payroll_period_id = v_period.id
    and (
      record.calculated_by is not null or record.calculated_at is not null
      or record.status in ('ready_for_review', 'approved', 'finalized')
      or record.reviewed_by is not null or record.reviewed_at is not null
      or record.finalized_at is not null
    );

  select count(*)
  into v_item_count
  from public.payroll_items as item
  join public.payroll_records as record on record.id = item.payroll_record_id
  where record.payroll_period_id = v_period.id;

  select count(*)
  into v_payslip_count
  from public.payslips as payslip
  join public.payroll_records as record on record.id = payslip.payroll_record_id
  where record.payroll_period_id = v_period.id;

  if v_calculated_record_count <> 0 or v_item_count <> 0 or v_payslip_count <> 0 then
    raise exception using errcode = '55000',
      message = 'Calculated records, payroll items, or payslips block reconciliation.';
  end if;

  -- Lock the full immutable period artifact set before comparing both the
  -- target fingerprints and the period-level fingerprints.
  perform 1
  from public.payroll_attendance_snapshots as snapshot
  join public.payroll_records as record on record.id = snapshot.payroll_record_id
  where record.payroll_period_id = v_period.id
  for update of snapshot;

  perform 1
  from public.payroll_hour_allocations as allocation
  join public.payroll_records as record
    on record.id = allocation.destination_payroll_record_id
  where record.payroll_period_id = v_period.id
  for update of allocation;

  perform 1
  from public.payroll_prepaid_hours as prepaid
  where exists (
    select 1
    from public.payroll_hour_allocations as allocation
    join public.payroll_records as record
      on record.id = allocation.destination_payroll_record_id
    where record.payroll_period_id = v_period.id
      and allocation.prepaid_hour_id = prepaid.id
  )
  for update of prepaid;

  select md5(coalesce(string_agg(to_jsonb(snapshot)::text, '|' order by snapshot.id), ''))
  into v_period_snapshot_fingerprint
  from public.payroll_attendance_snapshots as snapshot
  join public.payroll_records as record on record.id = snapshot.payroll_record_id
  where record.payroll_period_id = v_period.id;

  select md5(coalesce(string_agg(part.fingerprint_part, '|' order by part.fingerprint_part), ''))
  into v_period_allocation_fingerprint
  from (
    select 'allocation:' || to_jsonb(allocation)::text as fingerprint_part
    from public.payroll_hour_allocations as allocation
    join public.payroll_records as record
      on record.id = allocation.destination_payroll_record_id
    where record.payroll_period_id = v_period.id
    union all
    select distinct 'prepaid:' || to_jsonb(prepaid)::text as fingerprint_part
    from public.payroll_prepaid_hours as prepaid
    join public.payroll_hour_allocations as allocation
      on allocation.prepaid_hour_id = prepaid.id
    join public.payroll_records as record
      on record.id = allocation.destination_payroll_record_id
    where record.payroll_period_id = v_period.id
  ) as part;

  if v_period_snapshot_fingerprint <> trim(p_expected_period_snapshot_fingerprint)
     or v_period_allocation_fingerprint <> trim(p_expected_period_allocation_fingerprint) then
    raise exception using errcode = '40001',
      message = 'Period snapshot or allocation fingerprint changed since the dry run.';
  end if;

  select row_input.*
  into v_input
  from jsonb_to_recordset(p_manifest) as row_input(
    attendance_id uuid,
    expected_attendance_version bigint,
    expected_old_work_date date,
    expected_new_work_date date,
    expected_old_total_worked_minutes integer,
    expected_new_total_worked_minutes integer,
    expected_schedule_id uuid,
    expected_schedule_shift_date date,
    expected_schedule_version bigint,
    expected_captured_clock_in timestamptz,
    expected_captured_clock_out timestamptz,
    expected_billed_clock_in timestamptz,
    expected_billed_clock_out timestamptz,
    expected_regular_minutes integer,
    expected_pre_shift_overtime_minutes integer,
    expected_post_shift_overtime_minutes integer,
    expected_total_overtime_minutes integer,
    expected_snapshot_id uuid,
    expected_snapshot_version bigint,
    expected_allocation_count integer,
    expected_allocation_minutes bigint
  );

  select attendance_row.*
  into v_before
  from public.attendance as attendance_row
  where attendance_row.id = v_input.attendance_id
  for update;

  if not found or v_before.voided_at is not null or v_before.review_status = 'locked' then
    raise exception using errcode = '55000',
      message = 'The target attendance is missing, voided, or locked.';
  end if;

  v_attendance_fingerprint := md5(to_jsonb(v_before)::text);
  if v_attendance_fingerprint <> trim(p_expected_attendance_fingerprint) then
    raise exception using errcode = '40001',
      message = 'The target attendance fingerprint changed since the dry run.';
  end if;

  if v_before.user_id is distinct from 'b303c569-c808-409f-958e-7bc89868b07f'::uuid
     or v_before.attendance_version is distinct from 10
     or v_before.work_date is distinct from date '2026-08-19'
     or v_before.total_worked_minutes is distinct from 914
     or v_before.review_status <> 'approved'
     or v_before.payroll_approved_at is null
     or v_before.schedule_id is distinct from '6765f44b-dad4-4c31-9e83-c0e0daf6b191'::uuid
     or v_before.clock_in is distinct from v_input.expected_captured_clock_in
     or v_before.clock_out is distinct from v_input.expected_captured_clock_out
     or v_before.billed_clock_in is distinct from v_input.expected_billed_clock_in
     or v_before.billed_clock_out is distinct from v_input.expected_billed_clock_out
     or v_before.regular_minutes is distinct from 480
     or v_before.pre_shift_overtime_minutes is distinct from 240
     or v_before.post_shift_overtime_minutes is distinct from 180
     or v_before.total_overtime_minutes is distinct from 420
     or v_before.rest_day_overtime_minutes is distinct from 0
     or v_before.holiday_overtime_minutes is distinct from 0
     or v_before.overtime_minutes is distinct from 420 then
    raise exception using errcode = '40001',
      message = 'The target attendance no longer matches the exact legacy manifest.';
  end if;

  if v_input.expected_attendance_version is distinct from 10
     or v_input.expected_old_work_date is distinct from date '2026-08-19'
     or v_input.expected_new_work_date is distinct from date '2026-08-18'
     or v_input.expected_old_total_worked_minutes is distinct from 914
     or v_input.expected_new_total_worked_minutes is distinct from 900
     or v_input.expected_schedule_id is distinct from v_before.schedule_id
     or v_input.expected_schedule_shift_date is distinct from date '2026-08-18'
     or v_input.expected_schedule_version is distinct from 1
     or v_input.expected_regular_minutes is distinct from 480
     or v_input.expected_pre_shift_overtime_minutes is distinct from 240
     or v_input.expected_post_shift_overtime_minutes is distinct from 180
     or v_input.expected_total_overtime_minutes is distinct from 420
     or v_input.expected_snapshot_version is distinct from 10
     or v_input.expected_allocation_count is distinct from 4
     or v_input.expected_allocation_minutes is distinct from 900 then
    raise exception using errcode = '42501',
      message = 'The manifest values are not the exact approved legacy contract.';
  end if;

  select schedule.*
  into v_schedule
  from public.work_schedules as schedule
  where schedule.id = v_before.schedule_id
  for share;

  if not found
     or v_schedule.user_id is distinct from v_before.user_id
     or v_schedule.shift_date is distinct from date '2026-08-18'
     or v_schedule.schedule_version is distinct from 1
     or v_schedule.shift_start is distinct from timestamptz '2026-08-18 20:00:00+00'
     or v_schedule.shift_end is distinct from timestamptz '2026-08-19 04:00:00+00'
     or v_schedule.timezone is distinct from 'America/New_York'
     or v_schedule.status <> 'published'
     or v_schedule.is_rest_day
     or v_schedule.is_holiday
     or v_schedule.schedule_template_id is distinct from 'e9b426c2-fa38-4c15-84f7-5bda4821f964'::uuid
     or v_schedule.generated_by_automation is distinct from true
     or v_schedule.admin_override is distinct from false then
    raise exception using errcode = '55000',
      message = 'The target schedule provenance no longer matches the approved legacy contract.';
  end if;

  v_canonical := public.workforce_canonical_billed_minutes(
    v_before.billed_clock_in, v_before.billed_clock_out
  );
  if v_canonical is distinct from 900 then
    raise exception using errcode = '55000',
      message = 'The target billed duration is no longer canonically 900 minutes.';
  end if;

  select readiness.payroll_readiness_blockers
  into v_readiness_blockers
  from public.workforce_attendance_payroll_readiness as readiness
  where readiness.id = v_before.id;

  if not found or cardinality(v_readiness_blockers) <> 1
     or v_readiness_blockers[1] <> 'total_worked_mismatch' then
    raise exception using errcode = '55000',
      message = 'The target has a blocker beyond total_worked_mismatch.';
  end if;

  -- The target is a separate Aug 18-19 interval.  Any active same-user
  -- captured or billed overlap is a hard stop; no duplicate logic is bypassed.
  perform 1
  from public.attendance as other
  where other.id <> v_before.id
    and other.user_id = v_before.user_id
    and other.voided_at is null
    and (
      (other.clock_in is not null and other.clock_out is not null
       and v_before.clock_in < other.clock_out
       and v_before.clock_out > other.clock_in)
      or (other.billed_clock_in is not null and other.billed_clock_out is not null
       and v_before.billed_clock_in < other.billed_clock_out
       and v_before.billed_clock_out > other.billed_clock_in)
    )
  for update;

  if found then
    raise exception using errcode = '55000',
      message = 'The target overlaps another active attendance interval.';
  end if;

  if v_input.expected_snapshot_id is null
     or exists (
       select 1
       from public.payroll_attendance_snapshots as candidate
       where candidate.attendance_id = v_before.id
         and candidate.attendance_version = 11
     ) then
    raise exception using errcode = '55000',
      message = 'A replacement v11 snapshot already exists or the snapshot manifest is incomplete.';
  end if;

  select count(*)
  into v_snapshot_count
  from public.payroll_attendance_snapshots as candidate
  where candidate.attendance_id = v_before.id
    and candidate.attendance_version = v_before.attendance_version;

  if v_snapshot_count <> 1 then
    raise exception using errcode = '55000',
      message = 'The target must have exactly one current v10 snapshot.';
  end if;

  select snapshot.*
  into v_snapshot
  from public.payroll_attendance_snapshots as snapshot
  where snapshot.id = v_input.expected_snapshot_id
  for update;

  if not found
     or v_snapshot.attendance_id is distinct from v_before.id
     or v_snapshot.attendance_version is distinct from 10
     or v_snapshot.employee_id is distinct from v_before.user_id
     or v_snapshot.schedule_id is distinct from v_before.schedule_id
     or v_snapshot.work_date is distinct from date '2026-08-19'
     or v_snapshot.clock_in is distinct from v_before.billed_clock_in
     or v_snapshot.clock_out is distinct from v_before.billed_clock_out
     or v_snapshot.billed_clock_in is distinct from v_before.billed_clock_in
     or v_snapshot.billed_clock_out is distinct from v_before.billed_clock_out
     or v_snapshot.regular_minutes is distinct from 480
     or v_snapshot.pre_shift_overtime_minutes is distinct from 240
     or v_snapshot.post_shift_overtime_minutes is distinct from 180
     or v_snapshot.total_overtime_minutes is distinct from 420
     or v_snapshot.late_minutes is distinct from v_before.minutes_late
     or v_snapshot.undertime_minutes is distinct from v_before.undertime_minutes
     or v_snapshot.attendance_updated_at is distinct from v_before.updated_at then
    raise exception using errcode = '55000',
      message = 'The v10 snapshot does not match the exact canonical legacy content.';
  end if;

  v_snapshot_fingerprint := md5(to_jsonb(v_snapshot)::text);
  if v_snapshot_fingerprint <> trim(p_expected_snapshot_fingerprint) then
    raise exception using errcode = '40001',
      message = 'The target v10 snapshot fingerprint changed since the dry run.';
  end if;

  select record.*
  into v_record
  from public.payroll_records as record
  where record.id = v_snapshot.payroll_record_id
    and record.payroll_period_id = v_period.id
    and record.employee_id = v_before.user_id
    and record.status = 'draft'
  for update;

  if not found then
    raise exception using errcode = '55000',
      message = 'The target snapshot is not linked to one draft payroll record in the period.';
  end if;

  select count(*), coalesce(sum(allocation.allocated_minutes), 0),
    count(*) filter (where allocation.allocation_type <> 'settlement'
      or allocation.reverses_allocation_id is not null
      or exists (select 1 from public.payroll_hour_allocations as reversal
                 where reversal.reverses_allocation_id = allocation.id))
  into v_allocation_count, v_allocation_minutes, v_unexpected_allocation_count
  from public.payroll_hour_allocations as allocation
  where allocation.attendance_snapshot_id = v_snapshot.id;

  if v_allocation_count is distinct from 4
     or v_allocation_minutes is distinct from 900
     or v_unexpected_allocation_count <> 0 then
    raise exception using errcode = '55000',
      message = 'The target must have exactly four active settlement allocations totaling 900 minutes.';
  end if;

  select md5(coalesce(string_agg(to_jsonb(allocation)::text, '|' order by allocation.id), ''))
  into v_allocation_fingerprint
  from public.payroll_hour_allocations as allocation
  where allocation.attendance_snapshot_id = v_snapshot.id;

  if v_allocation_fingerprint <> trim(p_expected_allocation_fingerprint) then
    raise exception using errcode = '40001',
      message = 'The target allocation fingerprint changed since the dry run.';
  end if;

  select count(*), md5(coalesce(string_agg(to_jsonb(prepaid)::text, '|' order by prepaid.id), ''))
  into v_prepaid_count, v_prepaid_fingerprint
  from public.payroll_prepaid_hours as prepaid
  where prepaid.id in (
    select distinct allocation.prepaid_hour_id
    from public.payroll_hour_allocations as allocation
    where allocation.attendance_snapshot_id = v_snapshot.id
  );

  if v_prepaid_count <> 2 or v_prepaid_fingerprint <> trim(p_expected_prepaid_fingerprint) then
    raise exception using errcode = '40001',
      message = 'The target prepaid-source fingerprint changed since the dry run.';
  end if;

  v_previous_correction_recalculation := current_setting(
    'workforce.correction_recalculation', true
  );
  perform set_config('workforce.correction_recalculation', 'true', true);
  begin
    update public.attendance
    set work_date = date '2026-08-18',
        total_worked_minutes = 900
    where id = v_before.id
      and attendance_version = 10
      and work_date = date '2026-08-19'
      and total_worked_minutes = 914
    returning * into v_after;
  exception when others then
    perform set_config('workforce.correction_recalculation',
      coalesce(v_previous_correction_recalculation, 'false'), true);
    raise;
  end;
  perform set_config('workforce.correction_recalculation',
    coalesce(v_previous_correction_recalculation, 'false'), true);

  if not found
     or v_after.work_date is distinct from date '2026-08-18'
     or v_after.total_worked_minutes is distinct from 900
     or v_after.attendance_version is distinct from 11
     or (to_jsonb(v_after) - array['work_date', 'total_worked_minutes',
           'attendance_version', 'updated_at']) is distinct from
        (to_jsonb(v_before) - array['work_date', 'total_worked_minutes',
           'attendance_version', 'updated_at']) then
    raise exception using errcode = '55000',
      message = 'The legacy reconciliation changed an unauthorized attendance field.';
  end if;

  -- No immutable payroll artifact may change in this phase.  The importer is
  -- deliberately required to perform the v11 snapshot/settlement transition.
  select md5(coalesce(string_agg(to_jsonb(snapshot)::text, '|' order by snapshot.id), ''))
  into v_snapshot_fingerprint
  from public.payroll_attendance_snapshots as snapshot
  where snapshot.id = v_snapshot.id;

  select md5(coalesce(string_agg(to_jsonb(allocation)::text, '|' order by allocation.id), ''))
  into v_allocation_fingerprint
  from public.payroll_hour_allocations as allocation
  where allocation.attendance_snapshot_id = v_snapshot.id;

  if v_snapshot_fingerprint <> trim(p_expected_snapshot_fingerprint)
     or v_allocation_fingerprint <> trim(p_expected_allocation_fingerprint) then
    raise exception using errcode = '40001',
      message = 'Immutable snapshot or allocation content changed during legacy reconciliation.';
  end if;

  insert into public.payroll_audit_logs (
    actor_user_id, action, entity_type, entity_id, payroll_period_id,
    payroll_record_id, before_data, after_data, reason, metadata
  )
  values (
    p_actor_user_id,
    'payroll_jerson_legacy_work_date_total_reconciled',
    'attendance',
    v_after.id,
    v_period.id,
    v_record.id,
    jsonb_build_object(
      'attendance_id', v_before.id,
      'work_date', v_before.work_date,
      'total_worked_minutes', v_before.total_worked_minutes,
      'attendance_version', v_before.attendance_version,
      'snapshot_id', v_snapshot.id,
      'snapshot_version', v_snapshot.attendance_version,
      'allocation_count', v_allocation_count,
      'allocation_minutes', v_allocation_minutes
    ),
    jsonb_build_object(
      'attendance_id', v_after.id,
      'work_date', v_after.work_date,
      'total_worked_minutes', v_after.total_worked_minutes,
      'attendance_version', v_after.attendance_version,
      'snapshot_id', v_snapshot.id,
      'snapshot_version', v_snapshot.attendance_version,
      'allocation_count', v_allocation_count,
      'allocation_minutes', v_allocation_minutes,
      'payroll_reimport_required', true
    ),
    trim(p_reason),
    jsonb_build_object(
      'reconciliation_type', 'jerson_legacy_work_date_and_total_atomic',
      'expected_attendance_fingerprint', trim(p_expected_attendance_fingerprint),
      'expected_snapshot_fingerprint', trim(p_expected_snapshot_fingerprint),
      'expected_allocation_fingerprint', trim(p_expected_allocation_fingerprint),
      'expected_prepaid_fingerprint', trim(p_expected_prepaid_fingerprint),
      'period_snapshot_fingerprint', trim(p_expected_period_snapshot_fingerprint),
      'period_allocation_fingerprint', trim(p_expected_period_allocation_fingerprint),
      'only_attendance_fields_changed', jsonb_build_array(
        'work_date', 'total_worked_minutes', 'attendance_version', 'updated_at'
      ),
      'normal_import_required', true
    )
  );

  return query
  select v_after.id, v_record.id, v_before.work_date, v_after.work_date,
    v_before.total_worked_minutes, v_after.total_worked_minutes,
    v_before.attendance_version, v_after.attendance_version,
    v_snapshot.id, v_snapshot.attendance_version,
    v_allocation_count, v_allocation_minutes, 'reconciled'::text;
end;
$$;

alter function public.payroll_reconcile_jerson_legacy_aug18(
  uuid, jsonb, uuid, text, text, text, text, text, text, text
) owner to postgres;

revoke all on function public.payroll_reconcile_jerson_legacy_aug18(
  uuid, jsonb, uuid, text, text, text, text, text, text, text
) from public, anon, authenticated;

grant execute on function public.payroll_reconcile_jerson_legacy_aug18(
  uuid, jsonb, uuid, text, text, text, text, text, text, text
) to service_role;

comment on function public.payroll_reconcile_jerson_legacy_aug18(
  uuid, jsonb, uuid, text, text, text, text, text, text, text
) is
  'Service-only atomic repair for the confirmed Jerson legacy Aug 18 attendance: changes work_date Aug 19 to Aug 18 and total_worked_minutes 914 to canonical 900, increments attendance version once, preserves immutable v10 payroll artifacts, and requires normal v11 re-import.';

commit;

;
