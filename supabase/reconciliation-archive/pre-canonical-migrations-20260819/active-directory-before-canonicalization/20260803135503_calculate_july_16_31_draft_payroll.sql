-- Complete the July 16-31 Step 14 draft calculation after final attendance
-- approval. Four Almar prepaid approvals still reference superseded schedule
-- versions, so first snapshot the current schedule versions using the exact
-- approved workbook LOG IN / LOG OUT values. Then import all payroll-ready
-- attendance and calculate the draft through the existing secured RPCs.

begin;

set local statement_timeout = '30s';

do $$
declare
  v_actor_auth_user_id constant uuid :=
    '7859dcc5-7a77-4850-bc91-1db5d9e0dd90'::uuid;
  v_actor_profile_user_id constant uuid :=
    '7859dcc5-7a77-4850-bc91-1db5d9e0dd90'::uuid;
  v_period_id constant uuid :=
    '9b47142d-37fc-4d19-91f6-011667352114'::uuid;
  v_almar_user_id constant uuid :=
    '9b11cbdf-9f09-46cb-bdbc-05ed75ef2b8e'::uuid;
  v_almar_payroll_record_id constant uuid :=
    '72efaa4a-4d20-4af5-8e8c-b510aaf2e602'::uuid;
  v_source_hash constant text :=
    '949d4e4547f92829a3a631e8d7b4712e45fedeac8a1ad14245cdcd231b47d590';
  v_revision constant text := 'validation-20260803-current-schedule';
  v_started_at constant timestamptz := statement_timestamp();
  v_period public.payroll_periods%rowtype;
  v_target record;
  v_schedule public.work_schedules%rowtype;
  v_old_snapshot public.payroll_schedule_snapshots%rowtype;
  v_old_prepaid public.payroll_prepaid_hours%rowtype;
  v_new_snapshot_id uuid;
  v_new_prepaid public.payroll_prepaid_hours%rowtype;
  v_import_result jsonb;
  v_calculation_result jsonb;
  v_blocking_exception_count bigint;
  v_record_count bigint;
  v_ready_record_count bigint;
  v_test_record_count bigint;
  v_current_attendance_snapshot_count bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'calculate_july_16_31_draft_payroll:20260803',
      0
    )
  );

  perform pg_catalog.set_config(
    'request.jwt.claim.sub',
    v_actor_auth_user_id::text,
    true
  );
  perform pg_catalog.set_config(
    'request.jwt.claim.role',
    'authenticated',
    true
  );
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', v_actor_auth_user_id,
      'role', 'authenticated'
    )::text,
    true
  );

  if public.workforce_current_profile_id() <> v_actor_profile_user_id
     or not public.workforce_current_user_is_active()
     or not public.workforce_is_admin()
     or not public.workforce_has_permission('create_payroll') then
    raise exception 'The expected administrator cannot calculate payroll.';
  end if;

  select period.*
  into v_period
  from public.payroll_periods as period
  where period.id = v_period_id
  for update;

  if not found
     or v_period.period_start <> date '2026-07-16'
     or v_period.period_end <> date '2026-07-31'
     or v_period.payment_date <> date '2026-07-27'
     or v_period.status <> 'draft'
     or v_period.currency_code <> 'USD'
     or v_period.approved_at is not null
     or v_period.finalized_at is not null
     or v_period.rounding_rules is distinct from jsonb_build_object(
       'money_scale', 2,
       'rounding_mode', 'half_up',
       'minute_conversion', 'exact'
     ) then
    raise exception 'The July 16-31 payroll period changed after validation.';
  end if;

  select count(*)
  into v_record_count
  from public.payroll_records as record
  join public.profiles as profile
    on profile.user_id = record.employee_id
  where record.payroll_period_id = v_period_id
    and record.status = 'draft'
    and record.calculated_at is null
    and record.gross_pay = 0
    and record.net_pay = 0
    and profile.is_payroll_eligible
    and profile.employment_status in ('active', 'on_leave');

  if v_record_count <> 9 then
    raise exception
      'Expected nine uncalculated payable draft records, found %.',
      v_record_count;
  end if;

  select count(*)
  into v_test_record_count
  from public.profiles as profile
  left join public.payroll_records as record
    on record.employee_id = profile.user_id
   and record.payroll_period_id = v_period_id
   and record.status <> 'void'
  where profile.user_id in (
      'c985d512-90ad-4144-9490-e054d3b81b45'::uuid,
      'eca1ac5d-43d6-4d6a-bf9b-7e67f09bb6d5'::uuid
    )
    and (
      profile.is_payroll_eligible
      or record.id is not null
    );

  if v_test_record_count <> 0 then
    raise exception 'A testing-only profile is still payroll eligible or loaded.';
  end if;

  if (
    select count(*)
    from public.payroll_get_period_employee_readiness(v_period_id) as readiness
    where readiness.readiness_status = 'ready'
      and readiness.missing_attendance_count = 0
      and readiness.incomplete_attendance_count = 0
      and readiness.missing_clock_out_count = 0
      and readiness.pending_review_count = 0
      and readiness.missing_rate_date_count = 0
  ) <> 9 then
    raise exception 'Not all nine payable employees are payroll ready.';
  end if;

  for v_target in
    select *
    from (
      values
        (
          'fbe0ae78-e0d6-46c0-a209-de0ffb19604b'::uuid,
          date '2026-07-28',
          283,
          4::bigint,
          'open'::text,
          '2026-08-03 10:39:18.358439+00'::timestamptz,
          '8066c34b-742d-4f57-93fb-b5ac09ae5e8b'::uuid,
          '3f3f95db-4d99-4c70-ad5b-a156906f3391'::uuid,
          make_timestamptz(2026, 7, 28, 11, 30, 0, 'America/New_York'),
          make_timestamptz(2026, 7, 29, 5, 30, 0, 'America/New_York')
        ),
        (
          'da933d3c-8a25-4015-b975-fab14080a19a'::uuid,
          date '2026-07-29',
          284,
          5::bigint,
          'open'::text,
          '2026-08-03 10:39:18.358439+00'::timestamptz,
          '9d1134b7-6472-467f-945f-21ff35117a13'::uuid,
          '643f6f8c-0ed6-41a9-8f1f-da4b8031c3a6'::uuid,
          make_timestamptz(2026, 7, 29, 14, 0, 0, 'America/New_York'),
          make_timestamptz(2026, 7, 30, 8, 0, 0, 'America/New_York')
        ),
        (
          '9707b94d-9d4d-4f07-8496-8e72d7aecfb4'::uuid,
          date '2026-07-30',
          285,
          3::bigint,
          'fixed'::text,
          '2026-08-03 11:44:41.608775+00'::timestamptz,
          '25d4970a-cb63-4990-8027-27c077f7b344'::uuid,
          '3bdbbc9c-d3e6-4800-90e9-bdedf52b4e8c'::uuid,
          make_timestamptz(2026, 7, 30, 10, 15, 0, 'America/New_York'),
          make_timestamptz(2026, 7, 31, 4, 15, 0, 'America/New_York')
        ),
        (
          'fdc0360d-e7dd-46de-b43a-51ef4f8ce7da'::uuid,
          date '2026-07-31',
          286,
          3::bigint,
          'fixed'::text,
          '2026-08-03 11:44:41.608775+00'::timestamptz,
          '53eebc7b-1f23-4c0a-95b5-4a1d5199fbf3'::uuid,
          '5e11aede-44e9-4c9c-bcad-1513f413c682'::uuid,
          make_timestamptz(2026, 7, 31, 9, 0, 0, 'America/New_York'),
          make_timestamptz(2026, 8, 1, 3, 0, 0, 'America/New_York')
        )
    ) as target(
      schedule_id,
      work_date,
      source_row,
      expected_schedule_version,
      expected_schedule_mode,
      expected_schedule_updated_at,
      old_snapshot_id,
      old_prepaid_hour_id,
      prepaid_start,
      prepaid_end
    )
    order by schedule_id
  loop
    select schedule.*
    into v_schedule
    from public.work_schedules as schedule
    where schedule.id = v_target.schedule_id
      and schedule.user_id = v_almar_user_id
      and schedule.shift_date = v_target.work_date
      and schedule.shift_sequence = 1
    for update;

    if not found
       or v_schedule.status <> 'changed'
       or v_schedule.schedule_version <> v_target.expected_schedule_version
       or v_schedule.updated_at <> v_target.expected_schedule_updated_at
       or v_schedule.timezone <> 'America/New_York'
       or v_schedule.is_rest_day
       or v_schedule.is_holiday
       or (
         v_target.expected_schedule_mode = 'open'
         and (
           v_schedule.shift_start is not null
           or v_schedule.shift_end is not null
           or v_schedule.planned_paid_minutes <> 480
         )
       )
       or (
         v_target.expected_schedule_mode = 'fixed'
         and (
           v_schedule.shift_start is distinct from v_target.prepaid_start
           or v_schedule.shift_end is distinct from v_target.prepaid_end
           or v_schedule.planned_paid_minutes is not null
         )
       ) then
      raise exception
        'Almar schedule changed after workbook validation for %.',
        v_target.work_date;
    end if;

    select snapshot.*
    into v_old_snapshot
    from public.payroll_schedule_snapshots as snapshot
    where snapshot.id = v_target.old_snapshot_id
      and snapshot.payroll_record_id = v_almar_payroll_record_id
      and snapshot.employee_id = v_almar_user_id
      and snapshot.schedule_id = v_target.schedule_id
      and snapshot.work_date = v_target.work_date
      and snapshot.schedule_version = 2;

    if not found then
      raise exception 'The stale Almar prepaid snapshot is missing for %.',
        v_target.work_date;
    end if;

    select prepaid.*
    into v_old_prepaid
    from public.payroll_prepaid_hours as prepaid
    where prepaid.id = v_target.old_prepaid_hour_id
      and prepaid.source_schedule_snapshot_id = v_old_snapshot.id
      and prepaid.prepaid_minutes = 1080
    for update;

    if not found
       or v_old_prepaid.voided_at is not null
       or v_old_prepaid.settled_minutes <> 0
       or v_old_prepaid.superseded_by_id is not null then
      raise exception 'The stale Almar prepaid balance changed for %.',
        v_target.work_date;
    end if;

    if exists (
      select 1
      from public.payroll_schedule_snapshots as snapshot
      where snapshot.payroll_record_id = v_almar_payroll_record_id
        and snapshot.schedule_id = v_schedule.id
        and snapshot.schedule_version = v_schedule.schedule_version
    ) then
      raise exception 'The current Almar prepaid version already exists for %.',
        v_target.work_date;
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
      source_reference,
      source_metadata
    ) values (
      v_almar_payroll_record_id,
      v_schedule.id,
      v_almar_user_id,
      v_target.work_date,
      v_target.prepaid_start,
      v_target.prepaid_end,
      v_schedule.timezone,
      v_schedule.status,
      false,
      false,
      null,
      v_schedule.schedule_version,
      v_schedule.updated_at,
      v_actor_profile_user_id,
      statement_timestamp(),
      'Approved after final workbook, schedule-version, attendance, and payroll-readiness validation.',
      'excel_import',
      '2026 Support Timesheet.xlsx|ALMAR|' ||
        v_target.source_row::text || '|' || v_revision,
      jsonb_build_object(
        'workbook', '2026 Support Timesheet.xlsx',
        'sheet', 'ALMAR',
        'row', v_target.source_row,
        'source_columns', 'E:F (LOG IN / LOG OUT)',
        'source_sha256', v_source_hash,
        'revision', v_revision,
        'schedule_mode', v_target.expected_schedule_mode,
        'supersedes_snapshot_id', v_old_snapshot.id
      )
    )
    returning id into v_new_snapshot_id;

    select prepaid.*
    into v_new_prepaid
    from public.payroll_prepaid_hours as prepaid
    where prepaid.source_schedule_snapshot_id = v_new_snapshot_id;

    if not found
       or v_new_prepaid.prepaid_minutes <> 1080
       or v_new_prepaid.settled_minutes <> 0
       or v_new_prepaid.voided_at is not null then
      raise exception 'The current Almar prepaid balance was not created for %.',
        v_target.work_date;
    end if;

    select prepaid.*
    into v_old_prepaid
    from public.payroll_prepaid_hours as prepaid
    where prepaid.id = v_target.old_prepaid_hour_id;

    if v_old_prepaid.voided_at is null
       or v_old_prepaid.superseded_by_id <> v_new_prepaid.id then
      raise exception 'The stale Almar prepaid balance was not superseded for %.',
        v_target.work_date;
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
    ) values (
      v_actor_profile_user_id,
      'payroll_preplot_corrected',
      'payroll_schedule_snapshot',
      v_new_snapshot_id,
      v_period_id,
      v_almar_payroll_record_id,
      jsonb_build_object(
        'schedule_snapshot_id', v_old_snapshot.id,
        'prepaid_hour_id', v_target.old_prepaid_hour_id,
        'schedule_version', v_old_snapshot.schedule_version,
        'scheduled_minutes', v_old_snapshot.scheduled_minutes
      ),
      jsonb_build_object(
        'schedule_snapshot_id', v_new_snapshot_id,
        'prepaid_hour_id', v_new_prepaid.id,
        'schedule_version', v_schedule.schedule_version,
        'scheduled_minutes', v_new_prepaid.prepaid_minutes
      ),
      'Aligned Almar prepaid approval with the current schedule version using the validated workbook window.',
      jsonb_build_object(
        'source', 'payroll_owner_validation',
        'workbook', '2026 Support Timesheet.xlsx',
        'sheet', 'ALMAR',
        'row', v_target.source_row,
        'source_sha256', v_source_hash
      )
    );
  end loop;

  select count(*)
  into v_blocking_exception_count
  from public.payroll_get_period_exceptions(v_period_id) as issue
  where issue.is_blocking;

  if v_blocking_exception_count <> 0 then
    raise exception
      'Expected zero blocking exceptions before attendance import, found %.',
      v_blocking_exception_count;
  end if;

  v_import_result := public.payroll_import_attendance(v_period_id);

  if (v_import_result ->> 'employee_record_count')::integer <> 9
     or (v_import_result ->> 'payroll_ready_attendance_count')::integer <> 115
     or (v_import_result ->> 'new_snapshot_count')::integer <> 115
     or (v_import_result ->> 'current_snapshot_count')::integer <> 115
     or (v_import_result ->> 'records_with_snapshots')::integer <> 9
     or (v_import_result ->> 'incomplete_attendance_count')::integer <> 0
     -- This legacy import diagnostic counts 14 schedules without attendance
     -- before the approved-preplot exemption. The authoritative readiness RPC
     -- above and the exception function below both require zero final blockers.
     or (v_import_result ->> 'missing_attendance_count')::integer <> 14 then
    raise exception 'Unexpected July attendance import result: %.',
      v_import_result;
  end if;

  select count(*)
  into v_blocking_exception_count
  from public.payroll_get_period_exceptions(v_period_id) as issue
  where issue.is_blocking;

  if v_blocking_exception_count <> 0 then
    raise exception
      'Expected zero blocking exceptions before draft calculation, found %.',
      v_blocking_exception_count;
  end if;

  v_calculation_result := public.payroll_calculate_draft(v_period_id);

  if (v_calculation_result ->> 'record_count')::integer <> 9
     or (v_calculation_result ->> 'item_count')::integer <= 0
     or (v_calculation_result ->> 'blocking_exception_count')::integer <> 0
     or (v_calculation_result ->> 'gross_pay')::numeric <= 0
     or (v_calculation_result ->> 'total_deductions')::numeric < 0
     or (v_calculation_result ->> 'net_pay')::numeric < 0
     or (v_calculation_result ->> 'gross_pay')::numeric
       - (v_calculation_result ->> 'total_deductions')::numeric
       <> (v_calculation_result ->> 'net_pay')::numeric
     or v_calculation_result ->> 'currency_code' <> 'USD' then
    raise exception 'Unexpected July draft calculation result: %.',
      v_calculation_result;
  end if;

  select
    count(*),
    count(*) filter (
      where record.status = 'ready_for_review'
        and record.calculated_at is not null
        and not record.requires_recalculation
    )
  into v_record_count, v_ready_record_count
  from public.payroll_records as record
  join public.profiles as profile
    on profile.user_id = record.employee_id
  where record.payroll_period_id = v_period_id
    and record.status <> 'void'
    and profile.is_payroll_eligible;

  if v_record_count <> 9 or v_ready_record_count <> 9 then
    raise exception
      'Expected nine calculated records ready for review, found % of %.',
      v_ready_record_count,
      v_record_count;
  end if;

  select count(*)
  into v_current_attendance_snapshot_count
  from public.payroll_attendance_snapshots as snapshot
  join public.payroll_records as record
    on record.id = snapshot.payroll_record_id
  join public.attendance as attendance_row
    on attendance_row.id = snapshot.attendance_id
   and attendance_row.attendance_version = snapshot.attendance_version
  where record.payroll_period_id = v_period_id;

  if v_current_attendance_snapshot_count <> 115 then
    raise exception
      'Expected 115 current attendance snapshots, found %.',
      v_current_attendance_snapshot_count;
  end if;

  if not exists (
    select 1
    from public.payroll_periods as period
    where period.id = v_period_id
      and period.status = 'draft'
      and period.reviewed_at is null
      and period.approved_at is null
      and period.finalized_at is null
  ) then
    raise exception 'The payroll period did not remain an unapproved draft.';
  end if;

  if (
    select count(*)
    from public.payroll_audit_logs as audit
    where audit.payroll_period_id = v_period_id
      and audit.actor_user_id = v_actor_profile_user_id
      and audit.created_at >= v_started_at
      and audit.action = 'payroll_preplot_corrected'
  ) <> 4 then
    raise exception 'Expected four audited Almar prepaid corrections.';
  end if;

  if not exists (
    select 1
    from public.payroll_audit_logs as audit
    where audit.payroll_period_id = v_period_id
      and audit.actor_user_id = v_actor_profile_user_id
      and audit.created_at >= v_started_at
      and audit.action = 'payroll_attendance_imported'
  ) or not exists (
    select 1
    from public.payroll_audit_logs as audit
    where audit.payroll_period_id = v_period_id
      and audit.actor_user_id = v_actor_profile_user_id
      and audit.created_at >= v_started_at
      and audit.action = 'payroll_draft_calculated'
  ) then
    raise exception 'The attendance import or draft calculation audit is missing.';
  end if;
end;
$$;

commit;
