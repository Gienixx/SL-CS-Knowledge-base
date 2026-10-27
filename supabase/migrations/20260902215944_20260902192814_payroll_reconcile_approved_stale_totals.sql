-- Payroll-aware, explicit-manifest reconciliation for the ordinary stale-total
-- cohort in the Aug 16-31, 2026 draft period.
--
-- This is deliberately separate from workforce_repair_approved_stale_total.
-- That existing RPC protects the artifact-free attendance-repair path and must
-- continue to reject rows that already have payroll snapshots or allocations.
-- This RPC only corrects the source derived total.  It never imports snapshots,
-- recalculates payroll, or writes allocations/prepaid balances.

begin;

create or replace function public.payroll_reconcile_approved_stale_totals(
  p_payroll_period_id uuid,
  p_rows jsonb,
  p_actor_user_id uuid,
  p_reason text,
  p_expected_snapshot_fingerprint text,
  p_expected_allocation_fingerprint text
)
returns table (
  attendance_id uuid,
  payroll_record_id uuid,
  previous_total_worked_minutes integer,
  canonical_billed_minutes integer,
  new_total_worked_minutes integer,
  previous_attendance_version bigint,
  new_attendance_version bigint,
  snapshot_id uuid,
  snapshot_version bigint,
  allocation_count bigint,
  allocation_minutes bigint,
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
  v_record public.payroll_records%rowtype;
  v_schedule public.work_schedules%rowtype;
  v_input record;
  v_ids uuid[];
  v_allowed_ids uuid[] := array[
    -- Cohort 1: 24 ordinary snapshot-backed rows without allocations.
    '8e960035-83de-4e92-8275-ccf3546e4e03'::uuid,
    'b7b1117e-a5b6-4728-a0da-a75be5123dcf'::uuid,
    '32e98a05-cada-4370-a5e0-8d8cc8d6fde5'::uuid,
    '87ed1069-31e2-4567-9ce4-61a179178fd0'::uuid,
    'cc1e2889-d4e7-4649-b60f-257f8457190d'::uuid,
    'ab8313c3-07e3-4afe-ad41-1fa2ba27237f'::uuid,
    '8f25ea5a-c20c-4d94-b7b4-16975ec3a99f'::uuid,
    'dcbbe176-a572-4618-993d-4a2cb27e568d'::uuid,
    '50aae86b-8499-488c-9166-739ef714f231'::uuid,
    'af43f7cd-3065-4e06-8ec0-997617bda486'::uuid,
    'cc7b0bba-fa47-434f-a6fe-56c6a45f1ffb'::uuid,
    '8dce09fb-01ab-4602-aba7-4183ab6fda0d'::uuid,
    '9e4c18b9-6548-4708-b7ee-e37e9ad8898d'::uuid,
    '2a4fe464-4586-40a8-8eff-c3cceb4abaee'::uuid,
    '4aeaf45a-6749-4797-b82d-5464d9e2a68f'::uuid,
    'fae2cbcb-d1a9-4239-a499-3144e7ebbd7e'::uuid,
    '875abc7b-aa59-46c3-a6e0-e62c448beba9'::uuid,
    'e0686ec0-a4c7-425c-9b14-4faed5cd14d1'::uuid,
    '8359e13c-e6a9-4bb6-a921-f6b3b11c1f12'::uuid,
    'edf1742f-ca08-4922-8a5d-94ad228deef4'::uuid,
    '768886c8-03d9-4056-b1d8-014231ce23be'::uuid,
    'dc9ab1fa-dae4-41b3-939e-279ab111c213'::uuid,
    'b6cc6b2a-1347-4a68-aa1c-94018d740085'::uuid,
    '358eeefc-b74a-4756-b340-87a123267583'::uuid,
    -- Cohort 2: 15 ordinary snapshot-backed rows with allocations.
    '1e770981-0beb-4c16-bb5e-d031e17a4b5e'::uuid,
    '3acdc22e-86e3-4eb2-94e0-4e45dd37eb05'::uuid,
    'b34b4b32-705e-4c2c-a86c-4705d4c91ef4'::uuid,
    'f7d01b36-ed4e-41f1-894f-a9e439d23961'::uuid,
    'ab8f8769-689f-441f-847d-ea4f58b3ddc4'::uuid,
    'c3b1c110-beec-42d2-bba4-8423d803ca42'::uuid,
    '69d3b481-4624-42f9-b208-7393c82f24d4'::uuid,
    '7540e1cb-5b1f-4e0d-8a9a-41cf47e9a50e'::uuid,
    '989f8ce4-184e-4611-ac96-450f9503ede6'::uuid,
    '4fbf0753-6121-4761-9e34-95324a03e0cb'::uuid,
    'ad3187e6-cdcc-4b93-94b9-90023103b093'::uuid,
    '4b3d2c89-4030-4717-b8e5-17c6bbbcb65a'::uuid,
    'c228c6f5-1813-40cf-849d-ec1c0cf1e46c'::uuid,
    '0b622ed9-9c4c-4581-953a-778972097f57'::uuid,
    'f8376c9f-9919-4d85-867e-1506730233f2'::uuid
  ];
  v_row_count integer;
  v_distinct_row_count integer;
  v_calculated_record_count bigint;
  v_item_count bigint;
  v_payslip_count bigint;
  v_before_snapshot_fingerprint text;
  v_before_allocation_fingerprint text;
  v_after_snapshot_fingerprint text;
  v_after_allocation_fingerprint text;
  v_canonical integer;
  v_readiness_blockers text[];
  v_snapshot_coverage_count bigint;
  v_allocation_count bigint;
  v_allocation_minutes bigint;
  v_unexpected_allocation_count bigint;
  v_duplicate_attendance boolean;
  v_previous_correction_recalculation text;
begin
  if p_payroll_period_id is distinct from
      'dd6c75b4-4eb1-4b77-9aa7-82a536eeb15f'::uuid then
    raise exception using
      errcode = '42501',
      message = 'This controlled reconciliation is restricted to the Aug 16-31, 2026 payroll period.';
  end if;

  if p_actor_user_id is null
     or not exists (
       select 1
       from public.profiles as actor
       where actor.user_id = p_actor_user_id
         and actor.is_system_admin is true
         and actor.account_deleted_at is null
     ) then
    raise exception using
      errcode = '42501',
      message = 'A non-deleted system administrator actor is required.';
  end if;

  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception using
      errcode = '22023',
      message = 'A reconciliation reason is required.';
  end if;

  if nullif(trim(coalesce(p_expected_snapshot_fingerprint, '')), '') is null
     or nullif(trim(coalesce(p_expected_allocation_fingerprint, '')), '') is null then
    raise exception using
      errcode = '22023',
      message = 'Expected snapshot and allocation fingerprints are required.';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) = 0 then
    raise exception using
      errcode = '22023',
      message = 'An explicit, non-empty reconciliation row manifest is required.';
  end if;

  select
    count(*)::integer,
    count(distinct row_input.attendance_id)::integer,
    array_agg(row_input.attendance_id order by row_input.attendance_id)
  into v_row_count, v_distinct_row_count, v_ids
  from jsonb_to_recordset(p_rows) as row_input(
    attendance_id uuid,
    expected_attendance_version bigint,
    expected_old_total_worked_minutes integer,
    expected_canonical_minutes integer,
    expected_snapshot_id uuid,
    expected_snapshot_version bigint,
    expected_allocation_count integer,
    expected_allocation_minutes bigint
  );

  if v_row_count <> jsonb_array_length(p_rows)
     or v_distinct_row_count <> v_row_count
     or v_row_count > cardinality(v_allowed_ids) then
    raise exception using
      errcode = '22023',
      message = 'The manifest must contain distinct, explicitly allowlisted attendance IDs.';
  end if;

  -- The importer uses this same period key.  The lifecycle key also prevents
  -- period normalization/reopen operations from racing this reconciliation.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.payroll_lifecycle:' || p_payroll_period_id::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.payroll_import_attendance:' || p_payroll_period_id::text,
      0
    )
  );

  select period.*
  into v_period
  from public.payroll_periods as period
  where period.id = p_payroll_period_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Payroll period was not found.';
  end if;

  if v_period.period_start is distinct from date '2026-08-16'
     or v_period.period_end is distinct from date '2026-08-31' then
    raise exception using
      errcode = '55000',
      message = 'The target payroll period dates are not the approved Aug 16-31, 2026 scope.';
  end if;

  if v_period.status <> 'draft' then
    raise exception using
      errcode = '55000',
      message = 'Only a draft payroll period can be reconciled.';
  end if;

  if v_period.finalization_version is distinct from 0 then
    raise exception using
      errcode = '40001',
      message = 'The payroll period finalization version is stale or already advanced.';
  end if;

  select count(*)
  into v_calculated_record_count
  from public.payroll_records as record
  where record.payroll_period_id = v_period.id
    and (
      record.calculated_by is not null
      or record.calculated_at is not null
      or record.status in ('ready_for_review', 'approved', 'finalized')
      or record.reviewed_by is not null
      or record.reviewed_at is not null
      or record.finalized_at is not null
    );

  if v_calculated_record_count > 0 then
    raise exception using
      errcode = '55000',
      message = 'Calculated, reviewed, approved, or finalized payroll records block reconciliation.';
  end if;

  select count(*)
  into v_item_count
  from public.payroll_items as item
  join public.payroll_records as record
    on record.id = item.payroll_record_id
  where record.payroll_period_id = v_period.id;

  if v_item_count > 0 then
    raise exception using
      errcode = '55000',
      message = 'Payroll items block reconciliation.';
  end if;

  select count(*)
  into v_payslip_count
  from public.payslips as payslip
  join public.payroll_records as record
    on record.id = payslip.payroll_record_id
  where record.payroll_period_id = v_period.id;

  if v_payslip_count > 0 then
    raise exception using
      errcode = '55000',
      message = 'Payslips block reconciliation.';
  end if;

  -- Lock all immutable payroll inputs participating in the target period while
  -- the expected fingerprints and per-row contracts are checked.
  perform 1
  from public.payroll_attendance_snapshots as snapshot
  join public.payroll_records as record
    on record.id = snapshot.payroll_record_id
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

  -- Fingerprints are intentionally computed from immutable row contents.  The
  -- allocation fingerprint includes every allocation and every prepaid source
  -- that participates in a destination row in this period.
  select md5(coalesce(string_agg(to_jsonb(snapshot)::text, '|' order by snapshot.id), ''))
  into v_before_snapshot_fingerprint
  from public.payroll_attendance_snapshots as snapshot
  join public.payroll_records as record
    on record.id = snapshot.payroll_record_id
  where record.payroll_period_id = v_period.id;

  select md5(coalesce(string_agg(part.fingerprint_part, '|' order by part.fingerprint_part), ''))
  into v_before_allocation_fingerprint
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

  if v_before_snapshot_fingerprint <> trim(p_expected_snapshot_fingerprint)
     or v_before_allocation_fingerprint <> trim(p_expected_allocation_fingerprint) then
    raise exception using
      errcode = '40001',
      message = 'Snapshot or allocation fingerprint changed since the dry run.';
  end if;

  for v_input in
    select row_input.*
    from jsonb_to_recordset(p_rows) as row_input(
      attendance_id uuid,
      expected_attendance_version bigint,
      expected_old_total_worked_minutes integer,
      expected_canonical_minutes integer,
      expected_snapshot_id uuid,
      expected_snapshot_version bigint,
      expected_allocation_count integer,
      expected_allocation_minutes bigint
    )
    order by row_input.attendance_id
  loop
    if v_input.attendance_id is null
       or not (v_input.attendance_id = any(v_allowed_ids)) then
      raise exception using
        errcode = '42501',
        message = format('Attendance ID %s is not in the approved ordinary reconciliation allowlist.', coalesce(v_input.attendance_id::text, '<null>'));
    end if;

    if v_input.expected_attendance_version is null
       or v_input.expected_attendance_version <= 0
       or v_input.expected_old_total_worked_minutes is null
       or v_input.expected_canonical_minutes is null
       or v_input.expected_canonical_minutes < 0
       or v_input.expected_snapshot_id is null
       or v_input.expected_snapshot_version is null
       or v_input.expected_snapshot_version <= 0
       or v_input.expected_allocation_count is null
       or v_input.expected_allocation_count < 0
       or v_input.expected_allocation_minutes is null
       or v_input.expected_allocation_minutes < 0 then
      raise exception using
        errcode = '22023',
        message = format('Attendance ID %s has incomplete or invalid expected values.', v_input.attendance_id);
    end if;

    select attendance_row.*
    into v_before
    from public.attendance as attendance_row
    where attendance_row.id = v_input.attendance_id
    for update;

    if not found then
      raise exception 'Attendance record % was not found.', v_input.attendance_id;
    end if;

    if v_before.voided_at is not null then
      raise exception 'Attendance record % is voided.', v_input.attendance_id;
    end if;

    if v_before.review_status = 'locked' then
      raise exception using
        errcode = '55000',
        message = format('Locked attendance record %s cannot be changed.', v_input.attendance_id);
    end if;

    if v_before.review_status <> 'approved'
       or v_before.payroll_approved_at is null then
      raise exception using
        errcode = '55000',
        message = format('Attendance record %s is not currently payroll-approved.', v_input.attendance_id);
    end if;

    if v_before.attendance_version is distinct from v_input.expected_attendance_version
       or v_before.total_worked_minutes is distinct from v_input.expected_old_total_worked_minutes then
      raise exception using
        errcode = '40001',
        message = format('Attendance record %s no longer matches the expected version or old total.', v_input.attendance_id);
    end if;

    if v_before.billed_clock_in is null
       or v_before.billed_clock_out is null
       or v_before.billed_clock_out < v_before.billed_clock_in then
      raise exception 'Attendance record % does not have valid complete billed timestamps.', v_input.attendance_id;
    end if;

    v_canonical := public.workforce_canonical_billed_minutes(
      v_before.billed_clock_in,
      v_before.billed_clock_out
    );

    if v_canonical is null
       or v_canonical is distinct from v_input.expected_canonical_minutes then
      raise exception using
        errcode = '40001',
        message = format('Attendance record %s no longer matches the expected canonical billed minutes.', v_input.attendance_id);
    end if;

    if v_before.pre_shift_overtime_minutes is null
       or v_before.regular_minutes is null
       or v_before.post_shift_overtime_minutes is null
       or v_before.total_overtime_minutes is null
       or v_before.rest_day_overtime_minutes is null
       or v_before.holiday_overtime_minutes is null
       or v_before.overtime_minutes is null
       or v_before.regular_minutes + v_before.pre_shift_overtime_minutes
            + v_before.post_shift_overtime_minutes is distinct from v_canonical
       or v_before.regular_minutes + v_before.total_overtime_minutes
            is distinct from v_canonical
       or v_before.total_overtime_minutes is distinct from (
            v_before.pre_shift_overtime_minutes
            + v_before.post_shift_overtime_minutes
            + v_before.rest_day_overtime_minutes
            + v_before.holiday_overtime_minutes
          )
       or v_before.overtime_minutes is distinct from v_before.total_overtime_minutes
       or v_before.rest_day_overtime_minutes <> 0
       or v_before.holiday_overtime_minutes <> 0 then
      raise exception using
        errcode = '55000',
        message = format('Attendance record %s is not an ordinary total-only reconciliation candidate.', v_input.attendance_id);
    end if;

    select schedule.*
    into v_schedule
    from public.work_schedules as schedule
    where schedule.id = v_before.schedule_id
    for share;

    if not found
       or v_schedule.user_id is distinct from v_before.user_id
       or v_schedule.shift_date is distinct from v_before.work_date
       or v_schedule.is_rest_day
       or v_schedule.is_holiday then
      raise exception using
        errcode = '55000',
        message = format('Attendance record %s has a non-ordinary or invalid schedule classification.', v_input.attendance_id);
    end if;

    select readiness.payroll_readiness_blockers
    into v_readiness_blockers
    from public.workforce_attendance_payroll_readiness as readiness
    where readiness.id = v_before.id;

    if not found
       or cardinality(v_readiness_blockers) <> 1
       or v_readiness_blockers[1] <> 'total_worked_mismatch' then
      raise exception using
        errcode = '55000',
        message = format('Attendance record %s has a blocker beyond total_worked_mismatch.', v_input.attendance_id);
    end if;

    select exists (
      select 1
      from public.attendance as other
      where other.id <> v_before.id
        and other.user_id = v_before.user_id
        and other.work_date = v_before.work_date
        and other.voided_at is null
        and (
          (
            other.clock_in is not null
            and other.clock_out is not null
            and v_before.clock_in is not null
            and v_before.clock_out is not null
            and v_before.clock_in < other.clock_out
            and v_before.clock_out > other.clock_in
          )
          or (
            other.billed_clock_in is not null
            and other.billed_clock_out is not null
            and v_before.billed_clock_in < other.billed_clock_out
            and v_before.billed_clock_out > other.billed_clock_in
          )
          or (
            other.clock_in is not distinct from v_before.clock_in
            and other.clock_out is not distinct from v_before.clock_out
          )
          or (
            other.billed_clock_in is not distinct from v_before.billed_clock_in
            and other.billed_clock_out is not distinct from v_before.billed_clock_out
          )
        )
    )
    into v_duplicate_attendance;

    if v_duplicate_attendance then
      raise exception 'Attendance record % has a duplicate or overlapping attendance record.', v_input.attendance_id;
    end if;

    select count(*)
    into v_snapshot_coverage_count
    from public.payroll_attendance_snapshots as snapshot
    where snapshot.attendance_id = v_before.id
      and snapshot.attendance_version = v_before.attendance_version;

    if v_snapshot_coverage_count <> 1 then
      raise exception using
        errcode = '55000',
        message = format('Attendance record %s does not have exactly one current snapshot coverage row.', v_input.attendance_id);
    end if;

    select snapshot.*
    into v_snapshot
    from public.payroll_attendance_snapshots as snapshot
    where snapshot.id = v_input.expected_snapshot_id
    for update;

    if not found
       or v_snapshot.payroll_record_id is null
       or v_snapshot.attendance_id is distinct from v_before.id
       or v_snapshot.attendance_version is distinct from v_before.attendance_version
       or v_snapshot.attendance_version is distinct from v_input.expected_snapshot_version
       or v_snapshot.employee_id is distinct from v_before.user_id
       or v_snapshot.schedule_id is distinct from v_before.schedule_id
       or v_snapshot.work_date is distinct from v_before.work_date
       or v_snapshot.clock_in is distinct from coalesce(v_before.billed_clock_in, v_before.clock_in)
       or v_snapshot.clock_out is distinct from coalesce(v_before.billed_clock_out, v_before.clock_out)
       or v_snapshot.billed_clock_in is distinct from v_before.billed_clock_in
       or v_snapshot.billed_clock_out is distinct from v_before.billed_clock_out
       or v_snapshot.regular_minutes is distinct from v_before.regular_minutes
       or v_snapshot.pre_shift_overtime_minutes is distinct from v_before.pre_shift_overtime_minutes
       or v_snapshot.post_shift_overtime_minutes is distinct from v_before.post_shift_overtime_minutes
       or v_snapshot.total_overtime_minutes is distinct from v_before.total_overtime_minutes
       or v_snapshot.late_minutes is distinct from v_before.minutes_late
       or v_snapshot.undertime_minutes is distinct from v_before.undertime_minutes
       or v_snapshot.attendance_updated_at is distinct from v_before.updated_at then
      raise exception using
        errcode = '55000',
        message = format('Payroll snapshot %s does not match the current canonical attendance content.', v_input.expected_snapshot_id);
    end if;

    select count(*)
    into v_snapshot_coverage_count
    from public.payroll_attendance_snapshots as snapshot
    where snapshot.attendance_id = v_before.id
      and snapshot.attendance_version = v_before.attendance_version
      and snapshot.id <> v_snapshot.id;

    if v_snapshot_coverage_count > 0 then
      raise exception 'Duplicate current snapshot coverage exists for attendance record %.', v_input.attendance_id;
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
      raise exception 'Attendance record % is not linked to exactly one draft payroll record in the target period.', v_input.attendance_id;
    end if;

    select count(*)
    into v_snapshot_coverage_count
    from public.payroll_attendance_snapshots as snapshot
    join public.payroll_records as record
      on record.id = snapshot.payroll_record_id
    where snapshot.attendance_id = v_before.id
      and snapshot.attendance_version = v_before.attendance_version
      and record.payroll_period_id <> v_period.id;

    if v_snapshot_coverage_count > 0 then
      raise exception 'Attendance record % has duplicate current payroll-period coverage.', v_input.attendance_id;
    end if;

    select
      count(*),
      coalesce(sum(allocation.allocated_minutes), 0),
      count(*) filter (
        where allocation.allocation_type <> 'settlement'
           or allocation.reverses_allocation_id is not null
           or exists (
             select 1
             from public.payroll_hour_allocations as reversal
             where reversal.reverses_allocation_id = allocation.id
           )
      )
    into v_allocation_count, v_allocation_minutes, v_unexpected_allocation_count
    from public.payroll_hour_allocations as allocation
    where allocation.attendance_snapshot_id = v_snapshot.id;

    if v_allocation_count is distinct from v_input.expected_allocation_count
       or v_allocation_minutes is distinct from v_input.expected_allocation_minutes
       or v_unexpected_allocation_count <> 0 then
      raise exception using
        errcode = '55000',
        message = format('Attendance record %s has unexpected prepaid allocation coverage.', v_input.attendance_id);
    end if;

    -- The scoped setting preserves the existing attendance storage trigger's
    -- normal version increment and payroll recalculation side effects while
    -- preventing it from recomputing the source total from raw timestamps.
    v_previous_correction_recalculation := current_setting(
      'workforce.correction_recalculation',
      true
    );
    perform set_config('workforce.correction_recalculation', 'true', true);
    begin
      update public.attendance
      set total_worked_minutes = v_canonical
      where id = v_before.id
        and attendance_version = v_input.expected_attendance_version
        and total_worked_minutes = v_input.expected_old_total_worked_minutes
      returning * into v_after;
    exception when others then
      perform set_config(
        'workforce.correction_recalculation',
        coalesce(v_previous_correction_recalculation, 'false'),
        true
      );
      raise;
    end;
    perform set_config(
      'workforce.correction_recalculation',
      coalesce(v_previous_correction_recalculation, 'false'),
      true
    );

    if not found then
      raise exception using
        errcode = '40001',
        message = format('Attendance record %s changed while reconciliation was running.', v_input.attendance_id);
    end if;

    if v_after.total_worked_minutes is distinct from v_canonical
       or v_after.attendance_version is distinct from v_before.attendance_version + 1
       or (to_jsonb(v_after) - array['total_worked_minutes', 'attendance_version', 'updated_at'])
            is distinct from (to_jsonb(v_before) - array['total_worked_minutes', 'attendance_version', 'updated_at']) then
      raise exception 'Attendance record % changed more than total_worked_minutes.', v_input.attendance_id;
    end if;

    insert into public.payroll_audit_logs (
      actor_user_id,
      action,
      entity_type,
      entity_id,
      payroll_period_id,
      payroll_record_id,
      before_data,
      after_data,
      reason,
      metadata
    )
    values (
      p_actor_user_id,
      'payroll_attendance_stale_total_reconciled',
      'attendance',
      v_after.id,
      v_period.id,
      v_record.id,
      jsonb_build_object(
        'attendance_id', v_before.id,
        'total_worked_minutes', v_before.total_worked_minutes,
        'attendance_version', v_before.attendance_version,
        'payroll_period_id', v_period.id,
        'payroll_record_id', v_record.id,
        'snapshot_id', v_snapshot.id,
        'snapshot_version', v_snapshot.attendance_version,
        'allocation_count', v_allocation_count,
        'allocation_minutes', v_allocation_minutes
      ),
      jsonb_build_object(
        'attendance_id', v_after.id,
        'total_worked_minutes', v_after.total_worked_minutes,
        'attendance_version', v_after.attendance_version,
        'payroll_period_id', v_period.id,
        'payroll_record_id', v_record.id,
        'snapshot_id', v_snapshot.id,
        'snapshot_version', v_snapshot.attendance_version,
        'allocation_count', v_allocation_count,
        'allocation_minutes', v_allocation_minutes
      ),
      trim(p_reason),
      jsonb_build_object(
        'reconciliation_type', 'approved_stale_total_only',
        'canonical_billed_minutes', v_canonical,
        'expected_attendance_version', v_input.expected_attendance_version,
        'expected_old_total_worked_minutes', v_input.expected_old_total_worked_minutes,
        'snapshot_fingerprint_before', v_before_snapshot_fingerprint,
        'snapshot_fingerprint_after', v_before_snapshot_fingerprint,
        'allocation_fingerprint_before', v_before_allocation_fingerprint,
        'allocation_fingerprint_after', v_before_allocation_fingerprint,
        'expected_snapshot_fingerprint', trim(p_expected_snapshot_fingerprint),
        'expected_allocation_fingerprint', trim(p_expected_allocation_fingerprint),
        'snapshot_unchanged', true,
        'allocations_unchanged', true,
        'prepaid_unchanged', true,
        'payroll_reimport_required', true,
        'audit_timestamp', pg_catalog.statement_timestamp()
      )
    );

    return query
    select
      v_after.id,
      v_record.id,
      v_before.total_worked_minutes,
      v_canonical,
      v_after.total_worked_minutes,
      v_before.attendance_version,
      v_after.attendance_version,
      v_snapshot.id,
      v_snapshot.attendance_version,
      v_allocation_count,
      v_allocation_minutes,
      'reconciled'::text;
  end loop;

  select md5(coalesce(string_agg(to_jsonb(snapshot)::text, '|' order by snapshot.id), ''))
  into v_after_snapshot_fingerprint
  from public.payroll_attendance_snapshots as snapshot
  join public.payroll_records as record
    on record.id = snapshot.payroll_record_id
  where record.payroll_period_id = v_period.id;

  select md5(coalesce(string_agg(part.fingerprint_part, '|' order by part.fingerprint_part), ''))
  into v_after_allocation_fingerprint
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

  if v_after_snapshot_fingerprint <> v_before_snapshot_fingerprint
     or v_after_allocation_fingerprint <> v_before_allocation_fingerprint then
    raise exception using
      errcode = '40001',
      message = 'Immutable payroll snapshots, allocations, or prepaid sources changed during reconciliation.';
  end if;

  return;
end;
$$;

alter function public.payroll_reconcile_approved_stale_totals(
  uuid, jsonb, uuid, text, text, text
) owner to postgres;

revoke all on function public.payroll_reconcile_approved_stale_totals(
  uuid, jsonb, uuid, text, text, text
) from public, anon, authenticated;

grant execute on function public.payroll_reconcile_approved_stale_totals(
  uuid, jsonb, uuid, text, text, text
) to service_role;

comment on function public.payroll_reconcile_approved_stale_totals(
  uuid, jsonb, uuid, text, text, text
) is
  'Service-only, explicit-manifest reconciliation of ordinary payroll-backed stale attendance totals for Aug 16-31, 2026; changes only total_worked_minutes, preserves snapshots and prepaid history, and requires a separate payroll re-import.';

commit;

;
