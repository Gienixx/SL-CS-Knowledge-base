-- Local-only patch migration. Not deployed.
-- Replaces only the Genevive Aug 15 reconstruction function with null-safe guards.

begin;
create or replace function public.workforce_historical_reconstruct_genevive_aug15(
  p_period_id uuid,
  p_actor_user_id uuid,
  p_repair_key text,
  p_reason text,
  p_workbook_sha256 text,
  p_source_ranges jsonb,
  p_workbook_evidence jsonb,
  p_expected_fingerprint jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before public.attendance%rowtype;
  v_after public.attendance%rowtype;
  v_schedule public.work_schedules%rowtype;
  v_calc record;
  v_before_fingerprint jsonb;
  v_after_fingerprint jsonb;
  v_other_overtime integer;
begin
  if current_user not in ('postgres', 'service_role') then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;
  if p_actor_user_id is null or not exists (
    select 1 from public.profiles p where p.user_id = p_actor_user_id
      and p.is_system_admin is true and p.employment_status <> 'terminated'
  ) then raise exception 'A system administrator actor is required.'; end if;
  if nullif(trim(coalesce(p_repair_key, '')), '') is null or length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Repair key and reason are required.';
  end if;
  if upper(trim(coalesce(p_workbook_sha256, ''))) <> '48F388C1A9683314DD6F1CED42D54353B9E5956F100AC287AE4DE5EAE4444E80'
     or p_source_ranges is distinct from '["GEN!B308:L308"]'::jsonb
     or p_workbook_evidence->>'filename' is distinct from '2026 Support Timesheet.xlsx'
     or upper(p_workbook_evidence->>'sha256') is distinct from '48F388C1A9683314DD6F1CED42D54353B9E5956F100AC287AE4DE5EAE4444E80' then
    raise exception 'Workbook or Genevive source evidence mismatch.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('final-genevive-aug15:' || p_repair_key, 0));
  perform public.final_structural_repair_shared_guard(p_period_id);
  if exists (select 1 from public.historical_genevive_aug15_repairs where repair_key = p_repair_key or attendance_id = '7f934cf8-6ed1-4ee4-ab66-b9c3473c6de9'::uuid) then
    raise exception 'Genevive repair already exists; repeat execution rejected.';
  end if;

  select * into v_before from public.attendance where id = '7f934cf8-6ed1-4ee4-ab66-b9c3473c6de9'::uuid for update;
  if not found then raise exception 'Genevive target attendance is missing.'; end if;
  select * into v_schedule from public.work_schedules where id = '7dfa9c4b-5f31-406b-9be7-973fd3e5383c'::uuid for update;
  if not found then raise exception 'Genevive target schedule is missing.'; end if;
  if v_before.attendance_version is distinct from 6
     or v_before.review_status is distinct from 'corrected'
     or v_before.payroll_approved_at is not null
     or v_before.schedule_id is not null
     or v_before.work_date is distinct from '2026-08-15'::date
     or v_before.clock_in is distinct from '2026-08-15 08:06:19.372265+00'::timestamptz
     or v_before.clock_out is distinct from '2026-08-16 04:56:10.103086+00'::timestamptz
     or v_before.billed_clock_in is distinct from '2026-08-15 06:00:00+00'::timestamptz
     or v_before.billed_clock_out is not null
     or public.workforce_canonical_billed_minutes(v_before.billed_clock_in, v_before.billed_clock_out) is not null
     or v_before.total_worked_minutes is distinct from 1249
     or public.workforce_canonical_billed_minutes(v_before.clock_in, v_before.clock_out) is distinct from 1249
     or v_before.original_clock_in is distinct from '2026-08-15 08:06:19.372265+00'::timestamptz
     or v_before.original_clock_out is distinct from '2026-08-16 04:56:10.103086+00'::timestamptz then
     raise exception 'Genevive attendance pre-state guard failed.';
  end if;
  if v_schedule.user_id is distinct from v_before.user_id
     or v_schedule.shift_date is distinct from v_before.work_date
     or v_schedule.status is distinct from 'published'
     or v_schedule.is_rest_day is distinct from false
     or v_schedule.is_holiday is distinct from false
     or v_schedule.schedule_version is distinct from 1
     or v_schedule.shift_start is null
     or v_schedule.shift_end is null then
    raise exception 'Genevive target schedule guard failed.';
  end if;
  if exists (select 1 from public.attendance a where a.schedule_id = v_schedule.id and a.voided_at is null) then
    raise exception 'Genevive target schedule is already owned.';
  end if;
  if exists (
    select 1 from public.attendance a
    where a.id <> v_before.id and a.user_id = v_before.user_id and a.work_date = v_before.work_date
      and a.voided_at is null
      and coalesce(a.billed_clock_in, a.clock_in) < '2026-08-16 01:00:00+00'::timestamptz
      and coalesce(a.billed_clock_out, a.clock_out) > '2026-08-15 06:00:00+00'::timestamptz
  ) then raise exception 'Genevive target interval overlaps another attendance.'; end if;

  v_before_fingerprint := jsonb_build_object(
    'attendance', jsonb_build_object(
      'id', v_before.id, 'version', v_before.attendance_version, 'user_id', v_before.user_id,
      'work_date', v_before.work_date, 'schedule_id', v_before.schedule_id,
      'review_status', v_before.review_status, 'payroll_approved_at', v_before.payroll_approved_at,
      'clock_in', v_before.clock_in, 'clock_out', v_before.clock_out,
      'original_clock_in', v_before.original_clock_in, 'original_clock_out', v_before.original_clock_out,
      'billed_clock_in', v_before.billed_clock_in, 'billed_clock_out', v_before.billed_clock_out,
      'canonical_billed_minutes', public.workforce_canonical_billed_minutes(v_before.billed_clock_in, v_before.billed_clock_out),
      'raw_derived_minutes', public.workforce_canonical_billed_minutes(v_before.clock_in, v_before.clock_out),
      'total_worked_minutes', v_before.total_worked_minutes,
      'regular_minutes', v_before.regular_minutes, 'pre_shift_overtime_minutes', v_before.pre_shift_overtime_minutes,
      'post_shift_overtime_minutes', v_before.post_shift_overtime_minutes,
      'total_overtime_minutes', v_before.total_overtime_minutes
    ),
    'target_schedule', to_jsonb(v_schedule), 'source_ranges', p_source_ranges,
    'workbook_sha256', upper(trim(p_workbook_sha256))
  );
  if v_before_fingerprint is distinct from p_expected_fingerprint then raise exception 'Genevive exact pre-state fingerprint mismatch.'; end if;

  select coalesce(sum(greatest(coalesce(a.total_overtime_minutes, 0), 0)), 0)::integer into v_other_overtime
  from public.attendance a where a.user_id = v_before.user_id and a.work_date = v_before.work_date and a.id <> v_before.id and a.voided_at is null;
  select * into v_calc from public.workforce_calculate_attendance(
    v_schedule.shift_start, v_schedule.shift_end,
    '2026-08-15 06:00:00+00'::timestamptz,
    '2026-08-16 01:00:00+00'::timestamptz,
    v_before.work_date, v_schedule.timezone, greatest(0, 1200 - v_other_overtime),
    v_schedule.is_rest_day, v_schedule.is_holiday
  );
  if public.workforce_canonical_billed_minutes('2026-08-15 06:00:00+00'::timestamptz, '2026-08-16 01:00:00+00'::timestamptz) is distinct from 1140
     or v_calc.total_worked_minutes is distinct from 1140
     or v_calc.regular_minutes is distinct from 480
     or v_calc.pre_shift_overtime_minutes is distinct from 360
     or v_calc.post_shift_overtime_minutes is distinct from 300
     or v_calc.total_overtime_minutes is distinct from 660 then
    raise exception 'Genevive production classification rules do not produce the expected target.';
  end if;

  perform set_config('workforce.correction_recalculation', 'true', true);
  update public.attendance
  set schedule_id = v_schedule.id,
      billed_clock_in = '2026-08-15 06:00:00+00'::timestamptz,
      billed_clock_out = '2026-08-16 01:00:00+00'::timestamptz,
      pre_shift_overtime_minutes = v_calc.pre_shift_overtime_minutes,
      regular_minutes = v_calc.regular_minutes,
      post_shift_overtime_minutes = v_calc.post_shift_overtime_minutes,
      rest_day_overtime_minutes = v_calc.rest_day_overtime_minutes,
      holiday_overtime_minutes = v_calc.holiday_overtime_minutes,
      total_overtime_minutes = v_calc.total_overtime_minutes,
      overtime_minutes = v_calc.total_overtime_minutes,
      total_worked_minutes = v_calc.total_worked_minutes,
      minutes_late = v_calc.minutes_late,
      is_late = v_calc.minutes_late > 0,
      undertime_minutes = v_calc.undertime_minutes,
      review_status = 'corrected', reviewed_by = null, reviewed_at = null,
      payroll_approved_at = null, correction_reason = trim(p_reason),
      corrected_by = p_actor_user_id, corrected_at = statement_timestamp(),
      updated_by = p_actor_user_id, updated_at = statement_timestamp()
  where id = v_before.id returning * into v_after;
  perform set_config('workforce.correction_recalculation', 'false', true);

  if v_after.attendance_version is distinct from 7
     or v_after.schedule_id is distinct from v_schedule.id
     or v_after.review_status is distinct from 'corrected'
     or v_after.payroll_approved_at is not null
     or v_after.billed_clock_in is distinct from '2026-08-15 06:00:00+00'::timestamptz
     or v_after.billed_clock_out is distinct from '2026-08-16 01:00:00+00'::timestamptz
     or v_after.total_worked_minutes is distinct from 1140
     or public.workforce_canonical_billed_minutes(v_after.billed_clock_in, v_after.billed_clock_out) is distinct from 1140
     or v_after.regular_minutes is distinct from 480
     or v_after.pre_shift_overtime_minutes is distinct from 360
     or v_after.post_shift_overtime_minutes is distinct from 300
     or v_after.total_overtime_minutes is distinct from 660
     or v_after.original_clock_in is distinct from v_before.original_clock_in
     or v_after.original_clock_out is distinct from v_before.original_clock_out then
    raise exception 'Genevive reconstruction postcondition failed.';
  end if;

  v_after_fingerprint := jsonb_build_object(
    'attendance', jsonb_build_object('id', v_after.id, 'version', v_after.attendance_version, 'schedule_id', v_after.schedule_id, 'review_status', v_after.review_status, 'payroll_approved_at', v_after.payroll_approved_at, 'billed_clock_in', v_after.billed_clock_in, 'billed_clock_out', v_after.billed_clock_out, 'canonical_billed_minutes', public.workforce_canonical_billed_minutes(v_after.billed_clock_in, v_after.billed_clock_out), 'raw_derived_minutes', public.workforce_canonical_billed_minutes(v_after.clock_in, v_after.clock_out), 'total_worked_minutes', v_after.total_worked_minutes, 'regular_minutes', v_after.regular_minutes, 'pre_shift_overtime_minutes', v_after.pre_shift_overtime_minutes, 'post_shift_overtime_minutes', v_after.post_shift_overtime_minutes, 'total_overtime_minutes', v_after.total_overtime_minutes, 'original_clock_in', v_after.original_clock_in, 'original_clock_out', v_after.original_clock_out),
    'target_schedule_id', v_schedule.id, 'target_schedule_version', v_schedule.schedule_version,
    'source_ranges', p_source_ranges, 'workbook_sha256', upper(trim(p_workbook_sha256))
  );
  insert into public.historical_genevive_aug15_repairs(
    repair_key, attendance_id, period_id, target_schedule_id, target_schedule_version,
    workbook_sha256, source_ranges, workbook_evidence, before_fingerprint, after_fingerprint,
    target_billed_clock_in, target_billed_clock_out, target_worked_minutes,
    target_regular_minutes, target_pre_shift_overtime_minutes, target_post_shift_overtime_minutes,
    target_total_overtime_minutes, reason, applied_by
  ) values (
    p_repair_key, v_after.id, p_period_id, v_schedule.id, v_schedule.schedule_version,
    upper(trim(p_workbook_sha256)), p_source_ranges, p_workbook_evidence, v_before_fingerprint, v_after_fingerprint,
    v_after.billed_clock_in, v_after.billed_clock_out, v_after.total_worked_minutes,
    v_after.regular_minutes, v_after.pre_shift_overtime_minutes, v_after.post_shift_overtime_minutes,
    v_after.total_overtime_minutes, trim(p_reason), p_actor_user_id
  );
  insert into public.workforce_audit_logs(actor_user_id, action, entity_type, entity_id, before_data, after_data, reason, metadata)
  values (p_actor_user_id, 'historical_genevive_aug15_reconstructed', 'attendance', v_after.id,
    v_before_fingerprint, v_after_fingerprint, trim(p_reason),
    jsonb_build_object('repair_key', p_repair_key, 'workbook_sha256', upper(trim(p_workbook_sha256)), 'source_ranges', p_source_ranges, 'target_schedule_id', v_schedule.id, 'target_schedule_version', v_schedule.schedule_version));
  return jsonb_build_object('attendance_id', v_after.id, 'previous_version', 6, 'new_version', v_after.attendance_version, 'review_status', v_after.review_status, 'schedule_id', v_after.schedule_id, 'worked_minutes', v_after.total_worked_minutes, 'regular_minutes', v_after.regular_minutes, 'pre_shift_overtime_minutes', v_after.pre_shift_overtime_minutes, 'post_shift_overtime_minutes', v_after.post_shift_overtime_minutes, 'total_overtime_minutes', v_after.total_overtime_minutes, 'ledger_count', 1);
exception when others then
  perform set_config('workforce.correction_recalculation', 'false', true);
  raise;
end;
$$;
commit;
