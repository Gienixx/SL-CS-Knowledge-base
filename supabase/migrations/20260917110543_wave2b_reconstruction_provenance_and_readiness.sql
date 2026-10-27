-- Wave 2B reusable reconstruction provenance infrastructure.
-- This migration intentionally contains no period, employee, workbook-path,
-- manifest, attendance-row, or one-time historical repair data.

begin;

create schema if not exists workforce_internal;

revoke all on schema workforce_internal from public, anon, authenticated;
grant usage on schema workforce_internal to service_role;

-- The registry contains only the approved historical source identity for the
-- repair period. It deliberately contains no workbook rows or repair data.
create table workforce_internal.wave2b_approved_source_evidence (
  period_id uuid primary key references public.payroll_periods(id),
  period_start date not null,
  period_end date not null,
  source_type text not null check (source_type = 'historical_workbook'),
  source_filename text not null,
  source_sha256 text not null,
  registered_at timestamptz not null default now(),
  constraint wave2b_approved_source_period_ck check (period_start <= period_end),
  constraint wave2b_approved_source_sha256_ck check (source_sha256 ~ '^[0-9a-f]{64}$')
);

alter table workforce_internal.wave2b_approved_source_evidence enable row level security;
revoke all on table workforce_internal.wave2b_approved_source_evidence from public, anon, authenticated;
grant select on table workforce_internal.wave2b_approved_source_evidence to service_role;

insert into workforce_internal.wave2b_approved_source_evidence (
  period_id, period_start, period_end, source_type, source_filename, source_sha256
) values (
  'b62ee64a-3da9-48d2-8c4e-f9856e352086'::uuid,
  '2026-08-01'::date,
  '2026-08-15'::date,
  'historical_workbook',
  '2026 Support Timesheet.xlsx',
  lower('48F388C1A9683314DD6F1CED42D54353B9E5956F100AC287AE4DE5EAE4444E80')
);

create table workforce_internal.wave2b_reconstruction_ledger (
  id uuid primary key default gen_random_uuid(),
  attendance_id uuid not null unique references public.attendance(id),
  period_id uuid not null references public.payroll_periods(id),
  user_id uuid not null references public.profiles(user_id),
  work_date date not null,
  schedule_id uuid not null references public.work_schedules(id),
  schedule_version bigint not null,
  session_sequence smallint not null default 1 check (session_sequence = 1),
  attendance_version_after_reconstruction bigint not null,
  target_billed_clock_in timestamptz not null,
  target_billed_clock_out timestamptz not null,
  expected_billed_minutes integer not null,
  canonical_minutes_fingerprint integer not null,
  stored_minutes_fingerprint integer not null,
  classification_fingerprint jsonb not null,
  state_fingerprint jsonb not null,
  workbook_filename text not null,
  workbook_sheet text not null,
  workbook_row_reference text not null,
  workbook_sha256 text not null,
  reconstruction_source text not null,
  reconstruction_reason text not null,
  created_by uuid not null references public.profiles(user_id),
  created_at timestamptz not null default now(),
  idempotency_key text not null unique,
  constraint wave2b_reconstruction_ledger_interval_ck
    check (target_billed_clock_out > target_billed_clock_in),
  constraint wave2b_reconstruction_ledger_duration_ck
    check (
      expected_billed_minutes = floor(
        extract(epoch from (target_billed_clock_out - target_billed_clock_in)) / 60
      )::integer
      and expected_billed_minutes > 0
    )
);

create index wave2b_reconstruction_ledger_period_user_date_idx
  on workforce_internal.wave2b_reconstruction_ledger (period_id, user_id, work_date);

create index wave2b_reconstruction_ledger_schedule_idx
  on workforce_internal.wave2b_reconstruction_ledger (schedule_id);

create table workforce_internal.wave2b_reconstruction_lifecycle_events (
  id uuid primary key default gen_random_uuid(),
  ledger_id uuid not null references workforce_internal.wave2b_reconstruction_ledger(id),
  attendance_id uuid not null references public.attendance(id),
  lifecycle_event_type text not null check (lifecycle_event_type in ('approved', 'locked')),
  from_attendance_version bigint not null,
  to_attendance_version bigint not null,
  before_state_fingerprint jsonb not null,
  after_state_fingerprint jsonb not null,
  actor_user_id uuid not null references public.profiles(user_id),
  related_audit_event_id uuid references public.workforce_audit_logs(id),
  created_at timestamptz not null default now(),
  constraint wave2b_reconstruction_lifecycle_step_ck
    check (to_attendance_version = from_attendance_version + 1),
  constraint wave2b_reconstruction_lifecycle_transition_uq
    unique (ledger_id, from_attendance_version, to_attendance_version),
  constraint wave2b_reconstruction_lifecycle_attendance_uq
    unique (id, attendance_id)
);

create index wave2b_reconstruction_lifecycle_attendance_idx
  on workforce_internal.wave2b_reconstruction_lifecycle_events (attendance_id, from_attendance_version, to_attendance_version);

