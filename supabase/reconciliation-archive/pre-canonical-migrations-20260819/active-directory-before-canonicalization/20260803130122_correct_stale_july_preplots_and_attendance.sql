-- Replace seven unsettled July prepaid snapshots whose approved workbook
-- values no longer match the latest payroll validation. The old snapshots and
-- balances remain immutable audit history; inserting each corrected schedule
-- version creates a replacement balance and supersedes its unsettled prior
-- balance through payroll_create_prepaid_balance().
--
-- Also record Arez's completed July 31 attendance and move Arby's already-
-- correct overnight punches from the July 26 rest-day record to the confirmed
-- July 27 rest-day shift.

begin;

set local statement_timeout = '30s';

do $$
declare
  v_source_hash constant text :=
    '949d4e4547f92829a3a631e8d7b4712e45fedeac8a1ad14245cdcd231b47d590';
  v_revision constant text := 'validation-20260803';
  v_actor_user_id uuid;
  v_actor_count integer;
  v_target record;
  v_schedule_before public.work_schedules%rowtype;
  v_schedule_after public.work_schedules%rowtype;
  v_old_snapshot public.payroll_schedule_snapshots%rowtype;
  v_old_prepaid public.payroll_prepaid_hours%rowtype;
  v_new_snapshot_id uuid;
  v_new_prepaid public.payroll_prepaid_hours%rowtype;
  v_arez_schedule public.work_schedules%rowtype;
  v_arez_attendance public.attendance%rowtype;
  v_arby_attendance_before public.attendance%rowtype;
  v_arby_attendance_after public.attendance%rowtype;
  v_arby_target_schedule public.work_schedules%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'correct_stale_july_preplots_and_attendance:20260803',
      0
    )
  );

  select count(*)::integer
  into v_actor_count
  from public.profiles as profile
  where profile.is_system_admin
    and profile.employment_status = 'active';

  if v_actor_count <> 1 then
    raise exception
      'Expected exactly one active system administrator, found %.',
      v_actor_count;
  end if;

  select profile.user_id
  into v_actor_user_id
  from public.profiles as profile
  where profile.is_system_admin
    and profile.employment_status = 'active';

  -- Lock and process target schedules in a stable order. Updating the source
  -- schedule advances schedule_version without replacing its ordinary fixed
  -- shift boundaries; the corrected Excel login/logout window belongs to the
  -- prepaid snapshot.
  for v_target in
    select *
    from (
      values
        (
          '4ef939ab-b320-4d72-934a-a9093c9fe159'::uuid,
          'ddeb2e37-2ae6-4caa-9117-9fdb4db54f2a'::uuid,
          date '2026-07-28',
          'TRISTAN'::text,
          283,
          make_timestamptz(2026, 7, 28, 22, 30, 0, 'America/New_York'),
          make_timestamptz(2026, 7, 29, 14, 30, 0, 'America/New_York'),
          'Latest workbook validation changed the prepaid window.'::text
        ),
        (
          'c8175637-89e1-47d5-ab6d-684538993b6f'::uuid,
          '29289052-122a-4a3d-a6e5-c45f461d7c2e'::uuid,
          date '2026-07-29',
          'AMOR'::text,
          284,
          make_timestamptz(2026, 7, 29, 19, 0, 0, 'America/New_York'),
          make_timestamptz(2026, 7, 30, 9, 0, 0, 'America/New_York'),
          'Latest workbook validation changed the prepaid logout.'::text
        ),
        (
          'cee9dc5d-e65a-4fed-93a4-11cd8e0837eb'::uuid,
          'd0118de4-b191-43f3-9162-c16f85927154'::uuid,
          date '2026-07-29',
          'AREZ'::text,
          284,
          make_timestamptz(2026, 7, 29, 8, 45, 0, 'America/New_York'),
          make_timestamptz(2026, 7, 30, 2, 45, 0, 'America/New_York'),
          'Latest workbook validation changed the prepaid login and logout.'::text
        ),
        (
          '46653896-773f-42ff-a34b-777d65d80a76'::uuid,
          'd0118de4-b191-43f3-9162-c16f85927154'::uuid,
          date '2026-07-30',
          'AREZ'::text,
          285,
          make_timestamptz(2026, 7, 30, 10, 0, 0, 'America/New_York'),
          make_timestamptz(2026, 7, 31, 2, 0, 0, 'America/New_York'),
          'Latest workbook validation changed the prepaid logout.'::text
        ),
        (
          'bc9f2b83-6246-4aff-b2d8-c81c4652650b'::uuid,
          '29289052-122a-4a3d-a6e5-c45f461d7c2e'::uuid,
          date '2026-07-30',
          'AMOR'::text,
          285,
          make_timestamptz(2026, 7, 30, 21, 0, 0, 'America/New_York'),
          make_timestamptz(2026, 7, 31, 5, 0, 0, 'America/New_York'),
          'Latest workbook validation changed the prepaid login and logout.'::text
        ),
        (
          'eeee0fa8-20b1-46c7-9265-832f1cda489c'::uuid,
          'b303c569-c808-409f-958e-7bc89868b07f'::uuid,
          date '2026-07-30',
          'JERSON'::text,
          285,
          make_timestamptz(2026, 7, 30, 10, 30, 0, 'America/New_York'),
          make_timestamptz(2026, 7, 31, 2, 30, 0, 'America/New_York'),
          'Latest workbook validation changed the prepaid login and logout.'::text
        ),
        (
          '42231ca8-5bf9-42e3-a21e-ccc53b4743ec'::uuid,
          'd0118de4-b191-43f3-9162-c16f85927154'::uuid,
          date '2026-07-31',
          'AREZ'::text,
          286,
          make_timestamptz(2026, 7, 31, 14, 0, 0, 'America/New_York'),
          make_timestamptz(2026, 8, 1, 2, 0, 0, 'America/New_York'),
          'Payroll owner confirmed the missing logout as 2:00 AM on August 1.'::text
        )
    ) as target(
      schedule_id,
      employee_user_id,
      work_date,
      source_sheet,
      source_row,
      corrected_start,
      corrected_end,
      correction_note
    )
    order by schedule_id
  loop
    select schedule.*
    into v_schedule_before
    from public.work_schedules as schedule
    where schedule.id = v_target.schedule_id
      and schedule.user_id = v_target.employee_user_id
      and schedule.shift_date = v_target.work_date
      and schedule.shift_sequence = 1
    for update;

    if not found then
      raise exception 'Expected source schedule was not found for % row %.',
        v_target.source_sheet,
        v_target.source_row;
    end if;

    if v_schedule_before.status <> 'published'
       or v_schedule_before.schedule_version <> 1
       or v_schedule_before.is_rest_day
       or v_schedule_before.is_holiday
       or v_schedule_before.planned_paid_minutes is not null
       or v_schedule_before.timezone <> 'America/New_York' then
      raise exception
        'Source schedule changed after validation for % row %; refusing to overwrite it.',
        v_target.source_sheet,
        v_target.source_row;
    end if;

    select snapshot.*
    into v_old_snapshot
    from public.payroll_schedule_snapshots as snapshot
    where snapshot.schedule_id = v_schedule_before.id
      and snapshot.employee_id = v_schedule_before.user_id
      and snapshot.schedule_version = v_schedule_before.schedule_version
      and snapshot.source_type = 'excel_import'
      and snapshot.source_reference =
        '2026 Support Timesheet.xlsx|' ||
        v_target.source_sheet || '|' ||
        v_target.source_row::text;

    if not found then
      raise exception 'Expected stale prepaid snapshot was not found for % row %.',
        v_target.source_sheet,
        v_target.source_row;
    end if;

    select prepaid.*
    into v_old_prepaid
    from public.payroll_prepaid_hours as prepaid
    where prepaid.source_schedule_snapshot_id = v_old_snapshot.id
    for update;

    if not found
       or v_old_prepaid.voided_at is not null
       or v_old_prepaid.settled_minutes <> 0 then
      raise exception
        'The stale prepaid balance for % row % is missing, voided, or already settled.',
        v_target.source_sheet,
        v_target.source_row;
    end if;

    if exists (
      select 1
      from public.attendance as attendance_row
      where attendance_row.user_id = v_target.employee_user_id
        and attendance_row.work_date = v_target.work_date
    ) then
      raise exception
        'Attendance already exists for % row %; refusing prepaid-only correction.',
        v_target.source_sheet,
        v_target.source_row;
    end if;

    update public.work_schedules
    set
      status = 'changed',
      updated_by = v_actor_user_id,
      updated_at = statement_timestamp()
    where id = v_schedule_before.id
    returning * into v_schedule_after;

    if v_schedule_after.schedule_version <> v_schedule_before.schedule_version + 1 then
      raise exception 'Schedule version did not advance for % row %.',
        v_target.source_sheet,
        v_target.source_row;
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
      v_old_snapshot.payroll_record_id,
      v_schedule_after.id,
      v_schedule_after.user_id,
      v_target.work_date,
      v_target.corrected_start,
      v_target.corrected_end,
      v_schedule_after.timezone,
      v_schedule_after.status,
      false,
      false,
      null,
      v_schedule_after.schedule_version,
      v_schedule_after.updated_at,
      v_actor_user_id,
      statement_timestamp(),
      'Corrected stale July 2026 prepaid schedule after payroll-owner validation.',
      'excel_import',
      '2026 Support Timesheet.xlsx|' ||
        v_target.source_sheet || '|' ||
        v_target.source_row::text || '|' ||
        v_revision,
      jsonb_build_object(
        'workbook', '2026 Support Timesheet.xlsx',
        'sheet', v_target.source_sheet,
        'row', v_target.source_row,
        'source_columns', 'E:F (LOG IN / LOG OUT)',
        'source_sha256', v_source_hash,
        'revision', v_revision,
        'correction_note', v_target.correction_note,
        'supersedes_snapshot_id', v_old_snapshot.id
      )
    )
    returning id into v_new_snapshot_id;

    select prepaid.*
    into v_new_prepaid
    from public.payroll_prepaid_hours as prepaid
    where prepaid.source_schedule_snapshot_id = v_new_snapshot_id;

    if not found
       or v_new_prepaid.voided_at is not null
       or v_new_prepaid.prepaid_minutes <> (
         extract(epoch from (
           v_target.corrected_end - v_target.corrected_start
         )) / 60
       )::integer then
      raise exception 'Corrected prepaid balance was not created for % row %.',
        v_target.source_sheet,
        v_target.source_row;
    end if;

    select prepaid.*
    into v_old_prepaid
    from public.payroll_prepaid_hours as prepaid
    where prepaid.id = v_old_prepaid.id;

    if v_old_prepaid.voided_at is null
       or v_old_prepaid.superseded_by_id <> v_new_prepaid.id then
      raise exception 'Stale prepaid balance was not superseded for % row %.',
        v_target.source_sheet,
        v_target.source_row;
    end if;

    insert into public.workforce_audit_logs (
      actor_user_id,
      action,
      entity_type,
      entity_id,
      before_data,
      after_data,
      reason
    ) values (
      v_actor_user_id,
      'timesheet_prepaid_schedule_correction',
      'work_schedule',
      v_schedule_after.id,
      jsonb_build_object(
        'schedule_version', v_schedule_before.schedule_version,
        'status', v_schedule_before.status
      ),
      jsonb_build_object(
        'schedule_version', v_schedule_after.schedule_version,
        'status', v_schedule_after.status,
        'prepaid_shift_start', v_target.corrected_start,
        'prepaid_shift_end', v_target.corrected_end,
        'source_sheet', v_target.source_sheet,
        'source_row', v_target.source_row,
        'new_snapshot_id', v_new_snapshot_id
      ),
      v_target.correction_note
    );

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
    select
      v_actor_user_id,
      'payroll_preplot_corrected',
      'payroll_schedule_snapshot',
      v_new_snapshot_id,
      record.payroll_period_id,
      v_old_snapshot.payroll_record_id,
      jsonb_build_object(
        'schedule_snapshot_id', v_old_snapshot.id,
        'prepaid_hour_id', v_old_prepaid.id,
        'scheduled_minutes', v_old_snapshot.scheduled_minutes
      ),
      jsonb_build_object(
        'schedule_snapshot_id', v_new_snapshot_id,
        'prepaid_hour_id', v_new_prepaid.id,
        'scheduled_minutes', v_new_prepaid.prepaid_minutes
      ),
      v_target.correction_note,
      jsonb_build_object(
        'source', 'payroll_owner_validation',
        'workbook', '2026 Support Timesheet.xlsx',
        'sheet', v_target.source_sheet,
        'row', v_target.source_row,
        'source_sha256', v_source_hash
      )
    from public.payroll_records as record
    where record.id = v_old_snapshot.payroll_record_id;
  end loop;

  -- The corrected July 31 Arez snapshot must exist before attendance is added,
  -- because prepaid approval intentionally rejects dates that already have
  -- attendance.
  select schedule.*
  into v_arez_schedule
  from public.work_schedules as schedule
  where schedule.id = '42231ca8-5bf9-42e3-a21e-ccc53b4743ec'::uuid
    and schedule.user_id = 'd0118de4-b191-43f3-9162-c16f85927154'::uuid
    and schedule.shift_date = date '2026-07-31'
  for update;

  if not found or v_arez_schedule.schedule_version <> 2 then
    raise exception 'Corrected Arez July 31 schedule version was not found.';
  end if;

  if exists (
    select 1
    from public.attendance as attendance_row
    where attendance_row.user_id = v_arez_schedule.user_id
      and attendance_row.work_date = v_arez_schedule.shift_date
  ) then
    raise exception 'Arez July 31 attendance already exists.';
  end if;

  insert into public.attendance (
    user_id,
    schedule_id,
    work_date,
    clock_in,
    clock_out,
    attendance_status,
    correction_reason,
    admin_notes,
    corrected_by,
    corrected_at,
    review_status,
    reviewed_by,
    reviewed_at,
    is_corrected,
    created_by,
    updated_by
  ) values (
    v_arez_schedule.user_id,
    v_arez_schedule.id,
    date '2026-07-31',
    make_timestamptz(2026, 7, 31, 14, 0, 0, 'America/New_York'),
    make_timestamptz(2026, 8, 1, 2, 0, 0, 'America/New_York'),
    'present',
    'Complete missing July 31 attendance from payroll-owner validation.',
    'Workbook AREZ row 286 login is 2:00 PM; payroll owner confirmed the following-day logout as 2:00 AM.',
    v_actor_user_id,
    statement_timestamp(),
    'corrected',
    v_actor_user_id,
    statement_timestamp(),
    true,
    v_actor_user_id,
    v_actor_user_id
  )
  returning * into v_arez_attendance;

  select *
  into v_arez_attendance
  from public.workforce_recalculate_attendance(v_arez_attendance.id);

  insert into public.workforce_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    after_data,
    reason
  ) values (
    v_actor_user_id,
    'manual_attendance_created',
    'attendance',
    v_arez_attendance.id,
    jsonb_build_object(
      'employee_user_id', v_arez_attendance.user_id,
      'schedule_id', v_arez_attendance.schedule_id,
      'work_date', v_arez_attendance.work_date,
      'clock_in', v_arez_attendance.clock_in,
      'clock_out', v_arez_attendance.clock_out,
      'attendance_status', v_arez_attendance.attendance_status,
      'source_sheet', 'AREZ',
      'source_row', 286,
      'source_sha256', v_source_hash
    ),
    'Completed Arez July 31 attendance using the payroll-owner-confirmed 2:00 AM logout.'
  );

  -- Arby's punches were already correct; only their work-date and rest-day
  -- schedule association were one day early.
  select attendance_row.*
  into v_arby_attendance_before
  from public.attendance as attendance_row
  where attendance_row.id = '88e48557-f36e-45c3-b033-475400247983'::uuid
    and attendance_row.user_id = 'f69a9e68-5507-4132-af60-e7cc1255d8c2'::uuid
  for update;

  if not found
     or v_arby_attendance_before.work_date <> date '2026-07-26'
     or v_arby_attendance_before.schedule_id <>
       'a1569d6a-b594-428e-afdb-593807cb4e23'::uuid
     or v_arby_attendance_before.clock_in <>
       make_timestamptz(2026, 7, 26, 22, 0, 0, 'America/New_York')
     or v_arby_attendance_before.clock_out <>
       make_timestamptz(2026, 7, 27, 18, 0, 0, 'America/New_York') then
    raise exception 'Arby July 26/27 attendance changed after validation.';
  end if;

  select schedule.*
  into v_arby_target_schedule
  from public.work_schedules as schedule
  where schedule.id = 'f1d3a5dd-1d35-49a2-a6de-fd2cdc28398a'::uuid
    and schedule.user_id = v_arby_attendance_before.user_id
    and schedule.shift_date = date '2026-07-27'
    and schedule.status = 'published'
    and schedule.is_rest_day
    and not schedule.is_holiday
  for update;

  if not found then
    raise exception 'Arby July 27 rest-day schedule was not found.';
  end if;

  if exists (
    select 1
    from public.attendance as attendance_row
    where attendance_row.user_id = v_arby_attendance_before.user_id
      and attendance_row.work_date = date '2026-07-27'
      and attendance_row.id <> v_arby_attendance_before.id
  ) then
    raise exception 'Another Arby July 27 attendance record already exists.';
  end if;

  update public.attendance
  set
    schedule_id = v_arby_target_schedule.id,
    work_date = date '2026-07-27',
    correction_reason =
      'Move confirmed overnight rest-day shift to its July 27 work date.',
    admin_notes = concat_ws(
      E'\n',
      nullif(trim(coalesce(admin_notes, '')), ''),
      'Payroll owner confirmed the shift ran 10:00 PM July 26 through 6:00 PM July 27.'
    ),
    corrected_by = v_actor_user_id,
    corrected_at = statement_timestamp(),
    review_status = 'corrected',
    reviewed_by = v_actor_user_id,
    reviewed_at = statement_timestamp(),
    is_corrected = true,
    updated_by = v_actor_user_id,
    updated_at = statement_timestamp()
  where id = v_arby_attendance_before.id
  returning * into v_arby_attendance_after;

  select *
  into v_arby_attendance_after
  from public.workforce_recalculate_attendance(v_arby_attendance_after.id);

  insert into public.workforce_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    before_data,
    after_data,
    reason
  ) values (
    v_actor_user_id,
    'attendance_work_date_corrected',
    'attendance',
    v_arby_attendance_after.id,
    jsonb_build_object(
      'schedule_id', v_arby_attendance_before.schedule_id,
      'work_date', v_arby_attendance_before.work_date,
      'clock_in', v_arby_attendance_before.clock_in,
      'clock_out', v_arby_attendance_before.clock_out,
      'attendance_version', v_arby_attendance_before.attendance_version
    ),
    jsonb_build_object(
      'schedule_id', v_arby_attendance_after.schedule_id,
      'work_date', v_arby_attendance_after.work_date,
      'clock_in', v_arby_attendance_after.clock_in,
      'clock_out', v_arby_attendance_after.clock_out,
      'attendance_version', v_arby_attendance_after.attendance_version,
      'source_sheet', 'ARBY',
      'source_row', 282,
      'source_sha256', v_source_hash
    ),
    'Corrected only the work-date and rest-day schedule association; the confirmed punches were preserved.'
  );
end;
$$;

commit;
