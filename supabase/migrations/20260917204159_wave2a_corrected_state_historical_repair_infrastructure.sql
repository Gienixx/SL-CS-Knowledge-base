-- Narrow corrected-state historical attendance repair infrastructure.
-- Infrastructure only: no target rows, manifests, repair execution, payroll calculation,
-- approval, locking, schedule mutation, or prepaid mutation.
-- Do not apply without separate deployment authorization.

begin;

-- Dedicated corrected-state Wave 2A mechanism. This migration does not change
-- the frozen workforce_wave2a_correct_existing_attendance RPC.
create table public.wave2a_corrected_attendance_repairs (
  id uuid primary key default gen_random_uuid(),
  repair_key text not null unique,
  period_id uuid not null references public.payroll_periods(id),
  attendance_id uuid not null unique references public.attendance(id),
  lifecycle_mode text not null check (lifecycle_mode = 'corrected_pending'),
  expected_fingerprint jsonb not null,
  target_billed_clock_in timestamptz not null,
  target_billed_clock_out timestamptz not null,
  target_billed_minutes integer not null check (target_billed_minutes > 0),
  source_reference text not null,
  workbook_evidence jsonb not null,
  applied_by uuid not null references public.profiles(user_id),
  applied_at timestamptz not null default now()
);

alter table public.wave2a_corrected_attendance_repairs enable row level security;
revoke all on table public.wave2a_corrected_attendance_repairs from public, anon, authenticated, service_role;

create or replace function public.wave2a_corrected_pending_fingerprint(
  p_period_id uuid,
  p_attendance_id uuid,
  p_source_reference text,
  p_workbook_evidence jsonb,
  p_target_billed_clock_in timestamptz,
  p_target_billed_clock_out timestamptz,
  p_target_billed_minutes integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_attendance public.attendance%rowtype;
  v_schedule public.work_schedules%rowtype;
  v_period public.payroll_periods%rowtype;
  v_readiness record;
  v_corrections jsonb;
  v_audits jsonb;
  v_active_count bigint;
  v_overlap boolean;
  v_legacy_rows bigint;
  v_legacy_minutes bigint;
begin
  select * into v_attendance from public.attendance where id = p_attendance_id;
  if not found then raise exception 'Attendance record not found.'; end if;
  select * into v_schedule from public.work_schedules where id = v_attendance.schedule_id;
  select * into v_period from public.payroll_periods where id = p_period_id;
  select * into v_readiness from public.workforce_attendance_payroll_readiness where id = p_attendance_id;

  select count(*) into v_active_count
  from public.attendance a
  where a.user_id = v_attendance.user_id
    and a.work_date = v_attendance.work_date
    and a.voided_at is null;

  select exists (
    select 1
    from public.attendance other
    where other.user_id = v_attendance.user_id
      and other.work_date = v_attendance.work_date
      and other.id <> v_attendance.id
      and other.voided_at is null
      and coalesce(other.billed_clock_in, other.clock_in) is not null
      and coalesce(other.billed_clock_out, other.clock_out) is not null
      and coalesce(other.billed_clock_in, other.clock_in)
          < coalesce(v_attendance.billed_clock_out, v_attendance.clock_out)
      and coalesce(v_attendance.billed_clock_in, v_attendance.clock_in)
          < coalesce(other.billed_clock_out, other.clock_out)
  ) into v_overlap;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.corrected_at, x.id), '[]'::jsonb)
  into v_corrections
  from (
    select c.id, c.attendance_id, c.employee_user_id, c.schedule_id,
      c.previous_billed_clock_in, c.previous_billed_clock_out,
      c.new_billed_clock_in, c.new_billed_clock_out,
      c.previous_status, c.new_status, c.reason_code, c.reason_notes,
      c.corrected_by, c.corrected_at, c.created_at, c.updated_at
    from public.attendance_corrections c
    where c.attendance_id = p_attendance_id
  ) x;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at, x.id), '[]'::jsonb)
  into v_audits
  from (
    select l.id, l.action, l.entity_type, l.entity_id, l.actor_user_id,
      l.reason, l.created_at, l.metadata
    from public.workforce_audit_logs l
    where l.entity_type = 'attendance'
      and l.entity_id = p_attendance_id
      and l.action = 'attendance_billed_time_corrected'
  ) x;

  select count(*), coalesce(sum(remaining_minutes), 0)
  into v_legacy_rows, v_legacy_minutes
  from public.payroll_prepaid_hours
  where commitment_id is null and voided_at is null;

  return jsonb_build_object(
    'period', jsonb_build_object(
      'id', p_period_id,
      'period_start', v_period.period_start,
      'period_end', v_period.period_end,
      'status', v_period.status,
      'payroll_record_count', (select count(*) from public.payroll_records where payroll_period_id = p_period_id),
      'non_draft_payroll_record_count', (select count(*) from public.payroll_records where payroll_period_id = p_period_id and status <> 'draft'),
      'payroll_item_count', (select count(*) from public.payroll_items i join public.payroll_records r on r.id=i.payroll_record_id where r.payroll_period_id=p_period_id),
      'attendance_snapshot_count', (select count(*) from public.payroll_attendance_snapshots s join public.payroll_records r on r.id=s.payroll_record_id where r.payroll_period_id=p_period_id),
      'schedule_snapshot_count', (select count(*) from public.payroll_schedule_snapshots s join public.payroll_records r on r.id=s.payroll_record_id where r.payroll_period_id=p_period_id),
      'allocation_count', (select count(*) from public.payroll_hour_allocations a join public.payroll_records r on r.id=a.destination_payroll_record_id where r.payroll_period_id=p_period_id),
      'commitment_count', (select count(*) from public.payroll_prepaid_commitments where payroll_period_id=p_period_id),
      'legacy_row_count', v_legacy_rows,
      'legacy_minutes', v_legacy_minutes
    ),
    'attendance_id', v_attendance.id,
    'attendance', jsonb_build_object(
      'user_id', v_attendance.user_id,
      'work_date', v_attendance.work_date,
      'schedule_id', v_attendance.schedule_id,
      'attendance_version', v_attendance.attendance_version,
      'clock_in', v_attendance.clock_in,
      'clock_out', v_attendance.clock_out,
      'original_clock_in', v_attendance.original_clock_in,
      'original_clock_out', v_attendance.original_clock_out,
      'billed_clock_in', v_attendance.billed_clock_in,
      'billed_clock_out', v_attendance.billed_clock_out,
      'canonical_billed_minutes', public.workforce_canonical_billed_minutes(v_attendance.billed_clock_in, v_attendance.billed_clock_out),
      'total_worked_minutes', v_attendance.total_worked_minutes,
      'pre_shift_overtime_minutes', v_attendance.pre_shift_overtime_minutes,
      'regular_minutes', v_attendance.regular_minutes,
      'post_shift_overtime_minutes', v_attendance.post_shift_overtime_minutes,
      'rest_day_overtime_minutes', v_attendance.rest_day_overtime_minutes,
      'holiday_overtime_minutes', v_attendance.holiday_overtime_minutes,
      'total_overtime_minutes', v_attendance.total_overtime_minutes,
      'overtime_minutes', v_attendance.overtime_minutes,
      'minutes_late', v_attendance.minutes_late,
      'undertime_minutes', v_attendance.undertime_minutes,
      'attendance_status', v_attendance.attendance_status,
      'review_status', v_attendance.review_status,
      'payroll_approved_at', v_attendance.payroll_approved_at,
      'voided_at', v_attendance.voided_at,
      'is_corrected', v_attendance.is_corrected,
      'active_row_count', v_active_count,
      'overlap_state', v_overlap
    ),
    'schedule', jsonb_build_object(
      'id', v_schedule.id,
      'user_id', v_schedule.user_id,
      'shift_date', v_schedule.shift_date,
      'schedule_version', v_schedule.schedule_version,
      'shift_start', v_schedule.shift_start,
      'shift_end', v_schedule.shift_end,
      'timezone', v_schedule.timezone,
      'status', v_schedule.status,
      'is_rest_day', v_schedule.is_rest_day,
      'is_holiday', v_schedule.is_holiday,
      'is_leave', v_schedule.is_leave,
      'is_absent', v_schedule.is_absent
    ),
    'correction_history', jsonb_build_object('count', jsonb_array_length(v_corrections), 'rows', v_corrections),
    'audit_history', jsonb_build_object('count', jsonb_array_length(v_audits), 'rows', v_audits),
    'readiness', jsonb_build_object('is_payroll_ready', v_readiness.is_payroll_ready, 'blockers', v_readiness.payroll_readiness_blockers),
    'source_reference', p_source_reference,
    'workbook_evidence', p_workbook_evidence,
    'target', jsonb_build_object('billed_clock_in', p_target_billed_clock_in, 'billed_clock_out', p_target_billed_clock_out, 'billed_minutes', p_target_billed_minutes)
  );
