-- Wave 2A infrastructure-only forward migration.
-- Installs the previously validated generic existing-attendance correction RPC.
-- No employee/date-specific branching, fixture data, attendance repair, payroll
-- calculation, schedule mutation, or prepaid mutation is performed here.

create or replace function public.workforce_wave2a_correct_existing_attendance(
  p_period_id uuid,
  p_attendance_id uuid,
  p_actor_user_id uuid,
  p_expected_attendance_version bigint,
  p_expected_schedule_id uuid,
  p_expected_schedule_version bigint,
  p_expected_schedule_mode text,
  p_expected_schedule_shift_start timestamptz,
  p_expected_schedule_shift_end timestamptz,
  p_expected_schedule_timezone text,
  p_expected_schedule_is_rest_day boolean,
  p_expected_schedule_is_holiday boolean,
  p_expected_schedule_is_leave boolean,
  p_expected_schedule_is_absent boolean,
  p_expected_work_date date,
  p_expected_raw_clock_in timestamptz,
  p_expected_raw_clock_out timestamptz,
  p_expected_billed_clock_in timestamptz,
  p_expected_billed_clock_out timestamptz,
  p_expected_total_worked_minutes integer,
  p_expected_pre_shift_overtime_minutes integer,
  p_expected_regular_minutes integer,
  p_expected_post_shift_overtime_minutes integer,
  p_expected_rest_day_overtime_minutes integer,
  p_expected_holiday_overtime_minutes integer,
  p_expected_total_overtime_minutes integer,
  p_expected_attendance_status text,
  p_expected_review_status text,
  p_expected_payroll_approved_at timestamptz,
  p_expected_voided_at timestamptz,
  p_new_billed_clock_in timestamptz,
  p_new_billed_clock_out timestamptz,
  p_expected_new_billed_minutes integer,
  p_expected_payroll_record_count integer,
  p_expected_legacy_row_count bigint,
  p_expected_legacy_minutes bigint,
  p_source_reference text,
  p_workbook_evidence jsonb,
  p_reason text
)
returns table (
  attendance_id uuid,
  previous_attendance_version bigint,
  new_attendance_version bigint,
  previous_billed_clock_in timestamptz,
  previous_billed_clock_out timestamptz,
  new_billed_clock_in timestamptz,
  new_billed_clock_out timestamptz,
  canonical_billed_minutes integer,
  total_worked_minutes integer,
  review_status text,
  is_payroll_ready boolean,
  payroll_readiness_blockers text[]
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_period public.payroll_periods%rowtype;
  v_before public.attendance%rowtype;
  v_after public.attendance%rowtype;
  v_schedule public.work_schedules%rowtype;
  v_calculation record;
  v_readiness_before record;
  v_readiness_after record;
  v_other_overtime integer := 0;
  v_available_overtime integer := 1200;
  v_canonical integer;
begin
  if p_period_id <> 'b62ee64a-3da9-48d2-8c4e-f9856e352086'::uuid then
    raise exception 'Wave 2A canary is restricted to the Aug 1-15, 2026 payroll period.';
  end if;
  if p_period_id is null or p_attendance_id is null or p_actor_user_id is null then
    raise exception 'Period, attendance, and actor are required.';
  end if;
  if nullif(trim(coalesce(p_source_reference, '')), '') is null or p_workbook_evidence is null then
    raise exception 'Workbook source and evidence are required.';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'A correction reason is required.';
  end if;
  if p_new_billed_clock_in is null or p_new_billed_clock_out is null
     or p_new_billed_clock_out < p_new_billed_clock_in then
    raise exception 'New billed timestamps are invalid.';
  end if;
  if p_expected_new_billed_minutes is null or p_expected_new_billed_minutes <= 0 then
    raise exception 'Expected workbook billed minutes are required.';
  end if;
  if p_expected_schedule_mode is null
     or p_expected_schedule_mode not in ('rest_day', 'timed_workday') then
    raise exception 'Expected schedule mode must be rest_day or timed_workday.';
  end if;
  if p_expected_payroll_record_count is null
     or p_expected_legacy_row_count is null
     or p_expected_legacy_minutes is null then
    raise exception 'All period and legacy fingerprints are required.';
  end if;

  if not exists (
    select 1 from public.profiles actor
    where actor.user_id = p_actor_user_id
      and actor.is_system_admin is true
      and actor.account_deleted_at is null
  ) then
    raise exception 'A non-deleted system administrator actor is required.';
  end if;

  select * into v_period
  from public.payroll_periods
  where id = p_period_id
  for update;
  if not found or v_period.status <> 'draft' then
    raise exception 'Payroll period must exist and remain draft.';
  end if;
  if p_expected_work_date < v_period.period_start
     or p_expected_work_date > v_period.period_end then
    raise exception 'Attendance work date is outside the payroll period.';
  end if;

  if (select count(*) from public.payroll_records where payroll_period_id = p_period_id)
       <> p_expected_payroll_record_count
     or (select count(*) from public.payroll_records
         where payroll_period_id = p_period_id and status <> 'draft') <> 0 then
    raise exception 'Payroll period record/status guard failed.';
  end if;

  if exists (select 1 from public.payroll_items item
             join public.payroll_records record on record.id = item.payroll_record_id
             where record.payroll_period_id = p_period_id)
     or exists (select 1 from public.payroll_attendance_snapshots snapshot
                join public.payroll_records record on record.id = snapshot.payroll_record_id
                where record.payroll_period_id = p_period_id)
     or exists (select 1 from public.payroll_schedule_snapshots snapshot
                join public.payroll_records record on record.id = snapshot.payroll_record_id
                where record.payroll_period_id = p_period_id)
     or exists (select 1 from public.payroll_hour_allocations allocation
                join public.payroll_records record on record.id = allocation.destination_payroll_record_id
                where record.payroll_period_id = p_period_id)
     or exists (select 1 from public.payroll_prepaid_commitments commitment
                where commitment.payroll_period_id = p_period_id) then
    raise exception 'Payroll artifacts already exist for this period.';
  end if;

  if (select count(*) from public.payroll_prepaid_hours
      where commitment_id is null and voided_at is null) <> p_expected_legacy_row_count
     or (select coalesce(sum(remaining_minutes), 0) from public.payroll_prepaid_hours
         where commitment_id is null and voided_at is null) <> p_expected_legacy_minutes then
    raise exception 'Grandfathered legacy prepaid fingerprint changed.';
  end if;

  select * into v_before
  from public.attendance
  where id = p_attendance_id
  for update;
  if not found then raise exception 'Attendance record not found.'; end if;

  if v_before.attendance_version is distinct from p_expected_attendance_version
     or v_before.schedule_id is distinct from p_expected_schedule_id
     or v_before.work_date is distinct from p_expected_work_date
     or v_before.original_clock_in is distinct from p_expected_raw_clock_in
     or v_before.original_clock_out is distinct from p_expected_raw_clock_out
     or v_before.billed_clock_in is distinct from p_expected_billed_clock_in
     or v_before.billed_clock_out is distinct from p_expected_billed_clock_out
     or v_before.total_worked_minutes is distinct from p_expected_total_worked_minutes
     or v_before.pre_shift_overtime_minutes is distinct from p_expected_pre_shift_overtime_minutes
     or v_before.regular_minutes is distinct from p_expected_regular_minutes
     or v_before.post_shift_overtime_minutes is distinct from p_expected_post_shift_overtime_minutes
     or v_before.rest_day_overtime_minutes is distinct from p_expected_rest_day_overtime_minutes
     or v_before.holiday_overtime_minutes is distinct from p_expected_holiday_overtime_minutes
     or v_before.total_overtime_minutes is distinct from p_expected_total_overtime_minutes
     or v_before.attendance_status is distinct from p_expected_attendance_status
     or v_before.review_status is distinct from p_expected_review_status
     or v_before.payroll_approved_at is distinct from p_expected_payroll_approved_at
     or v_before.voided_at is distinct from p_expected_voided_at then
    raise exception 'Attendance before-state fingerprint changed.';
  end if;
  if v_before.review_status = 'corrected' or v_before.is_corrected then
    raise exception 'Attendance row was already corrected; repeat execution rejected.';
  end if;
  if v_before.voided_at is not null then
    raise exception 'Voided attendance cannot be corrected.';
  end if;

  select * into v_schedule
  from public.work_schedules
  where id = v_before.schedule_id
  for share;
  if not found or v_schedule.user_id <> v_before.user_id
     or v_schedule.schedule_version is distinct from p_expected_schedule_version
     or v_schedule.shift_date is distinct from v_before.work_date
     or v_schedule.shift_start is distinct from p_expected_schedule_shift_start
     or v_schedule.shift_end is distinct from p_expected_schedule_shift_end
     or v_schedule.timezone is distinct from p_expected_schedule_timezone
     or v_schedule.is_rest_day is distinct from p_expected_schedule_is_rest_day
     or v_schedule.is_holiday is distinct from p_expected_schedule_is_holiday
     or v_schedule.is_leave is distinct from p_expected_schedule_is_leave
     or v_schedule.is_absent is distinct from p_expected_schedule_is_absent then
    raise exception 'Schedule ownership/version/fingerprint guard failed.';
  end if;
  if p_expected_schedule_mode = 'rest_day' then
    if v_schedule.is_rest_day is distinct from true
       or v_schedule.is_holiday is distinct from false
       or v_schedule.is_leave is distinct from false
       or v_schedule.is_absent is distinct from false
       or v_schedule.shift_start is not null
       or v_schedule.shift_end is not null then
      raise exception 'Rest Day schedule mode guard failed.';
    end if;
  elsif v_schedule.is_rest_day is distinct from false
        or v_schedule.is_holiday is distinct from false
        or v_schedule.is_leave is distinct from false
        or v_schedule.is_absent is distinct from false
        or v_schedule.shift_start is null
        or v_schedule.shift_end is null then
    raise exception 'Timed workday schedule mode guard failed.';
  end if;

  if exists (
    select 1
    from public.attendance other
    where other.user_id = v_before.user_id
      and other.work_date = v_before.work_date
      and other.id <> v_before.id
      and other.voided_at is null
      and coalesce(other.billed_clock_in, other.clock_in) is not null
      and coalesce(other.billed_clock_out, other.clock_out) is not null
      and coalesce(other.billed_clock_in, other.clock_in) < p_new_billed_clock_out
      and p_new_billed_clock_in < coalesce(other.billed_clock_out, other.clock_out)
  ) then
    raise exception 'Duplicate or overlapping attendance record exists.';
  end if;

  select coalesce(sum(greatest(coalesce(other.total_overtime_minutes, 0), 0)), 0)::integer
    into v_other_overtime
  from public.attendance other
  where other.user_id = v_before.user_id
    and other.work_date = v_before.work_date
    and other.id <> v_before.id;
  v_available_overtime := greatest(0, 1200 - v_other_overtime);

  select * into v_calculation
  from public.workforce_calculate_attendance(
    v_schedule.shift_start,
    v_schedule.shift_end,
    p_new_billed_clock_in,
    p_new_billed_clock_out,
    v_before.work_date,
    v_schedule.timezone,
    v_available_overtime,
    v_schedule.is_rest_day,
    v_schedule.is_holiday
  );
  v_canonical := public.workforce_canonical_billed_minutes(
    p_new_billed_clock_in, p_new_billed_clock_out
  );
  if v_canonical is distinct from p_expected_new_billed_minutes
     or v_calculation.total_worked_minutes is distinct from v_canonical
     or v_calculation.regular_minutes + v_calculation.total_overtime_minutes is distinct from v_canonical
     or v_calculation.total_overtime_minutes is distinct from (
       v_calculation.pre_shift_overtime_minutes + v_calculation.post_shift_overtime_minutes
       + v_calculation.rest_day_overtime_minutes + v_calculation.holiday_overtime_minutes
     ) then
    raise exception 'Workbook duration or existing classification calculation is inconsistent.';
  end if;

  select readiness.* into v_readiness_before
  from public.workforce_attendance_payroll_readiness readiness
  where readiness.id = v_before.id;

  -- Exactly one attendance UPDATE. The trigger therefore increments the source
  -- version exactly once. The transaction-local flag prevents the storage
  -- trigger from replacing the new billed calculation with raw duration.
  -- Raw/original timestamps and schedule ownership are deliberately absent from
  -- the SET list.
  perform set_config('workforce.correction_recalculation', 'true', true);
  update public.attendance
  set billed_clock_in = p_new_billed_clock_in,
      billed_clock_out = p_new_billed_clock_out,
      pre_shift_overtime_minutes = v_calculation.pre_shift_overtime_minutes,
      regular_minutes = v_calculation.regular_minutes,
      post_shift_overtime_minutes = v_calculation.post_shift_overtime_minutes,
      rest_day_overtime_minutes = v_calculation.rest_day_overtime_minutes,
      holiday_overtime_minutes = v_calculation.holiday_overtime_minutes,
      total_overtime_minutes = v_calculation.total_overtime_minutes,
      overtime_minutes = v_calculation.total_overtime_minutes,
      total_worked_minutes = v_calculation.total_worked_minutes,
      minutes_late = v_calculation.minutes_late,
      is_late = v_calculation.minutes_late > 0,
      undertime_minutes = v_calculation.undertime_minutes,
      review_status = 'corrected',
      reviewed_by = null,
      reviewed_at = null,
      payroll_approved_at = null,
      correction_reason = 'wave2a_existing_attendance_workbook',
      corrected_by = p_actor_user_id,
      corrected_at = now(),
      is_corrected = true,
      updated_by = p_actor_user_id,
      updated_at = now()
  where id = v_before.id
  returning * into v_after;

  if v_after.attendance_version is distinct from v_before.attendance_version + 1
     or v_after.original_clock_in is distinct from v_before.original_clock_in
     or v_after.original_clock_out is distinct from v_before.original_clock_out
     or v_after.schedule_id is distinct from v_before.schedule_id
     or v_after.total_worked_minutes is distinct from v_canonical then
    raise exception 'Canary post-write invariant failed.';
  end if;

  select readiness.* into v_readiness_after
  from public.workforce_attendance_payroll_readiness readiness
  where readiness.id = v_after.id;
  if coalesce(v_readiness_after.is_payroll_ready, false) then
    raise exception 'Corrected attendance remained payroll-ready.';
  end if;

  perform set_config('workforce.correction_recalculation', 'false', true);

  insert into public.attendance_corrections (
    attendance_id, employee_user_id, schedule_id, previous_schedule_id, new_schedule_id,
    previous_clock_in, previous_clock_out, new_clock_in, new_clock_out,
    previous_billed_clock_in, previous_billed_clock_out,
    new_billed_clock_in, new_billed_clock_out,
    previous_status, new_status, reason_code, reason_notes,
    previous_calculations, new_calculations, corrected_by, corrected_at
  ) values (
    v_after.id, v_after.user_id, v_after.schedule_id, v_before.schedule_id, v_after.schedule_id,
    v_before.clock_in, v_before.clock_out, v_after.clock_in, v_after.clock_out,
    v_before.billed_clock_in, v_before.billed_clock_out,
    v_after.billed_clock_in, v_after.billed_clock_out,
    v_before.attendance_status, v_after.attendance_status,
    'other', p_reason,
    jsonb_build_object('total_worked_minutes', v_before.total_worked_minutes,
      'regular_minutes', v_before.regular_minutes,
      'total_overtime_minutes', v_before.total_overtime_minutes),
    jsonb_build_object('total_worked_minutes', v_after.total_worked_minutes,
      'regular_minutes', v_after.regular_minutes,
      'total_overtime_minutes', v_after.total_overtime_minutes),
    p_actor_user_id, now()
  );

  insert into public.workforce_audit_logs (
    actor_user_id, action, entity_type, entity_id, before_data, after_data, reason, metadata
  ) values (
    p_actor_user_id, 'wave2a_existing_attendance_corrected', 'attendance', v_after.id,
    jsonb_build_object('attendance', to_jsonb(v_before), 'readiness', to_jsonb(v_readiness_before)),
    jsonb_build_object('attendance', to_jsonb(v_after), 'readiness', to_jsonb(v_readiness_after)),
    p_reason,
    jsonb_build_object('source_reference', p_source_reference, 'workbook_evidence', p_workbook_evidence,
      'period_id', p_period_id, 'canary', true)
  );

  return query
  select v_after.id, v_before.attendance_version, v_after.attendance_version,
    v_before.billed_clock_in, v_before.billed_clock_out,
    v_after.billed_clock_in, v_after.billed_clock_out, v_canonical,
    v_after.total_worked_minutes, v_after.review_status,
    v_readiness_after.is_payroll_ready, v_readiness_after.payroll_readiness_blockers;
exception when others then
  perform set_config('workforce.correction_recalculation', 'false', true);
  raise;
end;
$$;

revoke all on function public.workforce_wave2a_correct_existing_attendance(
  uuid, uuid, uuid, bigint, uuid, bigint, text, timestamptz, timestamptz, text,
  boolean, boolean, boolean, boolean, date, timestamptz, timestamptz,
  timestamptz, timestamptz, integer, integer, integer, integer, integer, integer,
  integer, text, text, timestamptz, timestamptz, timestamptz, timestamptz, integer,
  integer, bigint, bigint, text, jsonb, text
) from public, anon, authenticated;
grant execute on function public.workforce_wave2a_correct_existing_attendance(
  uuid, uuid, uuid, bigint, uuid, bigint, text, timestamptz, timestamptz, text,
  boolean, boolean, boolean, boolean, date, timestamptz, timestamptz,
  timestamptz, timestamptz, integer, integer, integer, integer, integer, integer,
  integer, text, text, timestamptz, timestamptz, timestamptz, timestamptz, integer,
  integer, bigint, bigint, text, jsonb, text
) to service_role;

comment on function public.workforce_wave2a_correct_existing_attendance(
  uuid, uuid, uuid, bigint, uuid, bigint, text, timestamptz, timestamptz, text,
  boolean, boolean, boolean, boolean, date, timestamptz, timestamptz,
  timestamptz, timestamptz, integer, integer, integer, integer, integer, integer,
  integer, text, text, timestamptz, timestamptz, timestamptz, timestamptz, integer,
  integer, bigint, bigint, text, jsonb, text
) is 'Service-role-only guarded Wave 2A existing-attendance billed correction for the Aug 1-15, 2026 payroll period; requires exact before-state and workbook evidence fingerprints and preserves payroll/prepaid artifacts.';

;