alter table workforce_internal.wave2b_reconstruction_ledger enable row level security;
alter table workforce_internal.wave2b_reconstruction_lifecycle_events enable row level security;

revoke all on table workforce_internal.wave2b_reconstruction_ledger from public, anon, authenticated;
revoke all on table workforce_internal.wave2b_reconstruction_lifecycle_events from public, anon, authenticated;
grant all on table workforce_internal.wave2b_reconstruction_ledger to service_role;
grant all on table workforce_internal.wave2b_reconstruction_lifecycle_events to service_role;

create or replace function workforce_internal.reject_immutable_wave2b_evidence()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'Wave 2B reconstruction evidence is append-only.';
end;
$$;

create trigger wave2b_reconstruction_ledger_immutable
before update or delete on workforce_internal.wave2b_reconstruction_ledger
for each row execute function workforce_internal.reject_immutable_wave2b_evidence();

create trigger wave2b_reconstruction_lifecycle_immutable
before update or delete on workforce_internal.wave2b_reconstruction_lifecycle_events
for each row execute function workforce_internal.reject_immutable_wave2b_evidence();

create or replace function workforce_internal.reject_immutable_wave2b_source_evidence()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'Wave 2B approved source evidence is append-only.';
end;
$$;

create trigger wave2b_approved_source_evidence_immutable
before update or delete on workforce_internal.wave2b_approved_source_evidence
for each row execute function workforce_internal.reject_immutable_wave2b_source_evidence();

-- This fingerprint deliberately excludes mutable review timestamps and audit
-- metadata. It includes every state that can make a reconstructed attendance
-- unsafe to treat as historically verified.
create or replace function workforce_internal.attendance_state_fingerprint(
  p_attendance_id uuid
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'attendance_id', a.id,
    'user_id', a.user_id,
    'work_date', a.work_date,
    'schedule_id', a.schedule_id,
    'raw_clock_in', a.clock_in,
    'raw_clock_out', a.clock_out,
    'original_clock_in', a.original_clock_in,
    'original_clock_out', a.original_clock_out,
    'billed_clock_in', a.billed_clock_in,
    'billed_clock_out', a.billed_clock_out,
    'attendance_status', a.attendance_status,
    'review_status', a.review_status,
    'payroll_approved_at', a.payroll_approved_at,
    'voided_at', a.voided_at,
    'canonical_minutes', public.workforce_canonical_billed_minutes(a.billed_clock_in, a.billed_clock_out),
    'total_worked_minutes', a.total_worked_minutes,
    'pre_shift_overtime_minutes', a.pre_shift_overtime_minutes,
    'regular_minutes', a.regular_minutes,
    'post_shift_overtime_minutes', a.post_shift_overtime_minutes,
    'rest_day_overtime_minutes', a.rest_day_overtime_minutes,
    'holiday_overtime_minutes', a.holiday_overtime_minutes,
    'total_overtime_minutes', a.total_overtime_minutes,
    'schedule', case when s.id is null then null else jsonb_build_object(
      'id', s.id,
      'user_id', s.user_id,
      'shift_date', s.shift_date,
      'schedule_version', s.schedule_version,
      'shift_start', s.shift_start,
      'shift_end', s.shift_end,
      'timezone', s.timezone,
      'status', s.status,
      'is_rest_day', s.is_rest_day,
      'is_holiday', s.is_holiday,
      'is_leave', s.is_leave,
      'is_absent', s.is_absent,
      'planned_paid_minutes', s.planned_paid_minutes
    ) end
  )
  from public.attendance a
  left join public.work_schedules s on s.id = a.schedule_id
  where a.id = p_attendance_id;
$$;

revoke all on function workforce_internal.attendance_state_fingerprint(uuid) from public, anon, authenticated;
grant execute on function workforce_internal.attendance_state_fingerprint(uuid) to service_role;