end;
$$;

create or replace function public.workforce_wave2a_correct_previously_corrected_attendance(
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
  v_calc record;
  v_readiness_before record;
  v_readiness_after record;
  v_actual_fingerprint jsonb;
  v_other_overtime integer;
  v_available_overtime integer;
  v_canonical integer;
begin
  if p_lifecycle_mode <> 'corrected_pending' then
    raise exception 'Only corrected_pending is implemented locally.';
  end if;
  if nullif(trim(coalesce(p_repair_key, '')), '') is null
     or nullif(trim(coalesce(p_source_reference, '')), '') is null
     or p_expected_fingerprint is null or p_workbook_evidence is null
     or nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'Repair key, exact fingerprint, workbook evidence, source, and reason are required.';
  end if;
  if p_new_billed_clock_in is null or p_new_billed_clock_out is null
     or p_new_billed_clock_out < p_new_billed_clock_in
     or p_expected_new_billed_minutes is null or p_expected_new_billed_minutes <= 0 then
    raise exception 'New billed target is invalid.';
  end if;
  if not exists (select 1 from public.profiles where user_id=p_actor_user_id and is_system_admin is true and account_deleted_at is null) then
    raise exception 'A non-deleted system administrator actor is required.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('wave2a-corrected:' || p_attendance_id::text, 0));
  if exists (select 1 from public.wave2a_corrected_attendance_repairs r where r.repair_key=p_repair_key or r.attendance_id=p_attendance_id) then
    raise exception 'Corrected-state repair was already applied; repeat execution rejected.';
  end if;

  select * into v_period from public.payroll_periods where id=p_period_id for update;
  if not found or v_period.status <> 'draft' then raise exception 'Payroll period must exist and remain draft.'; end if;
  if (select count(*) from public.payroll_records where payroll_period_id=p_period_id) <> 9
     or exists (select 1 from public.payroll_records where payroll_period_id=p_period_id and status <> 'draft') then
    raise exception 'Payroll period record/status guard failed.';
  end if;
  if exists (select 1 from public.payroll_items i join public.payroll_records r on r.id=i.payroll_record_id where r.payroll_period_id=p_period_id)
     or exists (select 1 from public.payroll_attendance_snapshots s join public.payroll_records r on r.id=s.payroll_record_id where r.payroll_period_id=p_period_id)
     or exists (select 1 from public.payroll_schedule_snapshots s join public.payroll_records r on r.id=s.payroll_record_id where r.payroll_period_id=p_period_id)
     or exists (select 1 from public.payroll_hour_allocations a join public.payroll_records r on r.id=a.destination_payroll_record_id where r.payroll_period_id=p_period_id)
     or exists (select 1 from public.payroll_prepaid_commitments where payroll_period_id=p_period_id) then
    raise exception 'Payroll artifacts already exist for this period.';
  end if;
  if (select count(*) from public.payroll_prepaid_hours where commitment_id is null and voided_at is null) <> (p_expected_fingerprint->'period'->>'legacy_row_count')::bigint
     or (select coalesce(sum(remaining_minutes),0) from public.payroll_prepaid_hours where commitment_id is null and voided_at is null) <> (p_expected_fingerprint->'period'->>'legacy_minutes')::bigint then
    raise exception 'Grandfathered legacy prepaid fingerprint changed.';
  end if;

  select * into v_before from public.attendance where id=p_attendance_id for update;
  if not found then raise exception 'Attendance record not found.'; end if;
  if v_before.work_date < v_period.period_start or v_before.work_date > v_period.period_end then
    raise exception 'Attendance work date is outside the supplied payroll period.';
  end if;
  if v_before.is_corrected is distinct from true or v_before.review_status is distinct from 'corrected' or v_before.payroll_approved_at is not null then
    raise exception 'corrected_pending lifecycle guard failed.';
  end if;
  select * into v_schedule from public.work_schedules where id=v_before.schedule_id for share;
  if not found or v_schedule.user_id is distinct from v_before.user_id or v_schedule.schedule_version is null then
    raise exception 'Schedule ownership guard failed.';
  end if;

  v_actual_fingerprint := public.wave2a_corrected_pending_fingerprint(
    p_period_id, p_attendance_id, p_source_reference, p_workbook_evidence,
    p_new_billed_clock_in, p_new_billed_clock_out, p_expected_new_billed_minutes
  );
  if v_actual_fingerprint is distinct from p_expected_fingerprint then
    raise exception 'Corrected-state fingerprint changed.';
  end if;
  if (p_expected_fingerprint->'attendance'->>'user_id')::uuid is distinct from v_before.user_id
     or (p_expected_fingerprint->'schedule'->>'user_id')::uuid is distinct from v_schedule.user_id
     or v_before.user_id is distinct from v_schedule.user_id then
    raise exception 'Attendance/schedule ownership guard failed.';
  end if;

  if (select count(*) from public.attendance where user_id=v_before.user_id and work_date=v_before.work_date and voided_at is null) <> 1 then
    raise exception 'Exactly one active attendance row is required.';
  end if;
  if (p_new_billed_clock_in >= p_new_billed_clock_out) then raise exception 'Billed target has invalid order.'; end if;

  select coalesce(sum(greatest(coalesce(a.total_overtime_minutes,0),0)),0)::integer into v_other_overtime
  from public.attendance a where a.user_id=v_before.user_id and a.work_date=v_before.work_date and a.id<>v_before.id;
  v_available_overtime := greatest(0,1200-v_other_overtime);
  select * into v_calc from public.workforce_calculate_attendance(
    v_schedule.shift_start,v_schedule.shift_end,p_new_billed_clock_in,p_new_billed_clock_out,
    v_before.work_date,v_schedule.timezone,v_available_overtime,v_schedule.is_rest_day,v_schedule.is_holiday
  );
  v_canonical := public.workforce_canonical_billed_minutes(p_new_billed_clock_in,p_new_billed_clock_out);
  if v_canonical is distinct from p_expected_new_billed_minutes
     or v_calc.total_worked_minutes is distinct from v_canonical
     or v_calc.regular_minutes + v_calc.total_overtime_minutes is distinct from v_canonical
     or v_calc.total_overtime_minutes is distinct from v_calc.pre_shift_overtime_minutes + v_calc.post_shift_overtime_minutes + v_calc.rest_day_overtime_minutes + v_calc.holiday_overtime_minutes then
    raise exception 'Workbook duration or classification calculation is inconsistent.';
  end if;

  select * into v_readiness_before from public.workforce_attendance_payroll_readiness where id=v_before.id;
  perform set_config('workforce.correction_recalculation','true',true);
  update public.attendance
  set billed_clock_in=p_new_billed_clock_in,
      billed_clock_out=p_new_billed_clock_out,
      pre_shift_overtime_minutes=v_calc.pre_shift_overtime_minutes,
      regular_minutes=v_calc.regular_minutes,
      post_shift_overtime_minutes=v_calc.post_shift_overtime_minutes,
      rest_day_overtime_minutes=v_calc.rest_day_overtime_minutes,
      holiday_overtime_minutes=v_calc.holiday_overtime_minutes,
      total_overtime_minutes=v_calc.total_overtime_minutes,
      overtime_minutes=v_calc.total_overtime_minutes,
      total_worked_minutes=v_calc.total_worked_minutes,
      minutes_late=v_calc.minutes_late,
      is_late=v_calc.minutes_late > 0,
      undertime_minutes=v_calc.undertime_minutes,
      review_status='corrected', reviewed_by=null, reviewed_at=null, payroll_approved_at=null,
      correction_reason='wave2a_corrected_state_workbook', corrected_by=p_actor_user_id, corrected_at=now(),
      updated_by=p_actor_user_id, updated_at=now()
  where id=v_before.id returning * into v_after;
  perform set_config('workforce.correction_recalculation','false',true);

  if v_after.attendance_version is distinct from v_before.attendance_version+1
     or v_after.original_clock_in is distinct from v_before.original_clock_in
     or v_after.original_clock_out is distinct from v_before.original_clock_out
     or v_after.schedule_id is distinct from v_before.schedule_id
     or v_after.user_id is distinct from v_before.user_id
     or v_after.work_date is distinct from v_before.work_date
     or v_after.total_worked_minutes is distinct from v_canonical then
    raise exception 'Corrected-state post-write invariant failed.';
  end if;
  select * into v_readiness_after from public.workforce_attendance_payroll_readiness where id=v_after.id;
  if coalesce(v_readiness_after.is_payroll_ready,false) or not ('review_required' = any(v_readiness_after.payroll_readiness_blockers)) then
    raise exception 'Corrected attendance readiness invariant failed.';
  end if;

  insert into public.attendance_corrections (
    attendance_id,employee_user_id,schedule_id,previous_schedule_id,new_schedule_id,
    previous_clock_in,previous_clock_out,new_clock_in,new_clock_out,
    previous_billed_clock_in,previous_billed_clock_out,new_billed_clock_in,new_billed_clock_out,
    previous_status,new_status,reason_code,reason_notes,previous_calculations,new_calculations,corrected_by,corrected_at
  ) values (
    v_after.id,v_after.user_id,v_after.schedule_id,v_before.schedule_id,v_after.schedule_id,
    v_before.clock_in,v_before.clock_out,v_after.clock_in,v_after.clock_out,
    v_before.billed_clock_in,v_before.billed_clock_out,v_after.billed_clock_in,v_after.billed_clock_out,
    v_before.attendance_status,v_after.attendance_status,'other',p_reason,
    jsonb_build_object('attendance_version',v_before.attendance_version,'total_worked_minutes',v_before.total_worked_minutes,'regular_minutes',v_before.regular_minutes,'pre_shift_overtime_minutes',v_before.pre_shift_overtime_minutes,'post_shift_overtime_minutes',v_before.post_shift_overtime_minutes,'rest_day_overtime_minutes',v_before.rest_day_overtime_minutes,'holiday_overtime_minutes',v_before.holiday_overtime_minutes,'total_overtime_minutes',v_before.total_overtime_minutes),
    jsonb_build_object('attendance_version',v_after.attendance_version,'total_worked_minutes',v_after.total_worked_minutes,'regular_minutes',v_after.regular_minutes,'pre_shift_overtime_minutes',v_after.pre_shift_overtime_minutes,'post_shift_overtime_minutes',v_after.post_shift_overtime_minutes,'rest_day_overtime_minutes',v_after.rest_day_overtime_minutes,'holiday_overtime_minutes',v_after.holiday_overtime_minutes,'total_overtime_minutes',v_after.total_overtime_minutes),
    p_actor_user_id,now()
  );
  insert into public.workforce_audit_logs(actor_user_id,action,entity_type,entity_id,before_data,after_data,reason,metadata)
  values(p_actor_user_id,'wave2a_corrected_state_attendance_repaired','attendance',v_after.id,
    jsonb_build_object('attendance',to_jsonb(v_before),'readiness',to_jsonb(v_readiness_before)),
    jsonb_build_object('attendance',to_jsonb(v_after),'readiness',to_jsonb(v_readiness_after)),p_reason,
    jsonb_build_object('source_reference',p_source_reference,'workbook_evidence',p_workbook_evidence,'period_id',p_period_id,'lifecycle_mode',p_lifecycle_mode,'repair_key',p_repair_key));
  insert into public.wave2a_corrected_attendance_repairs(repair_key,period_id,attendance_id,lifecycle_mode,expected_fingerprint,target_billed_clock_in,target_billed_clock_out,target_billed_minutes,source_reference,workbook_evidence,applied_by)
  values(p_repair_key,p_period_id,v_after.id,p_lifecycle_mode,p_expected_fingerprint,p_new_billed_clock_in,p_new_billed_clock_out,p_expected_new_billed_minutes,p_source_reference,p_workbook_evidence,p_actor_user_id);

  return query select v_after.id,v_before.attendance_version,v_after.attendance_version,v_before.billed_clock_in,v_before.billed_clock_out,v_after.billed_clock_in,v_after.billed_clock_out,v_canonical,v_after.total_worked_minutes,v_after.review_status,v_readiness_after.is_payroll_ready,v_readiness_after.payroll_readiness_blockers;
exception when others then
  perform set_config('workforce.correction_recalculation','false',true);
  raise;
end;
$$;

revoke all on function public.wave2a_corrected_pending_fingerprint(uuid,uuid,text,jsonb,timestamptz,timestamptz,integer) from public, anon, authenticated;
grant execute on function public.wave2a_corrected_pending_fingerprint(uuid,uuid,text,jsonb,timestamptz,timestamptz,integer) to service_role;
revoke all on function public.workforce_wave2a_correct_previously_corrected_attendance(uuid,uuid,uuid,text,text,jsonb,timestamptz,timestamptz,integer,text,jsonb,text) from public, anon, authenticated;
grant execute on function public.workforce_wave2a_correct_previously_corrected_attendance(uuid,uuid,uuid,text,text,jsonb,timestamptz,timestamptz,integer,text,jsonb,text) to service_role;

comment on function public.workforce_wave2a_correct_previously_corrected_attendance(uuid,uuid,uuid,text,text,jsonb,timestamptz,timestamptz,integer,text,jsonb,text) is 'Service-role-only guarded corrected_pending historical attendance repair; requires exact pre-state and workbook evidence fingerprints and preserves prior history.';

-- Dedicated corrected_reapproved Wave 2A mechanism. The generic and
-- corrected_pending RPCs are intentionally not changed by this file.
create table public.wave2a_corrected_reapproved_repairs (
  id uuid primary key default gen_random_uuid(),
  repair_key text not null unique,
  period_id uuid not null references public.payroll_periods(id),
  attendance_id uuid not null unique references public.attendance(id),
  lifecycle_mode text not null check (lifecycle_mode = 'corrected_reapproved'),
  expected_fingerprint jsonb not null,
  target_billed_clock_in timestamptz not null,
  target_billed_clock_out timestamptz not null,
  target_billed_minutes integer not null check (target_billed_minutes > 0),
  source_reference text not null,
  workbook_evidence jsonb not null,
  applied_by uuid not null references public.profiles(user_id),
  applied_at timestamptz not null default now()
);

alter table public.wave2a_corrected_reapproved_repairs enable row level security;
revoke all on table public.wave2a_corrected_reapproved_repairs from public, anon, authenticated, service_role;

create or replace function public.wave2a_corrected_reapproved_fingerprint(
  p_period_id uuid,
  p_attendance_id uuid,
  p_source_reference text,
  p_workbook_evidence jsonb,
  p_target_billed_clock_in timestamptz,
  p_target_billed_clock_out timestamptz,
  p_target_billed_minutes integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_attendance public.attendance%rowtype;
  v_schedule public.work_schedules%rowtype;
  v_period public.payroll_periods%rowtype;
  v_readiness record;
  v_corrections jsonb;
  v_approval_audits jsonb;
  v_active_count bigint;
  v_overlap boolean;
  v_legacy_rows bigint;
  v_legacy_minutes bigint;
begin
  select * into v_attendance from public.attendance where id = p_attendance_id;
  if not found then raise exception 'Attendance record not found.'; end if;

  select * into v_schedule from public.work_schedules where id = v_attendance.schedule_id;
  if not found then raise exception 'Schedule record not found.'; end if;

  select * into v_period from public.payroll_periods where id = p_period_id;
  if not found then raise exception 'Payroll period not found.'; end if;

  select * into v_readiness
  from public.workforce_attendance_payroll_readiness
  where id = p_attendance_id;

  select count(*) into v_active_count
  from public.attendance a
  where a.user_id = v_attendance.user_id
    and a.work_date = v_attendance.work_date
    and a.voided_at is null;

  select exists (
    select 1
    from public.attendance other
    where other.user_id = v_attendance.user_id
      and other.work_date = v_attendance.work_date
      and other.id <> v_attendance.id
      and other.voided_at is null
      and coalesce(other.billed_clock_in, other.clock_in) is not null
      and coalesce(other.billed_clock_out, other.clock_out) is not null
      and coalesce(other.billed_clock_in, other.clock_in)
          < coalesce(v_attendance.billed_clock_out, v_attendance.clock_out)
      and coalesce(v_attendance.billed_clock_in, v_attendance.clock_in)
          < coalesce(other.billed_clock_out, other.clock_out)
  ) into v_overlap;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.corrected_at, x.id), '[]'::jsonb)
  into v_corrections
  from (
    select c.*
    from public.attendance_corrections c
    where c.attendance_id = p_attendance_id
  ) x;

  -- The approval fingerprint is deliberately based on the actual attendance
  -- approval event and the paired update that restored payroll approval. No
  -- payroll_audits row is invented or required.
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at, x.id), '[]'::jsonb)
  into v_approval_audits
  from (
    select l.*
    from public.workforce_audit_logs l
    where l.entity_type = 'attendance'
      and l.entity_id = p_attendance_id
      and (
        l.action = 'attendance_approved'
        or (
          l.action = 'update'
          and l.after_data -> 'attendance' ->> 'review_status' = 'approved'
          and l.after_data -> 'attendance' ->> 'payroll_approved_at' is not null
        )
      )
  ) x;

  select count(*), coalesce(sum(remaining_minutes), 0)
  into v_legacy_rows, v_legacy_minutes
  from public.payroll_prepaid_hours
  where commitment_id is null and voided_at is null;

  return jsonb_build_object(
    'period', jsonb_build_object(
      'id', p_period_id,
      'period_start', v_period.period_start,
      'period_end', v_period.period_end,
      'status', v_period.status,
      'payroll_record_count', (select count(*) from public.payroll_records where payroll_period_id = p_period_id),
      'non_draft_payroll_record_count', (select count(*) from public.payroll_records where payroll_period_id = p_period_id and status <> 'draft'),
      'payroll_item_count', (select count(*) from public.payroll_items i join public.payroll_records r on r.id = i.payroll_record_id where r.payroll_period_id = p_period_id),
      'attendance_snapshot_count', (select count(*) from public.payroll_attendance_snapshots s join public.payroll_records r on r.id = s.payroll_record_id where r.payroll_period_id = p_period_id),
      'schedule_snapshot_count', (select count(*) from public.payroll_schedule_snapshots s join public.payroll_records r on r.id = s.payroll_record_id where r.payroll_period_id = p_period_id),
      'allocation_count', (select count(*) from public.payroll_hour_allocations a join public.payroll_records r on r.id = a.destination_payroll_record_id where r.payroll_period_id = p_period_id),
      'commitment_count', (select count(*) from public.payroll_prepaid_commitments where payroll_period_id = p_period_id),
      'legacy_row_count', v_legacy_rows,
      'legacy_minutes', v_legacy_minutes
    ),
    'attendance', jsonb_build_object(
      'id', v_attendance.id,
      'user_id', v_attendance.user_id,
      'work_date', v_attendance.work_date,
      'schedule_id', v_attendance.schedule_id,
      'attendance_version', v_attendance.attendance_version,
      'clock_in', v_attendance.clock_in,
      'clock_out', v_attendance.clock_out,
      'original_clock_in', v_attendance.original_clock_in,
      'original_clock_out', v_attendance.original_clock_out,
      'billed_clock_in', v_attendance.billed_clock_in,
      'billed_clock_out', v_attendance.billed_clock_out,
      'canonical_billed_minutes', public.workforce_canonical_billed_minutes(v_attendance.billed_clock_in, v_attendance.billed_clock_out),
      'total_worked_minutes', v_attendance.total_worked_minutes,
      'pre_shift_overtime_minutes', v_attendance.pre_shift_overtime_minutes,
      'regular_minutes', v_attendance.regular_minutes,
      'post_shift_overtime_minutes', v_attendance.post_shift_overtime_minutes,
      'rest_day_overtime_minutes', v_attendance.rest_day_overtime_minutes,
      'holiday_overtime_minutes', v_attendance.holiday_overtime_minutes,
      'total_overtime_minutes', v_attendance.total_overtime_minutes,
      'overtime_minutes', v_attendance.overtime_minutes,
      'minutes_late', v_attendance.minutes_late,
      'undertime_minutes', v_attendance.undertime_minutes,
      'attendance_status', v_attendance.attendance_status,
      'review_status', v_attendance.review_status,
      'reviewed_by', v_attendance.reviewed_by,
      'reviewed_at', v_attendance.reviewed_at,
      'payroll_approved_at', v_attendance.payroll_approved_at,
      'is_corrected', v_attendance.is_corrected,
      'voided_at', v_attendance.voided_at,
      'voided_by', v_attendance.voided_by,
      'void_reason', v_attendance.void_reason,
      'active_row_count', v_active_count,
      'overlap_state', v_overlap
    ),
    'schedule', jsonb_build_object(
      'id', v_schedule.id,
      'user_id', v_schedule.user_id,
      'shift_date', v_schedule.shift_date,
      'schedule_version', v_schedule.schedule_version,
      'shift_start', v_schedule.shift_start,
      'shift_end', v_schedule.shift_end,
      'timezone', v_schedule.timezone,
      'status', v_schedule.status,
      'is_rest_day', v_schedule.is_rest_day,
      'is_holiday', v_schedule.is_holiday,
      'is_leave', v_schedule.is_leave,
      'is_absent', v_schedule.is_absent
    ),
    'correction_history', jsonb_build_object('count', jsonb_array_length(v_corrections), 'rows', v_corrections),
    'approval_history', jsonb_build_object('count', jsonb_array_length(v_approval_audits), 'rows', v_approval_audits),
    'readiness', jsonb_build_object('is_payroll_ready', v_readiness.is_payroll_ready, 'blockers', v_readiness.payroll_readiness_blockers),
    'source_reference', p_source_reference,
    'workbook_evidence', p_workbook_evidence,
    'target', jsonb_build_object(
      'billed_clock_in', p_target_billed_clock_in,
      'billed_clock_out', p_target_billed_clock_out,
      'billed_minutes', p_target_billed_minutes
    )
  );
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
  v_other_overtime integer;
  v_available_overtime integer;
  v_canonical integer;
