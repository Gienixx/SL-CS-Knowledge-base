-- Dedicated, explicit-manifest reconciliation for the 11 Rest Day stale-total
-- rows in the Aug 16-31, 2026 draft payroll period.
--
-- This function intentionally does not import snapshots, calculate payroll, or
-- touch allocations/prepaid balances. A normal payroll attendance re-import
-- must be run separately after this source-only reconciliation.

begin;

create or replace function public.payroll_reconcile_approved_rest_day_stale_totals(
  p_payroll_period_id uuid,
  p_rows jsonb,
  p_actor_user_id uuid,
  p_reason text,
  p_expected_snapshot_fingerprint text,
  p_expected_allocation_fingerprint text,
  p_expected_prepaid_balance_fingerprint text
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
  v_expected record;
  v_row_count integer;
  v_distinct_row_count integer;
  v_canonical integer;
  v_readiness_blockers text[];
  v_snapshot_coverage_count bigint;
  v_duplicate_current_snapshot_count bigint;
  v_allocation_count bigint;
  v_allocation_minutes bigint;
  v_settlement_count bigint;
  v_reversal_count bigint;
  v_calculated_record_count bigint;
  v_item_count bigint;
  v_payslip_count bigint;
  v_before_snapshot_fingerprint text;
  v_after_snapshot_fingerprint text;
  v_before_allocation_fingerprint text;
  v_after_allocation_fingerprint text;
  v_before_prepaid_balance_fingerprint text;
  v_after_prepaid_balance_fingerprint text;
  v_previous_correction_recalculation text;
  v_duplicate_attendance boolean;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'This reconciliation is restricted to the service_role.';
  end if;

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
     or nullif(trim(coalesce(p_expected_allocation_fingerprint, '')), '') is null
     or nullif(trim(coalesce(p_expected_prepaid_balance_fingerprint, '')), '') is null then
    raise exception using
      errcode = '22023',
      message = 'Expected snapshot, allocation, and prepaid balance fingerprints are required.';
  end if;

  if p_rows is null
     or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) <> 11 then
    raise exception using
      errcode = '22023',
      message = 'The Rest Day manifest must contain exactly 11 rows.';
  end if;

  select count(*)::integer, count(distinct row_input.attendance_id)::integer
  into v_row_count, v_distinct_row_count
  from jsonb_to_recordset(p_rows) as row_input(
    attendance_id uuid,
    expected_attendance_version bigint,
    expected_old_total_worked_minutes integer,
    expected_canonical_minutes integer,
    expected_work_date date,
    expected_schedule_id uuid,
    expected_schedule_shift_date date,
    expected_schedule_version bigint,
    expected_regular_minutes integer,
    expected_pre_shift_overtime_minutes integer,
    expected_post_shift_overtime_minutes integer,
    expected_total_overtime_minutes integer,
    expected_rest_day_overtime_minutes integer,
    expected_holiday_overtime_minutes integer,
    expected_snapshot_id uuid,
    expected_snapshot_version bigint,
    expected_allocation_count integer,
    expected_allocation_minutes bigint
  );

  if v_row_count <> 11 or v_distinct_row_count <> 11 then
    raise exception using
      errcode = '22023',
      message = 'The Rest Day manifest must contain 11 distinct rows.';
  end if;

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
    raise exception using errcode = '55000', message = 'Only a draft payroll period can be reconciled.';
  end if;

  if v_period.finalization_version is distinct from 0 then
    raise exception using errcode = '40001', message = 'The payroll period finalization version is not zero.';
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
    raise exception using errcode = '55000', message = 'Calculated or finalized payroll records block reconciliation.';
  end if;

  select count(*)
  into v_item_count
  from public.payroll_items as item
  join public.payroll_records as record on record.id = item.payroll_record_id
  where record.payroll_period_id = v_period.id;

  if v_item_count > 0 then
    raise exception using errcode = '55000', message = 'Payroll items block reconciliation.';
  end if;

  select count(*)
  into v_payslip_count
  from public.payslips as payslip
  join public.payroll_records as record on record.id = payslip.payroll_record_id
  where record.payroll_period_id = v_period.id;

  if v_payslip_count > 0 then
    raise exception using errcode = '55000', message = 'Payslips block reconciliation.';
  end if;

  perform 1
  from public.payroll_attendance_snapshots as snapshot
  join public.payroll_records as record on record.id = snapshot.payroll_record_id
  where record.payroll_period_id = v_period.id
  for update of snapshot;

  perform 1
  from public.payroll_hour_allocations as allocation
  join public.payroll_records as record on record.id = allocation.destination_payroll_record_id
  where record.payroll_period_id = v_period.id
  for update of allocation;

  perform 1
  from public.payroll_prepaid_hours as prepaid
  where prepaid.source_payroll_record_id in (
    select record.id
    from public.payroll_records as record
    where record.payroll_period_id = v_period.id
  )
  or exists (
    select 1
    from public.payroll_hour_allocations as allocation
    join public.payroll_records as record on record.id = allocation.destination_payroll_record_id
    where record.payroll_period_id = v_period.id
      and allocation.prepaid_hour_id = prepaid.id
  )
  for update;

  select md5(coalesce(string_agg(to_jsonb(snapshot)::text, '|' order by snapshot.id), ''))
  into v_before_snapshot_fingerprint
  from public.payroll_attendance_snapshots as snapshot
  join public.payroll_records as record on record.id = snapshot.payroll_record_id
  where record.payroll_period_id = v_period.id;

  select md5(coalesce(string_agg(part.fingerprint_part, '|' order by part.fingerprint_part), ''))
  into v_before_allocation_fingerprint
  from (
    select 'allocation:' || to_jsonb(allocation)::text as fingerprint_part
    from public.payroll_hour_allocations as allocation
    join public.payroll_records as record on record.id = allocation.destination_payroll_record_id
    where record.payroll_period_id = v_period.id
    union all
    select distinct 'prepaid:' || to_jsonb(prepaid)::text as fingerprint_part
    from public.payroll_prepaid_hours as prepaid
    join public.payroll_hour_allocations as allocation on allocation.prepaid_hour_id = prepaid.id
    join public.payroll_records as record on record.id = allocation.destination_payroll_record_id
    where record.payroll_period_id = v_period.id
  ) as part;

  select md5(coalesce(string_agg(to_jsonb(prepaid)::text, '|' order by prepaid.id), ''))
  into v_before_prepaid_balance_fingerprint
  from public.payroll_prepaid_hours as prepaid
  where prepaid.source_payroll_record_id in (
    select record.id
    from public.payroll_records as record
    where record.payroll_period_id = v_period.id
  )
  or exists (
    select 1
    from public.payroll_hour_allocations as allocation
    join public.payroll_records as record on record.id = allocation.destination_payroll_record_id
    where record.payroll_period_id = v_period.id
      and allocation.prepaid_hour_id = prepaid.id
  );

  if v_before_snapshot_fingerprint <> trim(p_expected_snapshot_fingerprint)
     or v_before_allocation_fingerprint <> trim(p_expected_allocation_fingerprint)
     or v_before_prepaid_balance_fingerprint <> trim(p_expected_prepaid_balance_fingerprint) then
    raise exception using errcode = '40001', message = 'A payroll or prepaid fingerprint changed since the dry run.';
  end if;

  for v_input in
    select row_input.*
    from jsonb_to_recordset(p_rows) as row_input(
      attendance_id uuid,
      expected_attendance_version bigint,
      expected_old_total_worked_minutes integer,
      expected_canonical_minutes integer,
      expected_work_date date,
      expected_schedule_id uuid,
      expected_schedule_shift_date date,
      expected_schedule_version bigint,
      expected_regular_minutes integer,
      expected_pre_shift_overtime_minutes integer,
      expected_post_shift_overtime_minutes integer,
      expected_total_overtime_minutes integer,
      expected_rest_day_overtime_minutes integer,
      expected_holiday_overtime_minutes integer,
      expected_snapshot_id uuid,
      expected_snapshot_version bigint,
      expected_allocation_count integer,
      expected_allocation_minutes bigint
    )
    order by row_input.attendance_id
  loop
    select m.*
    into v_expected
    from (values
      ('8062bebb-12b0-4cc4-92f8-3fac81d9cc04'::uuid,8::bigint,814,780,date '2026-08-17','495e2307-090a-4887-801e-bc21f710a2b8'::uuid,date '2026-08-17',1::bigint,0,0,0,780,780,0,'2d4d8d80-7459-4264-a065-fc3d9615cbbb'::uuid,8::bigint,0,0::bigint),
      ('d872fea2-e00d-4053-b94c-a467e090217c'::uuid,8::bigint,915,900,date '2026-08-18','65d7021a-fd49-4eb1-a4ed-e6139202ad2a'::uuid,date '2026-08-18',1::bigint,0,0,0,900,900,0,'7c7f7c86-8814-43f9-bccd-59fc57db7c0f'::uuid,8::bigint,0,0::bigint),
      ('7c608cbc-8ff0-4048-995b-8b84015cc0a4'::uuid,8::bigint,487,480,date '2026-08-18','a2c58d19-877d-4fbd-95f9-0d998081015f'::uuid,date '2026-08-18',3::bigint,0,0,0,480,480,0,'ff4f43f7-59fc-4507-9874-22e932f59385'::uuid,8::bigint,0,0::bigint),
      ('da64621e-fe78-49e3-be36-b644640314d0'::uuid,8::bigint,909,900,date '2026-08-21','e01b29cb-41c3-4ab9-8773-afcb44350ed7'::uuid,date '2026-08-21',1::bigint,0,0,0,900,900,0,'d9a18fba-dc42-49a0-84dc-ab313c1b2c59'::uuid,8::bigint,0,0::bigint),
      ('aba330f2-5286-458e-b9ab-9c0382dec21b'::uuid,8::bigint,903,900,date '2026-08-22','f928036d-733b-45fe-b703-51002643dfc9'::uuid,date '2026-08-22',1::bigint,0,0,0,900,900,0,'ba2d8882-54a7-4a27-b862-841895f86203'::uuid,8::bigint,0,0::bigint),
      ('930fa600-cc6f-4477-bf11-de59b4580b18'::uuid,10::bigint,916,900,date '2026-08-22','d8145289-33cf-4243-8e98-67b41d98a191'::uuid,date '2026-08-22',1::bigint,0,0,0,900,900,0,'bd6dfe37-0c8a-49b1-8392-5af35bcd987f'::uuid,10::bigint,0,0::bigint),
      ('6b3c963e-2cbe-42d4-818b-2b2570e41334'::uuid,8::bigint,489,480,date '2026-08-22','b3013092-41a2-42c7-8f1b-0c2b9f330d36'::uuid,date '2026-08-22',3::bigint,0,0,0,480,480,0,'aa5addb7-dec5-45fb-96f5-ce1eb872f4c4'::uuid,8::bigint,0,0::bigint),
      ('9f14493d-663e-41d1-b136-6671eab02a41'::uuid,8::bigint,724,720,date '2026-08-22','2c945401-e4ad-4ac0-8ee5-29000a08181e'::uuid,date '2026-08-22',1::bigint,0,0,0,720,720,0,'44ef4b4f-7274-4f77-b475-1d21c8c40b83'::uuid,8::bigint,0,0::bigint),
      ('0eeb0c01-270d-42fe-82e1-e67626246e15'::uuid,8::bigint,911,900,date '2026-08-23','939e5bf2-83a5-4b5d-a5d2-47a05ac0b51d'::uuid,date '2026-08-23',1::bigint,0,0,0,900,900,0,'42bd38a4-97d5-48d7-824d-1e650aa6a3e4'::uuid,8::bigint,0,0::bigint),
      ('16addadd-b1be-4838-ae47-63addd94c88a'::uuid,10::bigint,909,900,date '2026-08-23','ecacc85a-cd4c-4a94-8a09-64629119702d'::uuid,date '2026-08-23',1::bigint,0,0,0,900,900,0,'e15102be-161a-4d03-aee8-fb4e6208c7dd'::uuid,10::bigint,0,0::bigint),
      ('3be9a173-29a2-44a8-9fef-d5d635890a14'::uuid,8::bigint,192,180,date '2026-08-23','7fc60f4e-853d-4112-b562-05a6204f669c'::uuid,date '2026-08-23',1::bigint,0,0,0,180,180,0,'4e9d64c8-b0a1-4479-ac8c-50713914f1c0'::uuid,8::bigint,0,0::bigint)
    ) as m(
      attendance_id, attendance_version, old_total, canonical_minutes,
      work_date, schedule_id, schedule_shift_date, schedule_version,
      regular_minutes, pre_shift_minutes, post_shift_minutes,
      total_overtime_minutes, rest_day_overtime_minutes,
      holiday_overtime_minutes, snapshot_id, snapshot_version,
      allocation_count, allocation_minutes
    )
    where m.attendance_id = v_input.attendance_id;

    if not found
       or v_input.expected_attendance_version is distinct from v_expected.attendance_version
       or v_input.expected_old_total_worked_minutes is distinct from v_expected.old_total
       or v_input.expected_canonical_minutes is distinct from v_expected.canonical_minutes
       or v_input.expected_work_date is distinct from v_expected.work_date
       or v_input.expected_schedule_id is distinct from v_expected.schedule_id
       or v_input.expected_schedule_shift_date is distinct from v_expected.schedule_shift_date
       or v_input.expected_schedule_version is distinct from v_expected.schedule_version
       or v_input.expected_regular_minutes is distinct from v_expected.regular_minutes
       or v_input.expected_pre_shift_overtime_minutes is distinct from v_expected.pre_shift_minutes
       or v_input.expected_post_shift_overtime_minutes is distinct from v_expected.post_shift_minutes
       or v_input.expected_total_overtime_minutes is distinct from v_expected.total_overtime_minutes
       or v_input.expected_rest_day_overtime_minutes is distinct from v_expected.rest_day_overtime_minutes
       or v_input.expected_holiday_overtime_minutes is distinct from v_expected.holiday_overtime_minutes
       or v_input.expected_snapshot_id is distinct from v_expected.snapshot_id
       or v_input.expected_snapshot_version is distinct from v_expected.snapshot_version
       or v_input.expected_allocation_count is distinct from v_expected.allocation_count
       or v_input.expected_allocation_minutes is distinct from v_expected.allocation_minutes then
      raise exception using errcode = '40001', message = format('Attendance ID %s does not match the exact Rest Day manifest.', v_input.attendance_id);
    end if;

    select attendance_row.* into v_before
    from public.attendance as attendance_row
    where attendance_row.id = v_input.attendance_id
    for update;

    if not found then
      raise exception 'Attendance record % was not found.', v_input.attendance_id;
    end if;

    if v_before.voided_at is not null
       or v_before.review_status <> 'approved'
       or v_before.payroll_approved_at is null then
      raise exception using errcode = '55000', message = format('Attendance record %s is not currently approved and payroll-eligible.', v_input.attendance_id);
    end if;

    if v_before.attendance_version is distinct from v_expected.attendance_version
       or v_before.total_worked_minutes is distinct from v_expected.old_total
       or v_before.work_date is distinct from v_expected.work_date
       or v_before.schedule_id is distinct from v_expected.schedule_id then
      raise exception using errcode = '40001', message = format('Attendance record %s changed since the manifest gate.', v_input.attendance_id);
    end if;

    if v_before.billed_clock_in is null
       or v_before.billed_clock_out is null
       or v_before.billed_clock_out < v_before.billed_clock_in then
      raise exception 'Attendance record % does not have valid billed timestamps.', v_input.attendance_id;
    end if;

    v_canonical := public.workforce_canonical_billed_minutes(v_before.billed_clock_in, v_before.billed_clock_out);
    if v_canonical is null or v_canonical is distinct from v_expected.canonical_minutes then
      raise exception using errcode = '40001', message = format('Attendance record %s no longer matches its canonical billed duration.', v_input.attendance_id);
    end if;

    if v_before.regular_minutes is distinct from v_expected.regular_minutes
       or v_before.pre_shift_overtime_minutes is distinct from v_expected.pre_shift_minutes
       or v_before.post_shift_overtime_minutes is distinct from v_expected.post_shift_minutes
       or v_before.total_overtime_minutes is distinct from v_expected.total_overtime_minutes
       or v_before.rest_day_overtime_minutes is distinct from v_expected.rest_day_overtime_minutes
       or v_before.holiday_overtime_minutes is distinct from v_expected.holiday_overtime_minutes
       or v_before.overtime_minutes is distinct from v_before.total_overtime_minutes then
      raise exception using errcode = '55000', message = format('Attendance record %s has a classification mismatch.', v_input.attendance_id);
    end if;

    select schedule.* into v_schedule
    from public.work_schedules as schedule
    where schedule.id = v_before.schedule_id
    for share;

    if not found
       or v_schedule.id is distinct from v_expected.schedule_id
       or v_schedule.user_id is distinct from v_before.user_id
       or v_schedule.shift_date is distinct from v_before.work_date
       or v_schedule.shift_date is distinct from v_expected.schedule_shift_date
       or v_schedule.schedule_version is distinct from v_expected.schedule_version
       or v_schedule.is_rest_day is distinct from true
       or v_schedule.is_holiday is distinct from false then
      raise exception using errcode = '55000', message = format('Attendance record %s has invalid Rest Day schedule provenance.', v_input.attendance_id);
    end if;

    select readiness.payroll_readiness_blockers into v_readiness_blockers
    from public.workforce_attendance_payroll_readiness as readiness
    where readiness.id = v_before.id;

    if not found
       or cardinality(v_readiness_blockers) <> 1
       or v_readiness_blockers[1] <> 'total_worked_mismatch' then
      raise exception using errcode = '55000', message = format('Attendance record %s has a blocker beyond total_worked_mismatch.', v_input.attendance_id);
    end if;

    select exists (
      select 1
      from public.attendance as other
      where other.id <> v_before.id
        and other.user_id = v_before.user_id
        and other.work_date = v_before.work_date
        and other.voided_at is null
        and (
          (other.clock_in is not null and other.clock_out is not null
           and v_before.clock_in is not null and v_before.clock_out is not null
           and v_before.clock_in < other.clock_out and v_before.clock_out > other.clock_in)
          or (other.billed_clock_in is not null and other.billed_clock_out is not null
           and v_before.billed_clock_in < other.billed_clock_out and v_before.billed_clock_out > other.billed_clock_in)
          or (other.clock_in is not distinct from v_before.clock_in
           and other.clock_out is not distinct from v_before.clock_out)
          or (other.billed_clock_in is not distinct from v_before.billed_clock_in
           and other.billed_clock_out is not distinct from v_before.billed_clock_out)
        )
    ) into v_duplicate_attendance;

    if v_duplicate_attendance then
      raise exception 'Attendance record % has duplicate or overlapping attendance coverage.', v_input.attendance_id;
    end if;

    select count(*) into v_snapshot_coverage_count
    from public.payroll_attendance_snapshots as snapshot
    where snapshot.attendance_id = v_before.id
      and snapshot.attendance_version = v_before.attendance_version;

    if v_snapshot_coverage_count <> 1 then
      raise exception using errcode = '55000', message = format('Attendance record %s does not have exactly one current-version snapshot.', v_input.attendance_id);
    end if;

    select snapshot.* into v_snapshot
    from public.payroll_attendance_snapshots as snapshot
    where snapshot.id = v_expected.snapshot_id
    for update;

    if not found
       or v_snapshot.attendance_id is distinct from v_before.id
       or v_snapshot.attendance_version is distinct from v_before.attendance_version
       or v_snapshot.attendance_version is distinct from v_expected.snapshot_version
       or v_snapshot.employee_id is distinct from v_before.user_id
       or v_snapshot.schedule_id is distinct from v_before.schedule_id
       or v_snapshot.work_date is distinct from v_before.work_date
       or v_snapshot.clock_in is distinct from v_before.billed_clock_in
       or v_snapshot.clock_out is distinct from v_before.billed_clock_out
       or v_snapshot.billed_clock_in is distinct from v_before.billed_clock_in
       or v_snapshot.billed_clock_out is distinct from v_before.billed_clock_out
       or v_snapshot.regular_minutes is distinct from v_expected.regular_minutes
       or v_snapshot.pre_shift_overtime_minutes is distinct from v_expected.pre_shift_minutes
       or v_snapshot.post_shift_overtime_minutes is distinct from v_expected.post_shift_minutes
       or v_snapshot.total_overtime_minutes is distinct from v_expected.total_overtime_minutes
       or v_snapshot.rest_day_overtime_minutes is distinct from v_expected.rest_day_overtime_minutes
       or v_snapshot.holiday_overtime_minutes is distinct from v_expected.holiday_overtime_minutes
       or v_snapshot.is_rest_day is distinct from true
       or v_snapshot.is_holiday is distinct from false
       or v_snapshot.special_day_type is distinct from 'rest_day'
       or v_snapshot.late_minutes is distinct from v_before.minutes_late
       or v_snapshot.undertime_minutes is distinct from v_before.undertime_minutes
       or v_snapshot.attendance_updated_at is distinct from v_before.updated_at then
      raise exception using errcode = '55000', message = format('Payroll snapshot %s does not match the exact Rest Day attendance contract.', v_expected.snapshot_id);
    end if;

    select count(*) into v_snapshot_coverage_count
    from public.payroll_attendance_snapshots as snapshot
    where snapshot.attendance_id = v_before.id
      and snapshot.attendance_version = v_before.attendance_version
      and snapshot.id <> v_snapshot.id;

    if v_snapshot_coverage_count > 0 then
      raise exception 'Duplicate current snapshot coverage exists for attendance record %.', v_input.attendance_id;
    end if;

    select count(*) into v_duplicate_current_snapshot_count
    from public.payroll_attendance_snapshots as snapshot
    join public.attendance as snapshot_attendance on snapshot_attendance.id = snapshot.attendance_id
    where snapshot.employee_id = v_before.user_id
      and snapshot.work_date = v_before.work_date
      and snapshot.id <> v_snapshot.id
      and snapshot.attendance_version = snapshot_attendance.attendance_version;

    if v_duplicate_current_snapshot_count > 0 then
      raise exception 'Duplicate current snapshot coverage exists for employee/date of attendance record %.', v_input.attendance_id;
    end if;

    select record.* into v_record
    from public.payroll_records as record
    where record.id = v_snapshot.payroll_record_id
      and record.payroll_period_id = v_period.id
      and record.employee_id = v_before.user_id
      and record.status = 'draft'
    for update;

    if not found then
      raise exception 'Attendance record % is not linked to exactly one draft payroll record in the target period.', v_input.attendance_id;
    end if;

    select count(*) filter (where allocation.allocation_type = 'settlement'),
           count(*) filter (where allocation.allocation_type = 'reversal'),
           count(*),
           coalesce(sum(allocation.allocated_minutes), 0)
    into v_settlement_count, v_reversal_count, v_allocation_count, v_allocation_minutes
    from public.payroll_hour_allocations as allocation
    join public.payroll_attendance_snapshots as covered_snapshot
      on covered_snapshot.id = allocation.attendance_snapshot_id
    where covered_snapshot.attendance_id = v_before.id;

    if v_settlement_count <> 0
       or v_reversal_count <> 0
       or v_allocation_count is distinct from v_expected.allocation_count
       or v_allocation_minutes is distinct from v_expected.allocation_minutes then
      raise exception using errcode = '55000', message = format('Attendance record %s has prepaid allocation coverage.', v_input.attendance_id);
    end if;

    v_previous_correction_recalculation := current_setting('workforce.correction_recalculation', true);
    perform set_config('workforce.correction_recalculation', 'true', true);
    begin
      update public.attendance
      set total_worked_minutes = v_canonical
      where id = v_before.id
        and attendance_version = v_expected.attendance_version
        and total_worked_minutes = v_expected.old_total
      returning * into v_after;
    exception when others then
      perform set_config('workforce.correction_recalculation', coalesce(v_previous_correction_recalculation, 'false'), true);
      raise;
    end;
    perform set_config('workforce.correction_recalculation', coalesce(v_previous_correction_recalculation, 'false'), true);

    if not found then
      raise exception using errcode = '40001', message = format('Attendance record %s changed while reconciliation was running.', v_input.attendance_id);
    end if;

    if v_after.total_worked_minutes is distinct from v_canonical
       or v_after.attendance_version is distinct from v_before.attendance_version + 1
       or (to_jsonb(v_after) - array['total_worked_minutes', 'attendance_version', 'updated_at'])
            is distinct from (to_jsonb(v_before) - array['total_worked_minutes', 'attendance_version', 'updated_at']) then
      raise exception 'Attendance record % changed more than the authorized total.', v_input.attendance_id;
    end if;

    insert into public.payroll_audit_logs (
      actor_user_id, action, entity_type, entity_id, payroll_period_id,
      payroll_record_id, before_data, after_data, reason, metadata
    )
    values (
      p_actor_user_id,
      'payroll_rest_day_stale_total_reconciled',
      'attendance',
      v_after.id,
      v_period.id,
      v_record.id,
      jsonb_build_object('attendance_id', v_before.id, 'total_worked_minutes', v_before.total_worked_minutes, 'attendance_version', v_before.attendance_version, 'snapshot_id', v_snapshot.id, 'snapshot_version', v_snapshot.attendance_version),
      jsonb_build_object('attendance_id', v_after.id, 'total_worked_minutes', v_after.total_worked_minutes, 'attendance_version', v_after.attendance_version, 'snapshot_id', v_snapshot.id, 'snapshot_version', v_snapshot.attendance_version),
      trim(p_reason),
      jsonb_build_object('reconciliation_type', 'approved_rest_day_stale_total_only', 'canonical_billed_minutes', v_canonical, 'snapshot_unchanged', true, 'allocations_unchanged', true, 'prepaid_unchanged', true, 'payroll_reimport_required', true)
    );

    return query
    select v_after.id, v_record.id, v_before.total_worked_minutes, v_canonical,
           v_after.total_worked_minutes, v_before.attendance_version,
           v_after.attendance_version, v_snapshot.id, v_snapshot.attendance_version,
           v_allocation_count, v_allocation_minutes, 'reconciled'::text;
  end loop;

  select md5(coalesce(string_agg(to_jsonb(snapshot)::text, '|' order by snapshot.id), ''))
  into v_after_snapshot_fingerprint
  from public.payroll_attendance_snapshots as snapshot
  join public.payroll_records as record on record.id = snapshot.payroll_record_id
  where record.payroll_period_id = v_period.id;

  select md5(coalesce(string_agg(part.fingerprint_part, '|' order by part.fingerprint_part), ''))
  into v_after_allocation_fingerprint
  from (
    select 'allocation:' || to_jsonb(allocation)::text as fingerprint_part
    from public.payroll_hour_allocations as allocation
    join public.payroll_records as record on record.id = allocation.destination_payroll_record_id
    where record.payroll_period_id = v_period.id
    union all
    select distinct 'prepaid:' || to_jsonb(prepaid)::text as fingerprint_part
    from public.payroll_prepaid_hours as prepaid
    join public.payroll_hour_allocations as allocation on allocation.prepaid_hour_id = prepaid.id
    join public.payroll_records as record on record.id = allocation.destination_payroll_record_id
    where record.payroll_period_id = v_period.id
  ) as part;

  select md5(coalesce(string_agg(to_jsonb(prepaid)::text, '|' order by prepaid.id), ''))
  into v_after_prepaid_balance_fingerprint
  from public.payroll_prepaid_hours as prepaid
  where prepaid.source_payroll_record_id in (
    select record.id from public.payroll_records as record where record.payroll_period_id = v_period.id
  )
  or exists (
    select 1
    from public.payroll_hour_allocations as allocation
    join public.payroll_records as record on record.id = allocation.destination_payroll_record_id
    where record.payroll_period_id = v_period.id and allocation.prepaid_hour_id = prepaid.id
  );

  if v_after_snapshot_fingerprint <> v_before_snapshot_fingerprint
     or v_after_allocation_fingerprint <> v_before_allocation_fingerprint
     or v_after_prepaid_balance_fingerprint <> v_before_prepaid_balance_fingerprint then
    raise exception using errcode = '40001', message = 'Snapshots, allocations, or prepaid balances changed during reconciliation.';
  end if;

  select count(*) into v_calculated_record_count
  from public.payroll_records as record
  where record.payroll_period_id = v_period.id
    and (record.calculated_by is not null or record.calculated_at is not null or record.status <> 'draft');

  if v_calculated_record_count > 0 then
    raise exception using errcode = '55000', message = 'Payroll state changed during reconciliation.';
  end if;

  select count(*) into v_item_count
  from public.payroll_items as item
  join public.payroll_records as record on record.id = item.payroll_record_id
  where record.payroll_period_id = v_period.id;
  if v_item_count > 0 then
    raise exception using errcode = '55000', message = 'Payroll items appeared during reconciliation.';
  end if;

  select count(*) into v_payslip_count
  from public.payslips as payslip
  join public.payroll_records as record on record.id = payslip.payroll_record_id
  where record.payroll_period_id = v_period.id;
  if v_payslip_count > 0 then
    raise exception using errcode = '55000', message = 'Payslips appeared during reconciliation.';
  end if;

  return;
end;
$$;

alter function public.payroll_reconcile_approved_rest_day_stale_totals(
  uuid, jsonb, uuid, text, text, text, text
) owner to postgres;

revoke all on function public.payroll_reconcile_approved_rest_day_stale_totals(
  uuid, jsonb, uuid, text, text, text, text
) from public, anon, authenticated;

grant execute on function public.payroll_reconcile_approved_rest_day_stale_totals(
  uuid, jsonb, uuid, text, text, text, text
) to service_role;

comment on function public.payroll_reconcile_approved_rest_day_stale_totals(
  uuid, jsonb, uuid, text, text, text, text
) is
  'Service-only explicit-manifest reconciliation of the 11 Aug 16-31 2026 Rest Day stale totals; changes only attendance total_worked_minutes and requires a separate normal payroll re-import.';

commit;

;