create or replace function public.workforce_is_verified_reconstructed_attendance(
  p_attendance_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attendance public.attendance%rowtype;
  v_ledger workforce_internal.wave2b_reconstruction_ledger%rowtype;
  v_current_fingerprint jsonb;
  v_duplicate_count bigint;
  v_visible boolean := false;
begin
  if p_attendance_id is null then
    return false;
  end if;

  select a.* into v_attendance
  from public.attendance a
  where a.id = p_attendance_id;
  if not found then
    return false;
  end if;

  if session_user in ('postgres', 'service_role')
     or current_setting('request.jwt.claim.role', true) = 'service_role' then
    v_visible := true;
  else
    v_visible := public.workforce_is_current_identity(v_attendance.user_id)
      or public.workforce_can_view_user(v_attendance.user_id, 'view_team_attendance')
      or public.workforce_can_view_user(v_attendance.user_id, 'manage_schedules');
  end if;
  if not v_visible then
    return false;
  end if;

  select l.* into v_ledger
  from workforce_internal.wave2b_reconstruction_ledger l
  where l.attendance_id = p_attendance_id;
  if not found then
    return false;
  end if;

  if v_attendance.user_id is distinct from v_ledger.user_id
     or v_attendance.work_date is distinct from v_ledger.work_date
     or v_attendance.schedule_id is distinct from v_ledger.schedule_id
     or v_attendance.clock_in is not null
     or v_attendance.clock_out is not null
     or v_attendance.original_clock_in is not null
     or v_attendance.original_clock_out is not null
     or v_attendance.voided_at is not null
     or v_attendance.billed_clock_in is distinct from v_ledger.target_billed_clock_in
     or v_attendance.billed_clock_out is distinct from v_ledger.target_billed_clock_out
     or public.workforce_canonical_billed_minutes(v_attendance.billed_clock_in, v_attendance.billed_clock_out)
          is distinct from v_ledger.canonical_minutes_fingerprint
     or v_attendance.total_worked_minutes is distinct from v_ledger.stored_minutes_fingerprint then
    return false;
  end if;

  select count(*) into v_duplicate_count
  from public.attendance other_row
  where other_row.user_id = v_attendance.user_id
    and other_row.work_date = v_attendance.work_date
    and other_row.id <> v_attendance.id
    and other_row.voided_at is null
    and coalesce(other_row.billed_clock_in, other_row.clock_in) is not null
    and coalesce(other_row.billed_clock_out, other_row.clock_out) is not null
    and coalesce(other_row.billed_clock_in, other_row.clock_in) < v_ledger.target_billed_clock_out
    and v_ledger.target_billed_clock_in < coalesce(other_row.billed_clock_out, other_row.clock_out);
  if v_duplicate_count <> 0 then
    return false;
  end if;

  v_current_fingerprint := workforce_internal.attendance_state_fingerprint(p_attendance_id);
  if v_current_fingerprint is null then
    return false;
  end if;

  if v_attendance.attendance_version = v_ledger.attendance_version_after_reconstruction then
    return v_current_fingerprint = v_ledger.state_fingerprint;
  end if;

  return exists (
    with recursive lifecycle_chain(version_no, state_fingerprint, depth) as (
      select v_ledger.attendance_version_after_reconstruction,
             v_ledger.state_fingerprint,
             0
      union all
      select e.to_attendance_version,
             e.after_state_fingerprint,
             c.depth + 1
      from lifecycle_chain c
      join workforce_internal.wave2b_reconstruction_lifecycle_events e
        on e.ledger_id = v_ledger.id
       and e.from_attendance_version = c.version_no
       and e.before_state_fingerprint = c.state_fingerprint
      where c.depth < 100
    )
    select 1
    from lifecycle_chain c
    where c.version_no = v_attendance.attendance_version
      and c.state_fingerprint = v_current_fingerprint
      and c.depth > 0
  );
end;
$$;

revoke all on function public.workforce_is_verified_reconstructed_attendance(uuid) from public, anon;
grant execute on function public.workforce_is_verified_reconstructed_attendance(uuid) to authenticated, service_role;

create or replace function public.workforce_wave2b_reconstruct_missing_attendance(
  p_manifest jsonb,
  p_actor_user_id uuid
)
returns table (
  ledger_id uuid,
  attendance_id uuid,
  attendance_version bigint,
  billed_clock_in timestamptz,
  billed_clock_out timestamptz,
  canonical_billed_minutes integer,
  total_worked_minutes integer,
  pre_shift_overtime_minutes integer,
  regular_minutes integer,
  post_shift_overtime_minutes integer,
  rest_day_overtime_minutes integer,
  holiday_overtime_minutes integer,
  total_overtime_minutes integer,
  clock_in timestamptz,
  clock_out timestamptz,
  original_clock_in timestamptz,
  original_clock_out timestamptz,
  review_status text,
  payroll_approved_at timestamptz,
  is_payroll_ready boolean,
  payroll_readiness_blockers text[]
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period_id uuid := nullif(p_manifest->>'period_id', '')::uuid;
  v_user_id uuid := nullif(p_manifest->>'user_id', '')::uuid;
  v_work_date date := nullif(p_manifest->>'work_date', '')::date;
  v_schedule_id uuid := nullif(p_manifest->>'schedule_id', '')::uuid;
  v_schedule_version bigint := nullif(p_manifest->>'schedule_version', '')::bigint;
  v_schedule_mode text := p_manifest->>'schedule_mode';
  v_target_in timestamptz := nullif(p_manifest #>> '{evidence,target_billed_clock_in}', '')::timestamptz;
  v_target_out timestamptz := nullif(p_manifest #>> '{evidence,target_billed_clock_out}', '')::timestamptz;
  v_expected_minutes integer := nullif(p_manifest #>> '{evidence,expected_billed_minutes}', '')::integer;
  v_idempotency_key text := p_manifest #>> '{evidence,idempotency_key}';
  v_source_reference text := p_manifest->>'source_reference';
  v_source text := p_manifest #>> '{evidence,source}';
  v_filename text := p_manifest #>> '{evidence,workbook_filename}';
  v_sheet text := p_manifest #>> '{evidence,sheet}';
  v_row_reference text := p_manifest #>> '{evidence,row_reference}';
  v_sha256 text := p_manifest #>> '{evidence,workbook_sha256}';
  v_reason text := p_manifest->>'reason';
  v_expected_void_count bigint := nullif(p_manifest->>'expected_void_history_count', '')::bigint;
  v_expected_payroll_records bigint := nullif(p_manifest #>> '{financial,payroll_record_count}', '')::bigint;
  v_expected_legacy_rows bigint := nullif(p_manifest #>> '{financial,legacy_prepaid_row_count}', '')::bigint;
  v_expected_legacy_minutes bigint := nullif(p_manifest #>> '{financial,legacy_prepaid_minutes}', '')::bigint;
  v_period public.payroll_periods%rowtype;
  v_schedule public.work_schedules%rowtype;
  v_after public.attendance%rowtype;
  v_readiness record;
  v_ledger_id uuid;
  v_canonical integer;
  v_prepaid_rows bigint;
  v_prepaid_minutes bigint;
  v_state_fingerprint jsonb;
  v_classification_fingerprint jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if current_user not in ('postgres', 'service_role') then
    raise exception 'Wave 2B reconstruction is restricted to controlled service execution.';
  end if;
  if p_manifest is null or p_actor_user_id is null then
    raise exception 'Manifest and reconstruction actor are required.';
  end if;
  if not exists (
    select 1 from public.profiles p
    where p.user_id = p_actor_user_id
      and p.is_system_admin is true
      and p.account_deleted_at is null
  ) then
    raise exception 'A non-deleted system administrator actor is required.';
  end if;
  if v_period_id is null or v_user_id is null or v_work_date is null or v_schedule_id is null
     or v_schedule_version is null or v_schedule_mode not in ('rest_day', 'timed_workday')
     or v_target_in is null or v_target_out is null or v_expected_minutes is null
     or v_idempotency_key is null or v_source_reference is null or v_source is null
     or v_filename is null or v_sheet is null or v_row_reference is null or v_sha256 is null
     or v_reason is null or v_expected_void_count is null or v_expected_payroll_records is null
     or v_expected_legacy_rows is null or v_expected_legacy_minutes is null then
    raise exception 'Manifest is incomplete.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('wave2b:' || v_idempotency_key, 0));
  if exists (
    select 1 from workforce_internal.wave2b_reconstruction_ledger l
    where l.idempotency_key = v_idempotency_key
       or (l.user_id = v_user_id and l.work_date = v_work_date)
  ) then
    raise exception 'Reconstruction already exists; repeat execution rejected.';
  end if;

  select * into v_period from public.payroll_periods p where p.id = v_period_id for update;
  if not found or v_period.status <> 'draft'
     or v_work_date < v_period.period_start or v_work_date > v_period.period_end then
    raise exception 'Draft payroll period/date guard failed.';
  end if;
  if (select count(*) from public.payroll_records r where r.payroll_period_id = v_period_id)
       <> v_expected_payroll_records
     or exists (select 1 from public.payroll_records r where r.payroll_period_id = v_period_id and r.status <> 'draft') then
    raise exception 'Payroll record/status guard failed.';
  end if;
  if exists (select 1 from public.payroll_items i join public.payroll_records r on r.id = i.payroll_record_id where r.payroll_period_id = v_period_id)
     or exists (select 1 from public.payroll_attendance_snapshots s join public.payroll_records r on r.id = s.payroll_record_id where r.payroll_period_id = v_period_id)
     or exists (select 1 from public.payroll_schedule_snapshots s join public.payroll_records r on r.id = s.payroll_record_id where r.payroll_period_id = v_period_id)
     or exists (select 1 from public.payroll_hour_allocations a join public.payroll_records r on r.id = a.destination_payroll_record_id where r.payroll_period_id = v_period_id)
     or exists (select 1 from public.payroll_prepaid_commitments c where c.payroll_period_id = v_period_id) then
    raise exception 'Payroll artifact guard failed.';
  end if;
  select count(*), coalesce(sum(h.remaining_minutes), 0)
    into v_prepaid_rows, v_prepaid_minutes
  from public.payroll_prepaid_hours h
  where h.commitment_id is null and h.voided_at is null;
  if v_prepaid_rows <> v_expected_legacy_rows or v_prepaid_minutes <> v_expected_legacy_minutes then
    raise exception 'Disposable prepaid fingerprint guard failed.';
  end if;

  if not exists (select 1 from public.profiles p where p.user_id = v_user_id and p.account_deleted_at is null) then
    raise exception 'Manifest employee does not exist.';
  end if;
  if not exists (
    select 1
    from workforce_internal.wave2b_approved_source_evidence e
    where e.period_id = v_period_id
      and v_work_date between e.period_start and e.period_end
      and v_source = e.source_type
      and v_filename = e.source_filename
      and lower(trim(v_sha256)) = e.source_sha256
  ) then
    raise exception 'Approved Wave 2B reconstruction source evidence guard failed.';
  end if;
  if (select count(*) from public.attendance a where a.user_id = v_user_id and a.work_date = v_work_date and a.voided_at is null) <> 0
     or (select count(*) from public.attendance a where a.user_id = v_user_id and a.work_date = v_work_date and a.voided_at is not null) <> v_expected_void_count then
    raise exception 'Missing-attendance/void-history guard failed.';
  end if;

  select * into v_schedule from public.work_schedules s where s.id = v_schedule_id for share;
  if not found
     or v_schedule.user_id is distinct from v_user_id
     or v_schedule.shift_date is distinct from v_work_date
     or v_schedule.schedule_version is distinct from v_schedule_version
     or v_schedule.timezone is distinct from p_manifest #>> '{schedule,timezone}'
     or v_schedule.is_rest_day is distinct from (p_manifest #>> '{schedule,is_rest_day}')::boolean
     or v_schedule.is_holiday is distinct from (p_manifest #>> '{schedule,is_holiday}')::boolean
     or v_schedule.is_leave is distinct from (p_manifest #>> '{schedule,is_leave}')::boolean
     or v_schedule.is_absent is distinct from (p_manifest #>> '{schedule,is_absent}')::boolean
     or v_schedule.shift_start is distinct from nullif(p_manifest #>> '{schedule,shift_start}', '')::timestamptz
     or v_schedule.shift_end is distinct from nullif(p_manifest #>> '{schedule,shift_end}', '')::timestamptz then
    raise exception 'Schedule ownership/version/fingerprint guard failed.';
  end if;
  if v_schedule_mode = 'rest_day' and (not v_schedule.is_rest_day or v_schedule.shift_start is not null or v_schedule.shift_end is not null) then
    raise exception 'Rest Day mode guard failed.';
  end if;
  if v_schedule_mode = 'timed_workday' and (v_schedule.is_rest_day or v_schedule.shift_start is null or v_schedule.shift_end is null) then
    raise exception 'Timed workday mode guard failed.';
  end if;

  v_canonical := public.workforce_canonical_billed_minutes(v_target_in, v_target_out);
  if v_canonical is distinct from v_expected_minutes then
    raise exception 'Workbook billed duration guard failed.';
  end if;
  if exists (
    select 1 from public.attendance a
    where a.user_id = v_user_id and a.work_date = v_work_date and a.voided_at is null
      and coalesce(a.billed_clock_in, a.clock_in) is not null
      and coalesce(a.billed_clock_out, a.clock_out) is not null
      and coalesce(a.billed_clock_in, a.clock_in) < v_target_out
      and v_target_in < coalesce(a.billed_clock_out, a.clock_out)
  ) then
    raise exception 'Attendance overlap guard failed.';
  end if;

  insert into public.attendance (
    user_id, schedule_id, work_date, clock_in, clock_out,
    original_clock_in, original_clock_out, billed_clock_in, billed_clock_out,
    attendance_status, review_status, payroll_approved_at, corrected_by,
    corrected_at, correction_reason, admin_notes, created_by, updated_by
  ) values (
    v_user_id, v_schedule_id, v_work_date, null, null, null, null,
    v_target_in, v_target_out, 'present', 'corrected', null, p_actor_user_id,
    v_now, 'wave2b_missing_attendance_reconstruction',
    format('Historical single-session reconstruction. source=%s workbook=%s sheet=%s row=%s sha256=%s idempotency=%s', v_source, v_filename, v_sheet, v_row_reference, v_sha256, v_idempotency_key),
    p_actor_user_id, p_actor_user_id
  ) returning * into v_after;

  v_after := public.workforce_recalculate_attendance(v_after.id);
  select * into v_after from public.attendance a where a.id = v_after.id;
  v_canonical := public.workforce_canonical_billed_minutes(v_after.billed_clock_in, v_after.billed_clock_out);
  if v_after.clock_in is not null or v_after.clock_out is not null
     or v_after.original_clock_in is not null or v_after.original_clock_out is not null
     or v_after.billed_clock_in is distinct from v_target_in
     or v_after.billed_clock_out is distinct from v_target_out
     or v_after.total_worked_minutes is distinct from v_canonical
     or v_canonical is distinct from v_expected_minutes
     or v_after.total_worked_minutes is distinct from coalesce(v_after.regular_minutes, 0) + coalesce(v_after.total_overtime_minutes, 0)
     or v_after.total_overtime_minutes is distinct from coalesce(v_after.pre_shift_overtime_minutes, 0) + coalesce(v_after.post_shift_overtime_minutes, 0) + coalesce(v_after.rest_day_overtime_minutes, 0) + coalesce(v_after.holiday_overtime_minutes, 0)
     or v_after.review_status is distinct from 'corrected'
     or v_after.payroll_approved_at is not null
     or v_after.schedule_id is distinct from v_schedule_id then
    raise exception 'Reconstruction postcondition failed.';
  end if;

  select r.is_payroll_ready, r.payroll_readiness_blockers into v_readiness
  from public.workforce_attendance_payroll_readiness r where r.id = v_after.id;
  if coalesce(v_readiness.is_payroll_ready, false)
     or not ('review_required' = any(coalesce(v_readiness.payroll_readiness_blockers, '{}'::text[]))) then
    raise exception 'Reconstruction readiness postcondition failed.';
  end if;

  v_classification_fingerprint := jsonb_build_object(
    'pre_shift_overtime_minutes', v_after.pre_shift_overtime_minutes,
    'regular_minutes', v_after.regular_minutes,
    'post_shift_overtime_minutes', v_after.post_shift_overtime_minutes,
    'rest_day_overtime_minutes', v_after.rest_day_overtime_minutes,
    'holiday_overtime_minutes', v_after.holiday_overtime_minutes,
    'total_overtime_minutes', v_after.total_overtime_minutes
  );
  v_state_fingerprint := workforce_internal.attendance_state_fingerprint(v_after.id);

  insert into workforce_internal.wave2b_reconstruction_ledger (
    attendance_id, period_id, user_id, work_date, schedule_id, schedule_version,
    session_sequence, attendance_version_after_reconstruction, target_billed_clock_in,
    target_billed_clock_out, expected_billed_minutes, canonical_minutes_fingerprint,
    stored_minutes_fingerprint, classification_fingerprint, state_fingerprint,
    workbook_filename, workbook_sheet, workbook_row_reference, workbook_sha256,
    reconstruction_source, reconstruction_reason, created_by, created_at, idempotency_key
  ) values (
    v_after.id, v_period_id, v_user_id, v_work_date, v_schedule_id, v_schedule_version,
    1, v_after.attendance_version, v_target_in, v_target_out, v_expected_minutes,
    v_canonical, v_after.total_worked_minutes, v_classification_fingerprint, v_state_fingerprint,
    v_filename, v_sheet, v_row_reference, v_sha256, v_source, v_reason,
    p_actor_user_id, v_now, v_idempotency_key
  ) returning id into v_ledger_id;

  insert into public.workforce_audit_logs (
    actor_user_id, action, entity_type, entity_id, before_data, after_data, reason, metadata
  ) values (
    p_actor_user_id, 'wave2b_missing_attendance_reconstructed', 'attendance', v_after.id,
    null, jsonb_build_object('attendance', to_jsonb(v_after), 'readiness', to_jsonb(v_readiness)),
    v_reason,
    jsonb_build_object(
      'ledger_id', v_ledger_id,
      'reconstruction_source', v_source,
      'source_reference', v_source_reference,
      'workbook_filename', v_filename,
      'sheet', v_sheet,
      'source_row_reference', v_row_reference,
      'workbook_sha256', v_sha256,
      'idempotency_key', v_idempotency_key,
      'raw_timestamps_intentionally_null', true
    )
  );

  select count(*), coalesce(sum(h.remaining_minutes), 0)
    into v_prepaid_rows, v_prepaid_minutes
  from public.payroll_prepaid_hours h
  where h.commitment_id is null and h.voided_at is null;
  if v_prepaid_rows <> v_expected_legacy_rows or v_prepaid_minutes <> v_expected_legacy_minutes
     or (select count(*) from public.payroll_items i join public.payroll_records r on r.id = i.payroll_record_id where r.payroll_period_id = v_period_id) <> 0
     or (select count(*) from public.payroll_attendance_snapshots s join public.payroll_records r on r.id = s.payroll_record_id where r.payroll_period_id = v_period_id) <> 0
     or (select count(*) from public.payroll_schedule_snapshots s join public.payroll_records r on r.id = s.payroll_record_id where r.payroll_period_id = v_period_id) <> 0
     or (select count(*) from public.payroll_hour_allocations a join public.payroll_records r on r.id = a.destination_payroll_record_id where r.payroll_period_id = v_period_id) <> 0
     or (select count(*) from public.payroll_prepaid_commitments c where c.payroll_period_id = v_period_id) <> 0 then
    raise exception 'Protected financial fingerprint changed.';
  end if;

  return query select v_ledger_id, v_after.id, v_after.attendance_version,
    v_after.billed_clock_in, v_after.billed_clock_out, v_canonical,
    v_after.total_worked_minutes, v_after.pre_shift_overtime_minutes,
    v_after.regular_minutes, v_after.post_shift_overtime_minutes,
    v_after.rest_day_overtime_minutes, v_after.holiday_overtime_minutes,
    v_after.total_overtime_minutes, v_after.clock_in, v_after.clock_out,
    v_after.original_clock_in, v_after.original_clock_out, v_after.review_status,
    v_after.payroll_approved_at, v_readiness.is_payroll_ready,
    v_readiness.payroll_readiness_blockers;
end;
$$;

revoke all on function public.workforce_wave2b_reconstruct_missing_attendance(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.workforce_wave2b_reconstruct_missing_attendance(jsonb, uuid) to service_role;

-- Patch the committed approval definition instead of retyping it. This keeps
-- its signature, owner, FOR UPDATE, validator, lock, version, and audit logic.
do $$
declare
  v_definition text := replace(pg_get_functiondef('public.workforce_review_attendance(uuid,text,text)'::regprocedure), chr(13), '');
  v_updated text;
begin
  v_updated := replace(
    v_definition,
    E'  v_canonical_billed_minutes integer;\n  v_review_notes text := nullif(trim(coalesce(p_review_notes, '''')), '''');',
    E'  v_canonical_billed_minutes integer;\n  v_reconstruction_ledger_id uuid;\n  v_reconstruction_before_fingerprint jsonb;\n  v_reconstruction_after_fingerprint jsonb;\n  v_approval_audit_id uuid;\n  v_review_notes text := nullif(trim(coalesce(p_review_notes, '''')), '''');'
  );
  if v_updated = v_definition then
    v_updated := replace(
      v_definition,
      E'  v_review_notes text := nullif(trim(coalesce(p_review_notes, '''')), '''');',
      E'  v_reconstruction_ledger_id uuid;\n  v_reconstruction_before_fingerprint jsonb;\n  v_reconstruction_after_fingerprint jsonb;\n  v_approval_audit_id uuid;\n  v_review_notes text := nullif(trim(coalesce(p_review_notes, '''')), '''');'
    );
  end if;
  if v_updated = v_definition then
    raise exception 'Approval definition declaration anchor was not found.';
  end if;
  v_updated := replace(
    v_updated,
    E'  if p_review_status = ''approved'' then\n    if v_attendance.review_status = ''approved'' then',
    E'  select l.id, workforce_internal.attendance_state_fingerprint(v_attendance.id)\n  into v_reconstruction_ledger_id, v_reconstruction_before_fingerprint\n  from workforce_internal.wave2b_reconstruction_ledger l\n  where l.attendance_id = v_attendance.id;\n\n  if v_reconstruction_ledger_id is not null\n     and (v_attendance.clock_in is null or v_attendance.clock_out is null)\n     and not public.workforce_is_verified_reconstructed_attendance(v_attendance.id) then\n    raise exception ''Verified reconstruction provenance is required before approval or locking.'';\n  end if;\n\n  if p_review_status = ''approved'' then\n    if v_attendance.review_status = ''approved'' then'
  );
  if v_updated = v_definition or position('workforce_internal.wave2b_reconstruction_ledger' in v_updated) = 0 then
    raise exception 'Approval provenance guard anchor was not found.';
  end if;
  v_updated := replace(
    v_updated,
    E'    if v_attendance.attendance_status = ''present''\n       and (v_effective_clock_in is null or v_effective_clock_out is null) then',
    E'    if v_attendance.attendance_status = ''present''\n       and (v_attendance.clock_in is null or v_attendance.clock_out is null)\n       and not public.workforce_is_verified_reconstructed_attendance(v_attendance.id) then'
  );
  if position(E'    if v_attendance.attendance_status = ''present''\n       and (v_attendance.clock_in is null or v_attendance.clock_out is null)\n       and not public.workforce_is_verified_reconstructed_attendance(v_attendance.id) then' in v_updated) = 0 then
    v_updated := replace(
      v_updated,
      E'    if v_attendance.attendance_status = ''present''\n       and (v_attendance.clock_in is null or v_attendance.clock_out is null) then',
      E'    if v_attendance.attendance_status = ''present''\n       and (v_attendance.clock_in is null or v_attendance.clock_out is null)\n       and not public.workforce_is_verified_reconstructed_attendance(v_attendance.id) then'
    );
  end if;
  if position(E'    if v_attendance.attendance_status = ''present''\n       and (v_attendance.clock_in is null or v_attendance.clock_out is null)\n       and not public.workforce_is_verified_reconstructed_attendance(v_attendance.id) then' in v_updated) = 0 then
    raise exception 'Approval raw-clock provenance guard was not installed.';
  end if;
  v_updated := replace(
    v_updated,
    E'    coalesce(v_review_notes, concat(''Attendance '', p_review_status, '' through Team Attendance''))\n  );\n\n  return v_result;',
    E'    coalesce(v_review_notes, concat(''Attendance '', p_review_status, '' through Team Attendance''))\n  )\n  returning id into v_approval_audit_id;\n\n  if v_reconstruction_ledger_id is not null then\n    v_reconstruction_after_fingerprint := workforce_internal.attendance_state_fingerprint(v_result.id);\n    if v_result.attendance_version is distinct from v_attendance.attendance_version + 1 then\n      raise exception ''Reconstructed attendance lifecycle did not advance exactly one version.'';\n    end if;\n    insert into workforce_internal.wave2b_reconstruction_lifecycle_events (\n      ledger_id, attendance_id, lifecycle_event_type, from_attendance_version,\n      to_attendance_version, before_state_fingerprint, after_state_fingerprint,\n      actor_user_id, related_audit_event_id\n    ) values (\n      v_reconstruction_ledger_id, v_result.id, p_review_status,\n      v_attendance.attendance_version, v_result.attendance_version,\n      v_reconstruction_before_fingerprint, v_reconstruction_after_fingerprint,\n      v_actor_user_id, v_approval_audit_id\n    );\n  end if;\n\n  return v_result;'
  );
  if position('related_audit_event_id' in v_updated) = 0 then
    v_updated := replace(
      v_updated,
      E'  return v_result;',
      E'  if v_reconstruction_ledger_id is not null then\n    select l.id into v_approval_audit_id\n    from public.workforce_audit_logs l\n    where l.entity_type = ''attendance''\n      and l.entity_id = v_result.id\n      and l.actor_user_id = v_actor_user_id\n      and l.action = case p_review_status when ''approved'' then ''attendance_approved'' else ''attendance_locked'' end\n    order by l.created_at desc, l.id desc\n    limit 1;\n    v_reconstruction_after_fingerprint := workforce_internal.attendance_state_fingerprint(v_result.id);\n    if v_result.attendance_version is distinct from v_attendance.attendance_version + 1 then\n      raise exception ''Reconstructed attendance lifecycle did not advance exactly one version.'';\n    end if;\n    insert into workforce_internal.wave2b_reconstruction_lifecycle_events (ledger_id, attendance_id, lifecycle_event_type, from_attendance_version, to_attendance_version, before_state_fingerprint, after_state_fingerprint, actor_user_id, related_audit_event_id)\n    values (v_reconstruction_ledger_id, v_result.id, p_review_status, v_attendance.attendance_version, v_result.attendance_version, v_reconstruction_before_fingerprint, v_reconstruction_after_fingerprint, v_actor_user_id, v_approval_audit_id);\n  end if;\n\n  return v_result;'
    );
  end if;
  if position('related_audit_event_id' in v_updated) = 0 then
    raise exception 'Approval lifecycle insertion anchor was not found.';
  end if;
  execute v_updated;
end;
$$;

comment on function public.workforce_review_attendance(uuid, text, text) is
  'Approves or locks attendance using the existing effective billed validation and requiring verified provenance for raw-null reconstructed attendance.';

revoke all on function public.workforce_review_attendance(uuid, text, text) from public, anon;
grant execute on function public.workforce_review_attendance(uuid, text, text) to authenticated, service_role;

-- Preserve the committed readiness definition and alter only the two raw-clock
-- blockers. CREATE OR REPLACE retains the output contract; the option is stated
-- explicitly because readiness must remain RLS-preserving.
do $$
declare
  v_definition text := replace(pg_get_viewdef('public.workforce_attendance_payroll_readiness'::regclass, true), chr(13), '');
  v_updated text;
begin
  if position('workforce_is_verified_reconstructed_attendance(a.id)' in v_definition) > 0 then
    -- The target guard is already present in this deployed definition; keep
    -- the committed view body byte-for-byte unchanged.
    v_updated := v_definition;
  else
    v_updated := regexp_replace(
      v_definition,
      E'(?i)when[[:space:]]+attendance_row\\.clock_in[[:space:]]+is[[:space:]]+null[[:space:]]+then[[:space:]]+''missing_clock_in''::text',
      E'when attendance_row.clock_in is null\n       and not (public.workforce_is_verified_reconstructed_attendance(attendance_row.id)\n                and attendance_row.review_status in (''approved'', ''locked'')\n                and attendance_row.payroll_approved_at is not null)\n        then ''missing_clock_in''::text',
      'g'
    );
    v_updated := regexp_replace(
      v_updated,
      E'(?i)when[[:space:]]+attendance_row\\.clock_out[[:space:]]+is[[:space:]]+null[[:space:]]+then[[:space:]]+''missing_clock_out''::text',
      E'when attendance_row.clock_out is null\n       and not (public.workforce_is_verified_reconstructed_attendance(attendance_row.id)\n                and attendance_row.review_status in (''approved'', ''locked'')\n                and attendance_row.payroll_approved_at is not null)\n        then ''missing_clock_out''::text',
      'g'
    );
  end if;
  if position('missing_clock_in' in v_updated) = 0
     or position('missing_clock_out' in v_updated) = 0
     or (position('workforce_is_verified_reconstructed_attendance(attendance_row.id)' in v_updated) = 0
         and position('workforce_is_verified_reconstructed_attendance(a.id)' in v_updated) = 0) then
    raise exception 'Readiness raw-clock blocker anchors were not found.';
  end if;
  execute 'create or replace view public.workforce_attendance_payroll_readiness with (security_invoker = true) as ' || v_updated;
end;
$$;

revoke all on public.workforce_attendance_payroll_readiness from public, anon;
grant select on public.workforce_attendance_payroll_readiness to authenticated, service_role;

comment on table workforce_internal.wave2b_reconstruction_ledger is
  'Immutable Wave 2B historical reconstruction evidence; never client-readable.';
comment on table workforce_internal.wave2b_reconstruction_lifecycle_events is
  'Append-only, explicitly supported Wave 2B post-reconstruction lifecycle transitions.';
comment on function public.workforce_is_verified_reconstructed_attendance(uuid) is
  'Returns only whether the caller-visible attendance has immutable, current Wave 2B reconstruction provenance.';

commit;

;