begin
  if p_lifecycle_mode <> 'corrected_reapproved' then
    raise exception 'Only corrected_reapproved is implemented locally.';
  end if;
  if nullif(trim(coalesce(p_repair_key, '')), '') is null
     or nullif(trim(coalesce(p_source_reference, '')), '') is null
     or p_expected_fingerprint is null or p_workbook_evidence is null
     or nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'Repair key, exact fingerprint, workbook evidence, source, and reason are required.';
  end if;
  if p_new_billed_clock_in is null or p_new_billed_clock_out is null
     or p_new_billed_clock_out <= p_new_billed_clock_in
     or p_expected_new_billed_minutes is null or p_expected_new_billed_minutes <= 0 then
    raise exception 'New billed target is invalid.';
  end if;
  if not exists (
    select 1 from public.profiles
    where user_id = p_actor_user_id and is_system_admin is true and account_deleted_at is null
  ) then
    raise exception 'A non-deleted system administrator actor is required.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('wave2a-corrected-reapproved:' || p_attendance_id::text, 0));
  if exists (
    select 1 from public.wave2a_corrected_reapproved_repairs r
    where r.repair_key = p_repair_key or r.attendance_id = p_attendance_id
  ) then
    raise exception 'corrected_reapproved repair was already applied; repeat execution rejected.';
  end if;

  select * into v_period from public.payroll_periods where id = p_period_id for update;
  if not found or v_period.status <> 'draft' then
    raise exception 'Payroll period must exist and remain draft.';
  end if;
  if (select count(*) from public.payroll_records where payroll_period_id = p_period_id) <> 9
     or exists (select 1 from public.payroll_records where payroll_period_id = p_period_id and status <> 'draft') then
    raise exception 'Payroll period record/status guard failed.';
  end if;
  if exists (select 1 from public.payroll_items i join public.payroll_records r on r.id = i.payroll_record_id where r.payroll_period_id = p_period_id)
     or exists (select 1 from public.payroll_attendance_snapshots s join public.payroll_records r on r.id = s.payroll_record_id where r.payroll_period_id = p_period_id)
     or exists (select 1 from public.payroll_schedule_snapshots s join public.payroll_records r on r.id = s.payroll_record_id where r.payroll_period_id = p_period_id)
     or exists (select 1 from public.payroll_hour_allocations a join public.payroll_records r on r.id = a.destination_payroll_record_id where r.payroll_period_id = p_period_id)
     or exists (select 1 from public.payroll_prepaid_commitments where payroll_period_id = p_period_id) then
    raise exception 'Payroll artifacts already exist for this period.';
  end if;
  if (select count(*) from public.payroll_prepaid_hours where commitment_id is null and voided_at is null)
       <> (p_expected_fingerprint->'period'->>'legacy_row_count')::bigint
     or (select coalesce(sum(remaining_minutes), 0) from public.payroll_prepaid_hours where commitment_id is null and voided_at is null)
       <> (p_expected_fingerprint->'period'->>'legacy_minutes')::bigint then
    raise exception 'Grandfathered legacy prepaid fingerprint changed.';
  end if;

  select * into v_before from public.attendance where id = p_attendance_id for update;
  if not found then raise exception 'Attendance record not found.'; end if;
  if v_before.work_date < v_period.period_start or v_before.work_date > v_period.period_end then
    raise exception 'Attendance work date is outside the supplied payroll period.';
  end if;
  if v_before.is_corrected is distinct from true
     or v_before.review_status is distinct from 'approved'
     or v_before.payroll_approved_at is null then
    raise exception 'corrected_reapproved lifecycle guard failed.';
  end if;

  select * into v_schedule from public.work_schedules where id = v_before.schedule_id for share;
  if not found or v_schedule.user_id is distinct from v_before.user_id then
    raise exception 'Schedule ownership guard failed.';
  end if;

  if not exists (
    select 1 from public.workforce_audit_logs l
    where l.entity_type = 'attendance' and l.entity_id = p_attendance_id
      and l.action = 'attendance_approved'
  ) then
    raise exception 'Attendance approval audit evidence is required.';
  end if;
  if not exists (
    select 1 from public.workforce_audit_logs l
    where l.entity_type = 'attendance' and l.entity_id = p_attendance_id
      and l.action = 'update'
      and l.after_data -> 'attendance' ->> 'review_status' = 'approved'
      and l.after_data -> 'attendance' ->> 'payroll_approved_at' is not null
  ) then
    raise exception 'Paired payroll-restoring approval update is required.';
  end if;

  v_actual_fingerprint := public.wave2a_corrected_reapproved_fingerprint(
    p_period_id, p_attendance_id, p_source_reference, p_workbook_evidence,
    p_new_billed_clock_in, p_new_billed_clock_out, p_expected_new_billed_minutes
  );
  if v_actual_fingerprint is distinct from p_expected_fingerprint then
    raise exception 'corrected_reapproved lifecycle fingerprint changed.';
  end if;

  if (select count(*) from public.attendance where user_id = v_before.user_id and work_date = v_before.work_date and voided_at is null) <> 1 then
    raise exception 'Exactly one active attendance row is required.';
  end if;
  if p_new_billed_clock_in >= p_new_billed_clock_out then
    raise exception 'Billed target has invalid order.';
  end if;

  select coalesce(sum(greatest(coalesce(a.total_overtime_minutes, 0), 0)), 0)::integer
  into v_other_overtime
  from public.attendance a
  where a.user_id = v_before.user_id and a.work_date = v_before.work_date and a.id <> v_before.id;
  v_available_overtime := greatest(0, 1200 - v_other_overtime);

  select * into v_calc
  from public.workforce_calculate_attendance(
    v_schedule.shift_start, v_schedule.shift_end,
    p_new_billed_clock_in, p_new_billed_clock_out,
    v_before.work_date, v_schedule.timezone, v_available_overtime,
    v_schedule.is_rest_day, v_schedule.is_holiday
  );
  v_canonical := public.workforce_canonical_billed_minutes(p_new_billed_clock_in, p_new_billed_clock_out);
  if v_canonical is distinct from p_expected_new_billed_minutes
     or v_calc.total_worked_minutes is distinct from v_canonical
     or v_calc.regular_minutes + v_calc.total_overtime_minutes is distinct from v_canonical
     or v_calc.total_overtime_minutes is distinct from
        v_calc.pre_shift_overtime_minutes + v_calc.post_shift_overtime_minutes
        + v_calc.rest_day_overtime_minutes + v_calc.holiday_overtime_minutes then
    raise exception 'Workbook duration or classification calculation is inconsistent.';
  end if;

  select * into v_readiness_before
  from public.workforce_attendance_payroll_readiness where id = v_before.id;

  perform set_config('workforce.correction_recalculation', 'true', true);
  perform set_config('workforce.review_metadata_update', 'true', true);
  update public.attendance
  set billed_clock_in = p_new_billed_clock_in,
      billed_clock_out = p_new_billed_clock_out,
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
      review_status = 'corrected',
      reviewed_by = null,
      reviewed_at = null,
      payroll_approved_at = null,
      correction_reason = 'wave2a_corrected_reapproved_workbook',
      corrected_by = p_actor_user_id,
      corrected_at = now(),
      updated_by = p_actor_user_id,
      updated_at = now()
  where id = v_before.id
  returning * into v_after;
  perform set_config('workforce.correction_recalculation', 'false', true);
  perform set_config('workforce.review_metadata_update', 'false', true);

  if v_after.attendance_version is distinct from v_before.attendance_version + 1
     or v_after.original_clock_in is distinct from v_before.original_clock_in
     or v_after.original_clock_out is distinct from v_before.original_clock_out
     or v_after.schedule_id is distinct from v_before.schedule_id
     or v_after.user_id is distinct from v_before.user_id
     or v_after.work_date is distinct from v_before.work_date
     or v_after.total_worked_minutes is distinct from v_canonical
     or v_after.payroll_approved_at is not null
     or v_after.review_status is distinct from 'corrected' then
    raise exception 'corrected_reapproved post-write invariant failed.';
  end if;

  select * into v_readiness_after
  from public.workforce_attendance_payroll_readiness where id = v_after.id;
  if coalesce(v_readiness_after.is_payroll_ready, false)
     or not ('review_required' = any(v_readiness_after.payroll_readiness_blockers)) then
    raise exception 'Corrected attendance readiness invariant failed.';
  end if;

  insert into public.attendance_corrections (
    attendance_id, employee_user_id, schedule_id, previous_schedule_id, new_schedule_id,
    previous_clock_in, previous_clock_out, new_clock_in, new_clock_out,
    previous_billed_clock_in, previous_billed_clock_out, new_billed_clock_in, new_billed_clock_out,
    previous_status, new_status, reason_code, reason_notes, previous_calculations,
    new_calculations, corrected_by, corrected_at
  ) values (
    v_after.id, v_after.user_id, v_after.schedule_id, v_before.schedule_id, v_after.schedule_id,
    v_before.clock_in, v_before.clock_out, v_after.clock_in, v_after.clock_out,
    v_before.billed_clock_in, v_before.billed_clock_out, v_after.billed_clock_in, v_after.billed_clock_out,
    v_before.attendance_status, v_after.attendance_status, 'other', p_reason,
    jsonb_build_object(
      'attendance_version', v_before.attendance_version,
      'total_worked_minutes', v_before.total_worked_minutes,
      'regular_minutes', v_before.regular_minutes,
      'pre_shift_overtime_minutes', v_before.pre_shift_overtime_minutes,
      'post_shift_overtime_minutes', v_before.post_shift_overtime_minutes,
      'rest_day_overtime_minutes', v_before.rest_day_overtime_minutes,
      'holiday_overtime_minutes', v_before.holiday_overtime_minutes,
      'total_overtime_minutes', v_before.total_overtime_minutes
    ),
    jsonb_build_object(
      'attendance_version', v_after.attendance_version,
      'total_worked_minutes', v_after.total_worked_minutes,
      'regular_minutes', v_after.regular_minutes,
      'pre_shift_overtime_minutes', v_after.pre_shift_overtime_minutes,
      'post_shift_overtime_minutes', v_after.post_shift_overtime_minutes,
      'rest_day_overtime_minutes', v_after.rest_day_overtime_minutes,
      'holiday_overtime_minutes', v_after.holiday_overtime_minutes,
      'total_overtime_minutes', v_after.total_overtime_minutes
    ),
    p_actor_user_id, now()
  );

  insert into public.workforce_audit_logs(
    actor_user_id, action, entity_type, entity_id, before_data, after_data, reason, metadata
  ) values (
    p_actor_user_id, 'wave2a_corrected_reapproved_attendance_repaired', 'attendance', v_after.id,
    jsonb_build_object('attendance', to_jsonb(v_before), 'readiness', to_jsonb(v_readiness_before)),
    jsonb_build_object('attendance', to_jsonb(v_after), 'readiness', to_jsonb(v_readiness_after)),
    p_reason,
    jsonb_build_object(
      'source_reference', p_source_reference,
      'workbook_evidence', p_workbook_evidence,
      'period_id', p_period_id,
      'lifecycle_mode', p_lifecycle_mode,
      'repair_key', p_repair_key,
      'approval_history_preserved', true
    )
  );

  insert into public.wave2a_corrected_reapproved_repairs(
    repair_key, period_id, attendance_id, lifecycle_mode, expected_fingerprint,
    target_billed_clock_in, target_billed_clock_out, target_billed_minutes,
    source_reference, workbook_evidence, applied_by
  ) values (
    p_repair_key, p_period_id, v_after.id, p_lifecycle_mode, p_expected_fingerprint,
    p_new_billed_clock_in, p_new_billed_clock_out, p_expected_new_billed_minutes,
    p_source_reference, p_workbook_evidence, p_actor_user_id
  );

  return query
  select v_after.id, v_before.attendance_version, v_after.attendance_version,
    v_before.billed_clock_in, v_before.billed_clock_out,
    v_after.billed_clock_in, v_after.billed_clock_out,
    v_canonical, v_after.total_worked_minutes,
    v_after.rest_day_overtime_minutes, v_after.total_overtime_minutes,
    v_after.review_status, v_readiness_after.is_payroll_ready,
    v_readiness_after.payroll_readiness_blockers;
