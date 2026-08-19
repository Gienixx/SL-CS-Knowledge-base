-- Approve Arby's workbook-aligned July 30 attendance, import the corrected
-- July 29-30 versions, and recalculate the July 16-31 payroll Draft.
-- The period remains unapproved and unfinalized.

begin;

set local statement_timeout = '30s';

-- Permit the calculator to consume the record-level recalculation marker after
-- all changed attendance versions have been re-imported. Stale snapshots remain
-- blocking until import completes.
do $patch$
declare
  v_definition text;
  v_old constant text := $needle$  where issue.is_blocking;$needle$;
  v_new constant text := $replacement$  where issue.is_blocking
    and not (
      issue.exception_code = 'changed_attendance_after_import'
      and issue.attendance_id is null
      and coalesce(
        (issue.details ->> 'latest_attendance_versions_imported')::boolean,
        false
      )
    );$replacement$;
begin
  select pg_get_functiondef(
    'public.payroll_calculate_draft(uuid)'::regprocedure
  )
  into v_definition;

  if v_definition is null
     or (length(v_definition) - length(replace(v_definition, v_old, '')))
        / length(v_old) <> 1 then
    raise exception 'The payroll calculator blocker guard changed unexpectedly.';
  end if;

  execute replace(v_definition, v_old, v_new);
end;
$patch$;


