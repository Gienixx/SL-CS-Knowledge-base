-- Adds an explicit provenance-compatible corrected_reapproved overload.
-- The existing 12-argument RPC and its modern nested guard are unchanged.
-- This migration is intentionally not deployed in this turn.

create or replace function public.wave2a_corrected_reapproved_compatibility_fingerprint(
  p_period_id uuid,
  p_attendance_id uuid,
  p_source_reference text,
  p_workbook_evidence jsonb,
  p_target_billed_clock_in timestamptz,
  p_target_billed_clock_out timestamptz,
  p_target_billed_minutes integer,
  p_provenance_schema text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_base jsonb;
  v_attendance public.attendance%rowtype;
  v_schedule public.work_schedules%rowtype;
  v_approval public.workforce_audit_logs%rowtype;
  v_update public.workforce_audit_logs%rowtype;
  v_correction public.attendance_corrections%rowtype;
  v_approval_count integer;
  v_update_count integer;
  v_lock_count integer;
  v_correction_count integer;
  v_active_count bigint;
  v_overlap boolean;
  v_legacy_rows bigint;
  v_legacy_minutes bigint;
  v_legacy_fingerprint text;
  v_expected_prior bigint;
  v_expected_current bigint;
  v_expected_schedule_version integer;
  v_expected_classifications jsonb;
  v_compatibility jsonb;
begin
  if p_provenance_schema not in ('modern_nested_v1', 'historical_flat_v1') then
    raise exception 'Unsupported corrected_reapproved provenance schema.';
  end if;
  if coalesce(p_workbook_evidence->>'provenance_schema', p_provenance_schema)
       is distinct from p_provenance_schema then
    raise exception 'Provenance schema marker is missing or inconsistent.';
  end if;

  v_base := case when p_provenance_schema = 'modern_nested_v1' then
    public.wave2a_corrected_reapproved_fingerprint(
      p_period_id, p_attendance_id, p_source_reference, p_workbook_evidence,
      p_target_billed_clock_in, p_target_billed_clock_out, p_target_billed_minutes
    )
  else null end;

  if p_provenance_schema = 'modern_nested_v1' then
    return v_base;
  end if;

  if p_workbook_evidence->>'attendance_id' is distinct from p_attendance_id::text
     or p_workbook_evidence->>'employee_id' is null
     or p_workbook_evidence->>'work_date' is null
     or p_workbook_evidence->>'schedule_id' is null
     or p_workbook_evidence->>'schedule_version' is null
     or p_workbook_evidence->>'expected_prior_attendance_version' is null
     or p_workbook_evidence->>'expected_current_attendance_version' is null
     or p_workbook_evidence->>'approval_audit_id' is null
     or p_workbook_evidence->>'paired_update_audit_id' is null
     or p_workbook_evidence->>'paired_event_timestamp' is null
     or p_workbook_evidence->>'raw_clock_in' is null
     or p_workbook_evidence->>'raw_clock_out' is null
     or p_workbook_evidence->>'current_billed_clock_in' is null
     or p_workbook_evidence->>'current_billed_clock_out' is null
     or jsonb_typeof(p_workbook_evidence->'expected_classifications') <> 'object' then
    raise exception 'historical_flat_v1 evidence is incomplete.';
  end if;

  v_expected_prior := (p_workbook_evidence->>'expected_prior_attendance_version')::bigint;
  v_expected_current := (p_workbook_evidence->>'expected_current_attendance_version')::bigint;
  v_expected_schedule_version := (p_workbook_evidence->>'schedule_version')::integer;
  v_expected_classifications := p_workbook_evidence->'expected_classifications';
  if v_expected_current is distinct from v_expected_prior + 1 then
    raise exception 'Historical attendance version transition must be consecutive.';
  end if;

  select * into v_attendance
  from public.attendance
  where id = p_attendance_id;
  if not found then raise exception 'Attendance record not found.'; end if;

  if v_attendance.user_id::text is distinct from p_workbook_evidence->>'employee_id'
     or v_attendance.work_date::text is distinct from p_workbook_evidence->>'work_date'
     or v_attendance.schedule_id::text is distinct from p_workbook_evidence->>'schedule_id'
     or v_attendance.attendance_version is distinct from v_expected_current
     or v_attendance.review_status is distinct from 'approved'
     or v_attendance.is_corrected is distinct from true
     or v_attendance.payroll_approved_at is null
     or to_jsonb(v_attendance)->>'clock_in' is distinct from p_workbook_evidence->>'raw_clock_in'
     or to_jsonb(v_attendance)->>'clock_out' is distinct from p_workbook_evidence->>'raw_clock_out'
     or to_jsonb(v_attendance)->>'original_clock_in' is distinct from p_workbook_evidence->>'raw_clock_in'
     or to_jsonb(v_attendance)->>'original_clock_out' is distinct from p_workbook_evidence->>'raw_clock_out'
     or to_jsonb(v_attendance)->>'billed_clock_in' is distinct from p_workbook_evidence->>'current_billed_clock_in'
     or to_jsonb(v_attendance)->>'billed_clock_out' is distinct from p_workbook_evidence->>'current_billed_clock_out'
     or v_attendance.reviewed_by::text is distinct from p_workbook_evidence->>'actor_user_id'
     or to_jsonb(v_attendance)->>'reviewed_at' is distinct from p_workbook_evidence->>'paired_event_timestamp'
     or to_jsonb(v_attendance)->>'payroll_approved_at' is distinct from p_workbook_evidence->>'paired_event_timestamp' then
    raise exception 'historical_flat_v1 current attendance fingerprint mismatch.';
  end if;

  if v_attendance.regular_minutes is distinct from (v_expected_classifications->>'regular_minutes')::integer
     or v_attendance.pre_shift_overtime_minutes is distinct from (v_expected_classifications->>'pre_shift_overtime_minutes')::integer
     or v_attendance.post_shift_overtime_minutes is distinct from (v_expected_classifications->>'post_shift_overtime_minutes')::integer
     or v_attendance.rest_day_overtime_minutes is distinct from (v_expected_classifications->>'rest_day_overtime_minutes')::integer
     or v_attendance.holiday_overtime_minutes is distinct from (v_expected_classifications->>'holiday_overtime_minutes')::integer
     or v_attendance.total_overtime_minutes is distinct from (v_expected_classifications->>'total_overtime_minutes')::integer
     or v_attendance.overtime_minutes is distinct from (v_expected_classifications->>'overtime_minutes')::integer
     or v_attendance.total_worked_minutes is distinct from (v_expected_classifications->>'total_worked_minutes')::integer then
    raise exception 'historical_flat_v1 classification fingerprint mismatch.';
  end if;

  select * into v_schedule from public.work_schedules where id = v_attendance.schedule_id;
  if not found
     or v_schedule.user_id::text is distinct from p_workbook_evidence->>'employee_id'
     or v_schedule.shift_date::text is distinct from p_workbook_evidence->>'work_date'
     or v_schedule.schedule_version is distinct from v_expected_schedule_version
     or v_schedule.status is distinct from 'published'
     or v_schedule.timezone is distinct from p_workbook_evidence->>'schedule_timezone'
     or v_schedule.is_rest_day is distinct from (p_workbook_evidence->>'is_rest_day')::boolean
     or v_schedule.is_holiday is distinct from (p_workbook_evidence->>'is_holiday')::boolean
     or v_schedule.is_leave is distinct from (p_workbook_evidence->>'is_leave')::boolean
     or v_schedule.is_absent is distinct from (p_workbook_evidence->>'is_absent')::boolean then
    raise exception 'historical_flat_v1 schedule fingerprint mismatch.';
  end if;

  select count(*) into v_active_count
  from public.attendance a
  where a.user_id = v_attendance.user_id and a.work_date = v_attendance.work_date and a.voided_at is null;
  if v_active_count <> 1 then raise exception 'Exactly one active attendance row is required.'; end if;

  select exists (
    select 1 from public.attendance other
    where other.user_id = v_attendance.user_id and other.work_date = v_attendance.work_date
      and other.id <> v_attendance.id and other.voided_at is null
      and coalesce(other.billed_clock_in, other.clock_in) < coalesce(v_attendance.billed_clock_out, v_attendance.clock_out)
      and coalesce(v_attendance.billed_clock_in, v_attendance.clock_in) < coalesce(other.billed_clock_out, other.clock_out)
  ) into v_overlap;
  if v_overlap then raise exception 'Attendance overlap detected.'; end if;

  select count(*) into v_approval_count
  from public.workforce_audit_logs l
  where l.entity_type = 'attendance' and l.entity_id = p_attendance_id and l.action = 'attendance_approved';
  if v_approval_count <> 1 then raise exception 'Exactly one attendance approval audit is required.'; end if;

  select * into v_approval
  from public.workforce_audit_logs l
  where l.id = (p_workbook_evidence->>'approval_audit_id')::uuid
    and l.entity_type = 'attendance' and l.entity_id = p_attendance_id and l.action = 'attendance_approved';
  if not found then raise exception 'Historical approval audit ID is not an exact match.'; end if;

  if v_approval.actor_user_id::text is distinct from p_workbook_evidence->>'actor_user_id'
     or to_jsonb(v_approval)->>'created_at' is distinct from p_workbook_evidence->>'paired_event_timestamp'
     or v_approval.before_data is distinct from jsonb_build_object(
       'work_date', v_attendance.work_date, 'reviewed_at', null, 'reviewed_by', null,
       'attendance_id', p_attendance_id, 'review_status', 'corrected',
       'employee_user_id', v_attendance.user_id, 'payroll_approved_at', null)
     or v_approval.after_data is distinct from jsonb_build_object(
       'work_date', v_attendance.work_date, 'reviewed_at', v_approval.created_at,
       'reviewed_by', v_approval.actor_user_id, 'attendance_id', p_attendance_id,
       'review_status', 'approved', 'employee_user_id', v_attendance.user_id,
       'payroll_approved_at', v_approval.created_at) then
    raise exception 'Historical approval audit payload mismatch.';
  end if;

  select count(*) into v_update_count
  from public.workforce_audit_logs l
  where l.entity_type = 'attendance' and l.entity_id = p_attendance_id and l.action = 'update'
    and not (l.before_data ? 'attendance') and not (l.after_data ? 'attendance')
    and l.before_data->>'attendance_version' = v_expected_prior::text
    and l.after_data = to_jsonb(v_attendance)
    and l.after_data->>'attendance_version' = v_expected_current::text
    and l.after_data->>'review_status' = 'approved'
    and l.after_data->>'payroll_approved_at' is not null;
  if v_update_count <> 1 then raise exception 'Exactly one qualifying historical flat update is required.'; end if;

  select * into v_update
  from public.workforce_audit_logs l
  where l.id = (p_workbook_evidence->>'paired_update_audit_id')::uuid
    and l.entity_type = 'attendance' and l.entity_id = p_attendance_id and l.action = 'update'
    and not (l.before_data ? 'attendance') and not (l.after_data ? 'attendance')
    and l.before_data->>'attendance_version' = v_expected_prior::text
    and l.after_data = to_jsonb(v_attendance)
    and l.after_data->>'attendance_version' = v_expected_current::text
    and l.after_data->>'review_status' = 'approved'
    and l.after_data->>'payroll_approved_at' is not null;
  if not found then raise exception 'Historical paired update ID is not an exact match.'; end if;
  if v_update.entity_id <> v_approval.entity_id
     or v_update.actor_user_id <> v_approval.actor_user_id
     or v_update.created_at <> v_approval.created_at
     or v_update.before_data->>'review_status' is distinct from 'corrected'
     or v_update.before_data->>'payroll_approved_at' is not null
     or v_update.before_data->>'user_id' is distinct from v_attendance.user_id::text
     or v_update.before_data->>'work_date' is distinct from v_attendance.work_date::text
     or v_update.before_data->>'schedule_id' is distinct from v_attendance.schedule_id::text
     or v_update.before_data->>'clock_in' is distinct from to_jsonb(v_attendance)->>'clock_in'
     or v_update.before_data->>'clock_out' is distinct from to_jsonb(v_attendance)->>'clock_out'
     or v_update.before_data->>'original_clock_in' is distinct from to_jsonb(v_attendance)->>'original_clock_in'
     or v_update.before_data->>'original_clock_out' is distinct from to_jsonb(v_attendance)->>'original_clock_out'
     or v_update.before_data->>'billed_clock_in' is distinct from to_jsonb(v_attendance)->>'billed_clock_in'
     or v_update.before_data->>'billed_clock_out' is distinct from to_jsonb(v_attendance)->>'billed_clock_out'
     or (v_update.before_data - ARRAY['review_status','payroll_approved_at','reviewed_by','reviewed_at','attendance_version','updated_at','updated_by'])
          is distinct from (to_jsonb(v_attendance) - ARRAY['review_status','payroll_approved_at','reviewed_by','reviewed_at','attendance_version','updated_at','updated_by']) then
    raise exception 'Historical flat approval/update transition mismatch.';
  end if;

  select count(*) into v_correction_count
  from public.attendance_corrections c
  where c.attendance_id = p_attendance_id;
  if v_correction_count <> 1 then raise exception 'Exactly one historical correction row is required.'; end if;

  select * into v_correction
  from public.attendance_corrections c
  where c.id = (p_workbook_evidence->>'correction_id')::uuid
    and c.attendance_id = p_attendance_id;
  if not found
     or v_correction.employee_user_id <> v_attendance.user_id
     or v_correction.schedule_id <> v_attendance.schedule_id
     or v_correction.new_schedule_id <> v_attendance.schedule_id
     or v_correction.reason_code is distinct from p_workbook_evidence->>'correction_reason_code'
     or v_correction.reason_notes is distinct from p_workbook_evidence->>'correction_reason_notes'
     or v_correction.new_billed_clock_in <> v_attendance.billed_clock_in
     or v_correction.new_billed_clock_out <> v_attendance.billed_clock_out then
    raise exception 'Historical correction metadata mismatch.';
  end if;

  select count(*) into v_lock_count
  from public.workforce_audit_logs l
  where l.entity_type = 'attendance' and l.entity_id = p_attendance_id
    and l.action in ('lock', 'attendance_locked');
  if v_lock_count <> 0 then raise exception 'Attendance lock evidence exists.'; end if;

  select count(*), coalesce(sum(remaining_minutes), 0),
    md5(coalesce(string_agg(to_jsonb(p)::text, '|' order by p.id), ''))
  into v_legacy_rows, v_legacy_minutes, v_legacy_fingerprint
  from public.payroll_prepaid_hours p
  where p.commitment_id is null and p.voided_at is null;
  if v_legacy_rows <> 111 or v_legacy_minutes <> 10710
     or v_legacy_fingerprint <> '32e1a4aa6e9f27a1ad5cc56f47d44840' then
    raise exception 'Grandfathered legacy prepaid baseline changed.';
  end if;

  v_base := public.wave2a_corrected_reapproved_fingerprint(
    p_period_id, p_attendance_id, p_source_reference, p_workbook_evidence,
    p_target_billed_clock_in, p_target_billed_clock_out, p_target_billed_minutes
  );
  v_compatibility := jsonb_build_object(
    'provenance_schema', p_provenance_schema,
    'approval_audit_id', v_approval.id,
    'paired_update_audit_id', v_update.id,
    'actor_user_id', v_approval.actor_user_id,
    'event_timestamp', v_approval.created_at,
    'prior_attendance_version', v_expected_prior,
    'current_attendance_version', v_expected_current,
    'attendance_id', p_attendance_id,
    'current_attendance_fingerprint', md5(to_jsonb(v_attendance)::text),
    'prepaid_baseline_fingerprint', v_legacy_fingerprint,
    'approval_history_preserved', true
  );
  return v_base || jsonb_build_object('compatibility', v_compatibility);
end;
$$;

create or replace function public.workforce_wave2a_correct_reapproved_attendance(
  p_period_id uuid,
  p_attendance_id uuid,
  p_actor_user_id uuid,
  p_lifecycle_mode text,
  p_repair_key text,
  p_expected_fingerprint jsonb,
  p_new_billed_clock_in timestamptz,
  p_new_billed_clock_out timestamptz,
  p_expected_new_billed_minutes integer,
  p_source_reference text,
  p_workbook_evidence jsonb,
  p_reason text,
  p_provenance_schema text
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
  rest_day_overtime_minutes integer,
  total_overtime_minutes integer,
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
  v_calc record;
  v_readiness_before record;
  v_readiness_after record;
  v_actual_fingerprint jsonb;
  v_compatibility jsonb;
  v_canonical integer;
  v_other_overtime integer;
  v_available_overtime integer;
begin
  if p_lifecycle_mode <> 'corrected_reapproved' then
    raise exception 'Only corrected_reapproved is supported.';
  end if;
  if p_provenance_schema not in ('modern_nested_v1', 'historical_flat_v1') then
    raise exception 'Unsupported corrected_reapproved provenance schema.';
  end if;
  if nullif(trim(coalesce(p_repair_key, '')), '') is null
     or nullif(trim(coalesce(p_source_reference, '')), '') is null
     or p_expected_fingerprint is null or p_workbook_evidence is null
     or nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'Repair key, exact fingerprint, workbook evidence, source, and reason are required.';
  end if;
  if p_provenance_schema = 'modern_nested_v1' then
    return query select * from public.workforce_wave2a_correct_reapproved_attendance(
      p_period_id, p_attendance_id, p_actor_user_id, p_lifecycle_mode, p_repair_key,
      p_expected_fingerprint, p_new_billed_clock_in, p_new_billed_clock_out,
      p_expected_new_billed_minutes, p_source_reference, p_workbook_evidence, p_reason
    );
    return;
  end if;
  if p_new_billed_clock_in is null or p_new_billed_clock_out is null
     or p_new_billed_clock_out <= p_new_billed_clock_in
     or p_expected_new_billed_minutes is null or p_expected_new_billed_minutes <= 0 then
    raise exception 'New billed target is invalid.';
  end if;
  if not exists (select 1 from public.profiles where user_id = p_actor_user_id and is_system_admin is true and account_deleted_at is null) then
    raise exception 'A non-deleted system administrator actor is required.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('wave2a-corrected-reapproved:' || p_attendance_id::text, 0));
  if exists (select 1 from public.wave2a_corrected_reapproved_repairs r where r.repair_key = p_repair_key or r.attendance_id = p_attendance_id) then
    raise exception 'corrected_reapproved repair was already applied; repeat execution rejected.';
  end if;
  select * into v_period from public.payroll_periods where id = p_period_id for update;
  if not found or v_period.status <> 'draft' then raise exception 'Payroll period must exist and remain draft.'; end if;
  if (select count(*) from public.payroll_records where payroll_period_id = p_period_id) <> 9
     or exists (select 1 from public.payroll_records where payroll_period_id = p_period_id and status <> 'draft') then
    raise exception 'Payroll period record/status guard failed.';
  end if;
  if exists (select 1 from public.payroll_items i join public.payroll_records r on r.id=i.payroll_record_id where r.payroll_period_id=p_period_id)
     or exists (select 1 from public.payroll_attendance_snapshots s join public.payroll_records r on r.id=s.payroll_record_id where r.payroll_period_id=p_period_id)
     or exists (select 1 from public.payroll_schedule_snapshots s join public.payroll_records r on r.id=s.payroll_record_id where r.payroll_period_id=p_period_id)
     or exists (select 1 from public.payroll_hour_allocations a join public.payroll_records r on r.id=a.destination_payroll_record_id where r.payroll_period_id=p_period_id)
     or exists (select 1 from public.payroll_prepaid_commitments where payroll_period_id=p_period_id) then
    raise exception 'Payroll artifacts already exist for this period.';
  end if;
  select * into v_before from public.attendance where id=p_attendance_id for update;
  if not found or v_before.work_date < v_period.period_start or v_before.work_date > v_period.period_end then
    raise exception 'Attendance record is missing or outside the supplied payroll period.';
  end if;
  v_actual_fingerprint := public.wave2a_corrected_reapproved_compatibility_fingerprint(
    p_period_id, p_attendance_id, p_source_reference, p_workbook_evidence,
    p_new_billed_clock_in, p_new_billed_clock_out, p_expected_new_billed_minutes, p_provenance_schema
  );
  if v_actual_fingerprint is distinct from p_expected_fingerprint then
    raise exception 'corrected_reapproved compatibility fingerprint changed.';
  end if;
  v_compatibility := v_actual_fingerprint->'compatibility';

  select * into v_schedule from public.work_schedules where id=v_before.schedule_id for share;
  if not found or v_schedule.user_id is distinct from v_before.user_id then raise exception 'Schedule ownership guard failed.'; end if;
  select coalesce(sum(greatest(coalesce(a.total_overtime_minutes,0),0)),0)::integer into v_other_overtime
  from public.attendance a where a.user_id=v_before.user_id and a.work_date=v_before.work_date and a.id<>v_before.id;
  v_available_overtime := greatest(0,1200-v_other_overtime);
  select * into v_calc from public.workforce_calculate_attendance(
    v_schedule.shift_start, v_schedule.shift_end, p_new_billed_clock_in, p_new_billed_clock_out,
    v_before.work_date, v_schedule.timezone, v_available_overtime, v_schedule.is_rest_day, v_schedule.is_holiday);
  v_canonical := public.workforce_canonical_billed_minutes(p_new_billed_clock_in,p_new_billed_clock_out);
  if v_canonical is distinct from p_expected_new_billed_minutes
     or v_calc.total_worked_minutes is distinct from v_canonical
     or v_calc.regular_minutes + v_calc.total_overtime_minutes is distinct from v_canonical
     or v_calc.total_overtime_minutes is distinct from v_calc.pre_shift_overtime_minutes + v_calc.post_shift_overtime_minutes + v_calc.rest_day_overtime_minutes + v_calc.holiday_overtime_minutes then
    raise exception 'Workbook duration or classification calculation is inconsistent.';
  end if;

  select * into v_readiness_before from public.workforce_attendance_payroll_readiness where id=v_before.id;
  perform set_config('workforce.correction_recalculation','true',true);
  perform set_config('workforce.review_metadata_update','true',true);
  update public.attendance set
    billed_clock_in=p_new_billed_clock_in, billed_clock_out=p_new_billed_clock_out,
    pre_shift_overtime_minutes=v_calc.pre_shift_overtime_minutes, regular_minutes=v_calc.regular_minutes,
    post_shift_overtime_minutes=v_calc.post_shift_overtime_minutes, rest_day_overtime_minutes=v_calc.rest_day_overtime_minutes,
    holiday_overtime_minutes=v_calc.holiday_overtime_minutes, total_overtime_minutes=v_calc.total_overtime_minutes,
    overtime_minutes=v_calc.total_overtime_minutes, total_worked_minutes=v_calc.total_worked_minutes,
    minutes_late=v_calc.minutes_late, is_late=v_calc.minutes_late>0, undertime_minutes=v_calc.undertime_minutes,
    review_status='corrected', reviewed_by=null, reviewed_at=null, payroll_approved_at=null,
    correction_reason='wave2a_corrected_reapproved_workbook', corrected_by=p_actor_user_id, corrected_at=now(),
    updated_by=p_actor_user_id, updated_at=now()
  where id=v_before.id returning * into v_after;
  perform set_config('workforce.correction_recalculation','false',true);
  perform set_config('workforce.review_metadata_update','false',true);
  if v_after.attendance_version is distinct from v_before.attendance_version+1
     or v_after.original_clock_in is distinct from v_before.original_clock_in
     or v_after.original_clock_out is distinct from v_before.original_clock_out
     or v_after.schedule_id is distinct from v_before.schedule_id or v_after.user_id is distinct from v_before.user_id
     or v_after.work_date is distinct from v_before.work_date or v_after.total_worked_minutes is distinct from v_canonical
     or v_after.payroll_approved_at is not null or v_after.review_status is distinct from 'corrected' then
    raise exception 'corrected_reapproved post-write invariant failed.';
  end if;
  select * into v_readiness_after from public.workforce_attendance_payroll_readiness where id=v_after.id;
  if coalesce(v_readiness_after.is_payroll_ready,false) or not ('review_required'=any(v_readiness_after.payroll_readiness_blockers)) then
    raise exception 'Corrected attendance readiness invariant failed.';
  end if;
  insert into public.attendance_corrections (
    attendance_id, employee_user_id, schedule_id, previous_schedule_id, new_schedule_id,
    previous_clock_in, previous_clock_out, new_clock_in, new_clock_out,
    previous_billed_clock_in, previous_billed_clock_out, new_billed_clock_in, new_billed_clock_out,
    previous_status, new_status, reason_code, reason_notes, previous_calculations, new_calculations,
    corrected_by, corrected_at
  ) values (
    v_after.id,v_after.user_id,v_after.schedule_id,v_before.schedule_id,v_after.schedule_id,
    v_before.clock_in,v_before.clock_out,v_after.clock_in,v_after.clock_out,
    v_before.billed_clock_in,v_before.billed_clock_out,v_after.billed_clock_in,v_after.billed_clock_out,
    v_before.attendance_status,v_after.attendance_status,'other',p_reason,
    jsonb_build_object('attendance_version',v_before.attendance_version,'total_worked_minutes',v_before.total_worked_minutes,'regular_minutes',v_before.regular_minutes,'pre_shift_overtime_minutes',v_before.pre_shift_overtime_minutes,'post_shift_overtime_minutes',v_before.post_shift_overtime_minutes,'rest_day_overtime_minutes',v_before.rest_day_overtime_minutes,'holiday_overtime_minutes',v_before.holiday_overtime_minutes,'total_overtime_minutes',v_before.total_overtime_minutes),
    jsonb_build_object('attendance_version',v_after.attendance_version,'total_worked_minutes',v_after.total_worked_minutes,'regular_minutes',v_after.regular_minutes,'pre_shift_overtime_minutes',v_after.pre_shift_overtime_minutes,'post_shift_overtime_minutes',v_after.post_shift_overtime_minutes,'rest_day_overtime_minutes',v_after.rest_day_overtime_minutes,'holiday_overtime_minutes',v_after.holiday_overtime_minutes,'total_overtime_minutes',v_after.total_overtime_minutes),
    p_actor_user_id,now());
  insert into public.workforce_audit_logs(actor_user_id,action,entity_type,entity_id,before_data,after_data,reason,metadata)
  values(p_actor_user_id,'wave2a_corrected_reapproved_attendance_repaired','attendance',v_after.id,
    jsonb_build_object('attendance',to_jsonb(v_before),'readiness',to_jsonb(v_readiness_before)),
    jsonb_build_object('attendance',to_jsonb(v_after),'readiness',to_jsonb(v_readiness_after)),p_reason,
    jsonb_build_object('source_reference',p_source_reference,'workbook_evidence',p_workbook_evidence,'period_id',p_period_id,'lifecycle_mode',p_lifecycle_mode,'repair_key',p_repair_key,'provenance_schema',p_provenance_schema,'approval_audit_id',v_compatibility->>'approval_audit_id','paired_update_audit_id',v_compatibility->>'paired_update_audit_id','actor_user_id',v_compatibility->>'actor_user_id','event_timestamp',v_compatibility->>'event_timestamp','prior_attendance_version',v_compatibility->>'prior_attendance_version','current_attendance_version',v_compatibility->>'current_attendance_version','attendance_id',v_compatibility->>'attendance_id','current_attendance_fingerprint',v_compatibility->>'current_attendance_fingerprint','prepaid_baseline_fingerprint',v_compatibility->>'prepaid_baseline_fingerprint','approval_history_preserved',true));
  insert into public.wave2a_corrected_reapproved_repairs(repair_key,period_id,attendance_id,lifecycle_mode,expected_fingerprint,target_billed_clock_in,target_billed_clock_out,target_billed_minutes,source_reference,workbook_evidence,applied_by)
  values(p_repair_key,p_period_id,v_after.id,p_lifecycle_mode,p_expected_fingerprint,p_new_billed_clock_in,p_new_billed_clock_out,p_expected_new_billed_minutes,p_source_reference,p_workbook_evidence,p_actor_user_id);
  return query select v_after.id,v_before.attendance_version,v_after.attendance_version,v_before.billed_clock_in,v_before.billed_clock_out,v_after.billed_clock_in,v_after.billed_clock_out,v_canonical,v_after.total_worked_minutes,v_after.rest_day_overtime_minutes,v_after.total_overtime_minutes,v_after.review_status,v_readiness_after.is_payroll_ready,v_readiness_after.payroll_readiness_blockers;
exception when others then
  perform set_config('workforce.correction_recalculation','false',true);
  perform set_config('workforce.review_metadata_update','false',true);
  raise;
end;
$$;

revoke all on function public.wave2a_corrected_reapproved_compatibility_fingerprint(uuid,uuid,text,jsonb,timestamptz,timestamptz,integer,text) from public, anon, authenticated;
grant execute on function public.wave2a_corrected_reapproved_compatibility_fingerprint(uuid,uuid,text,jsonb,timestamptz,timestamptz,integer,text) to service_role;
revoke all on function public.workforce_wave2a_correct_reapproved_attendance(uuid,uuid,uuid,text,text,jsonb,timestamptz,timestamptz,integer,text,jsonb,text,text) from public, anon, authenticated;
grant execute on function public.workforce_wave2a_correct_reapproved_attendance(uuid,uuid,uuid,text,text,jsonb,timestamptz,timestamptz,integer,text,jsonb,text,text) to service_role;

comment on function public.wave2a_corrected_reapproved_compatibility_fingerprint(uuid,uuid,text,jsonb,timestamptz,timestamptz,integer,text)
  is 'Explicit modern_nested_v1 or historical_flat_v1 corrected_reapproved fingerprint; service-role only.';
comment on function public.workforce_wave2a_correct_reapproved_attendance(uuid,uuid,uuid,text,text,jsonb,timestamptz,timestamptz,integer,text,jsonb,text,text)
  is 'Explicit provenance-compatible corrected_reapproved repair; service-role only. Historical audit rows are immutable.';

;