exception when others then
  perform set_config('workforce.correction_recalculation', 'false', true);
  perform set_config('workforce.review_metadata_update', 'false', true);
  raise;
end;
$$;

revoke all on function public.wave2a_corrected_reapproved_fingerprint(uuid,uuid,text,jsonb,timestamptz,timestamptz,integer) from public, anon, authenticated;
grant execute on function public.wave2a_corrected_reapproved_fingerprint(uuid,uuid,text,jsonb,timestamptz,timestamptz,integer) to service_role;
revoke all on function public.workforce_wave2a_correct_reapproved_attendance(uuid,uuid,uuid,text,text,jsonb,timestamptz,timestamptz,integer,text,jsonb,text) from public, anon, authenticated;
grant execute on function public.workforce_wave2a_correct_reapproved_attendance(uuid,uuid,uuid,text,text,jsonb,timestamptz,timestamptz,integer,text,jsonb,text) to service_role;

comment on function public.workforce_wave2a_correct_reapproved_attendance(uuid,uuid,uuid,text,text,jsonb,timestamptz,timestamptz,integer,text,jsonb,text)
  is 'Service-role-only guarded corrected_reapproved historical attendance repair; requires verified prior correction and approval provenance and preserves prior history.';


-- Append-only protections for the two dedicated repair ledgers.
create or replace function public.wave2a_repair_ledger_immutable()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'Wave 2A corrected-state repair ledgers are append-only.';
end;
$$;