do $$
declare
  v_actor constant uuid := '7859dcc5-7a77-4850-bc91-1db5d9e0dd90'::uuid;
  v_period_id constant uuid := '9b47142d-37fc-4d19-91f6-011667352114'::uuid;
  v_arby_user_id constant uuid := 'f69a9e68-5507-4132-af60-e7cc1255d8c2'::uuid;
  v_arby_record_id constant uuid := '0fb2cc53-2f4e-45d9-afd0-8c8fa559e31f'::uuid;
  v_july29_id constant uuid := '5500d169-236c-4212-9818-12449cddda55'::uuid;
  v_july30_id constant uuid := 'f965267f-e3fa-46a2-8cb1-92fc257eee0b'::uuid;
  v_started_at constant timestamptz := statement_timestamp();
  v_period public.payroll_periods%rowtype;
  v_attendance public.attendance%rowtype;
  v_record public.payroll_records%rowtype;
  v_import_result jsonb;
  v_calculation_result jsonb;
  v_count bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('approve_import_recalculate_arby_july_29_30:20260803', 0)
  );

  perform pg_catalog.set_config('request.jwt.claim.sub', v_actor::text, true);
  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_actor, 'role', 'authenticated')::text,
    true
  );

  if public.workforce_current_profile_id() <> v_actor
     or not public.workforce_current_user_is_active()
     or not public.workforce_is_admin()
     or not public.workforce_has_permission('approve_attendance')
     or not public.workforce_has_permission('create_payroll') then
    raise exception 'The expected administrator cannot approve attendance and calculate payroll.';
  end if;

  select p.*
  into v_period
  from public.payroll_periods p
  where p.id = v_period_id
  for update;

  if not found
     or v_period.period_start <> date '2026-07-16'
     or v_period.period_end <> date '2026-07-31'
     or v_period.status <> 'draft'
     or v_period.approved_at is not null
     or v_period.finalized_at is not null then
    raise exception 'The July 16-31 payroll period changed after validation.';
  end if;

  if not exists (
    select 1
    from public.attendance a
    join public.workforce_attendance_payroll_readiness r on r.id = a.id
    where a.id = v_july29_id
      and a.user_id = v_arby_user_id
      and a.work_date = date '2026-07-29'
      and a.clock_in = make_timestamptz(2026, 7, 29, 0, 0, 0, 'America/New_York')
      and a.clock_out = make_timestamptz(2026, 7, 29, 18, 0, 0, 'America/New_York')
      and a.attendance_status = 'present'
      and a.review_status = 'approved'
      and a.attendance_version = 8
      and a.regular_minutes = 480
      and a.pre_shift_overtime_minutes = 600
      and a.post_shift_overtime_minutes = 0
      and a.total_worked_minutes = 1080
      and r.is_payroll_ready
  ) then
    raise exception 'Arby July 29 no longer matches the validated workbook record.';
  end if;

  select a.*
  into v_attendance
  from public.attendance a
  where a.id = v_july30_id
    and a.user_id = v_arby_user_id
  for update;

  if not found
     or v_attendance.work_date <> date '2026-07-30'
     or v_attendance.clock_in <> make_timestamptz(2026, 7, 30, 0, 30, 0, 'America/New_York')
     or v_attendance.clock_out <> make_timestamptz(2026, 7, 30, 18, 30, 0, 'America/New_York')
     or v_attendance.attendance_status <> 'present'
     or v_attendance.review_status <> 'approved'
     or v_attendance.attendance_version <> 14
     or v_attendance.regular_minutes <> 480
     or v_attendance.pre_shift_overtime_minutes <> 570
     or v_attendance.post_shift_overtime_minutes <> 30
     or v_attendance.total_worked_minutes <> 1080 then
    raise exception 'Arby July 30 no longer matches the corrected workbook record.';
  end if;

  if not exists (
    select 1
    from public.workforce_attendance_payroll_readiness r
    where r.id = v_july30_id
      and r.is_payroll_ready
      and coalesce(array_length(r.payroll_readiness_blockers, 1), 0) = 0
  ) then
    raise exception 'Arby July 30 is not payroll ready after approval.';
  end if;

  select count(*)
  into v_count
  from public.payroll_get_period_exceptions(v_period_id) issue
  where issue.is_blocking
    and issue.exception_code = 'changed_attendance_after_import'
    and issue.attendance_id in (v_july29_id, v_july30_id);

  if v_count <> 2 or (
    select count(*)
    from public.payroll_get_period_exceptions(v_period_id) issue
    where issue.is_blocking
  ) <> 2 then
    raise exception 'Expected only the two validated stale Arby attendance snapshots before import.';
  end if;

  v_import_result := public.payroll_import_attendance(v_period_id);

  if (v_import_result ->> 'employee_record_count')::integer <> 9
     or (v_import_result ->> 'payroll_ready_attendance_count')::integer <> 115
     or (v_import_result ->> 'new_snapshot_count')::integer <> 2
     or (v_import_result ->> 'current_snapshot_count')::integer <> 115
     or (v_import_result ->> 'records_with_snapshots')::integer <> 9
     or (v_import_result ->> 'incomplete_attendance_count')::integer <> 0
     or (v_import_result ->> 'missing_attendance_count')::integer <> 14 then
    raise exception 'Unexpected July attendance import result: %.', v_import_result;
  end if;

  if not exists (
    select 1 from public.payroll_attendance_snapshots s
    where s.attendance_id = v_july29_id and s.attendance_version = 8
      and s.clock_in = make_timestamptz(2026, 7, 29, 0, 0, 0, 'America/New_York')
      and s.clock_out = make_timestamptz(2026, 7, 29, 18, 0, 0, 'America/New_York')
  ) or not exists (
    select 1 from public.payroll_attendance_snapshots s
    where s.attendance_id = v_july30_id and s.attendance_version = 14
      and s.clock_in = make_timestamptz(2026, 7, 30, 0, 30, 0, 'America/New_York')
      and s.clock_out = make_timestamptz(2026, 7, 30, 18, 30, 0, 'America/New_York')
  ) then
    raise exception 'The corrected Arby attendance snapshots were not imported.';
  end if;

  v_calculation_result := public.payroll_calculate_draft(v_period_id);

  if (v_calculation_result ->> 'record_count')::integer <> 9
     or (v_calculation_result ->> 'blocking_exception_count')::integer <> 0
     or v_calculation_result ->> 'currency_code' <> 'USD' then
    raise exception 'Unexpected July draft calculation result: %.', v_calculation_result;
  end if;

  select r.*
  into v_record
  from public.payroll_records r
  where r.id = v_arby_record_id;

  if not found
     or v_record.employee_id <> v_arby_user_id
     or v_record.status <> 'ready_for_review'
     or v_record.calculation_version <> 2
     or v_record.requires_recalculation
     or v_record.calculated_at is null then
    raise exception 'Arby payroll record was not recalculated cleanly.';
  end if;

  select count(*)
  into v_count
  from public.payroll_attendance_snapshots s
  join public.payroll_records r on r.id = s.payroll_record_id
  join public.attendance a
    on a.id = s.attendance_id
   and a.attendance_version = s.attendance_version
  where r.payroll_period_id = v_period_id;

  if v_count <> 115 then
    raise exception 'Expected 115 current attendance snapshots, found %.', v_count;
  end if;

  if not exists (
    select 1
    from public.payroll_periods p
    where p.id = v_period_id
      and p.status = 'draft'
      and p.approved_at is null
      and p.finalized_at is null
  ) then
    raise exception 'The payroll period did not remain an unapproved Draft.';
  end if;

  if not exists (
    select 1
    from public.payroll_audit_logs l
    where l.payroll_period_id = v_period_id
      and l.actor_user_id = v_actor
      and l.created_at >= v_started_at
      and l.action = 'payroll_attendance_imported'
  ) or not exists (
    select 1
    from public.payroll_audit_logs l
    where l.payroll_period_id = v_period_id
      and l.actor_user_id = v_actor
      and l.created_at >= v_started_at
      and l.action = 'payroll_draft_calculated'
  ) then
    raise exception 'The payroll import or calculation audit entry is missing.';
  end if;
end;
$$;

commit;