alter function public.wave2a_repair_ledger_immutable() owner to postgres;
revoke all on function public.wave2a_repair_ledger_immutable() from public, anon, authenticated, service_role;

create trigger wave2a_corrected_attendance_repairs_immutable
before update or delete on public.wave2a_corrected_attendance_repairs
for each row execute function public.wave2a_repair_ledger_immutable();

create trigger wave2a_corrected_reapproved_repairs_immutable
before update or delete on public.wave2a_corrected_reapproved_repairs
for each row execute function public.wave2a_repair_ledger_immutable();

alter table public.wave2a_corrected_attendance_repairs owner to postgres;
alter table public.wave2a_corrected_reapproved_repairs owner to postgres;

alter function public.wave2a_corrected_pending_fingerprint(uuid,uuid,text,jsonb,timestamptz,timestamptz,integer) owner to postgres;
alter function public.workforce_wave2a_correct_previously_corrected_attendance(uuid,uuid,uuid,text,text,jsonb,timestamptz,timestamptz,integer,text,jsonb,text) owner to postgres;
alter function public.wave2a_corrected_reapproved_fingerprint(uuid,uuid,text,jsonb,timestamptz,timestamptz,integer) owner to postgres;
alter function public.workforce_wave2a_correct_reapproved_attendance(uuid,uuid,uuid,text,text,jsonb,timestamptz,timestamptz,integer,text,jsonb,text) owner to postgres;

comment on table public.wave2a_corrected_attendance_repairs is
  'Append-only provenance ledger for guarded corrected_pending historical attendance repairs.';
comment on table public.wave2a_corrected_reapproved_repairs is
  'Append-only provenance ledger for guarded corrected_reapproved historical attendance repairs.';
comment on function public.wave2a_repair_ledger_immutable() is
  'Rejects UPDATE and DELETE on corrected-state repair provenance ledgers.';


commit;

;
