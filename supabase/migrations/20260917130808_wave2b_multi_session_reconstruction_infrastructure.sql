-- Wave 2B historical multi-session reconstruction infrastructure only.
-- No employee, attendance, schedule, payroll, or workbook-row data is seeded.
-- This migration is intentionally separate from the frozen single-session RPC.

begin;

create schema if not exists workforce_internal;
revoke all on schema workforce_internal from public, anon, authenticated;
grant usage on schema workforce_internal to service_role;

create table workforce_internal.wave2b_multi_session_reconstructions (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references public.payroll_periods(id),
  user_id uuid not null references public.profiles(user_id),
  work_date date not null,
  source_schedule_id uuid not null references public.work_schedules(id),
  source_schedule_version bigint not null,
  source_schedule_mode text not null check (source_schedule_mode in ('rest_day', 'timed_workday')),
  source_schedule_fingerprint jsonb not null,
  source_type text not null check (source_type = 'historical_workbook'),
  source_filename text not null,
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_sheet text not null,
  source_row_reference text not null,
  source_reference text not null,
  expected_session_count smallint not null check (expected_session_count > 1 and expected_session_count <= 32),
  expected_total_minutes integer not null check (expected_total_minutes > 0),
  pre_state_fingerprint jsonb not null,
  reconstruction_state text not null default 'complete' check (reconstruction_state = 'complete'),
  created_by uuid not null references public.profiles(user_id),
  created_at timestamptz not null default now(),
  idempotency_key text not null unique,
  constraint wave2b_multi_session_one_per_employee_date unique (period_id, user_id, work_date)
);

create table workforce_internal.wave2b_multi_session_evidence (
  id uuid primary key default gen_random_uuid(),
  reconstruction_id uuid not null references workforce_internal.wave2b_multi_session_reconstructions(id),
  session_sequence smallint not null check (session_sequence >= 1),
  source_schedule_id uuid not null references public.work_schedules(id),
  physical_schedule_id uuid references public.work_schedules(id),
  physical_schedule_linkage text not null check (physical_schedule_linkage in ('source_schedule', 'scheduleless')),
  target_billed_clock_in timestamptz not null,
  target_billed_clock_out timestamptz not null,
  expected_billed_minutes integer not null check (expected_billed_minutes > 0),
  attendance_id uuid not null unique references public.attendance(id),
  attendance_version_after_reconstruction bigint not null,
  canonical_minutes_fingerprint integer not null,
  stored_minutes_fingerprint integer not null,
  classification_fingerprint jsonb not null,
  state_fingerprint jsonb not null,
  created_at timestamptz not null default now(),
  constraint wave2b_multi_session_evidence_sequence_uq unique (reconstruction_id, session_sequence),
  constraint wave2b_multi_session_evidence_interval_uq unique (reconstruction_id, target_billed_clock_in, target_billed_clock_out),
  constraint wave2b_multi_session_evidence_interval_ck check (target_billed_clock_out > target_billed_clock_in),
  constraint wave2b_multi_session_evidence_duration_ck check (
    expected_billed_minutes = floor(extract(epoch from (target_billed_clock_out - target_billed_clock_in)) / 60)::integer
  ),
  constraint wave2b_multi_session_evidence_linkage_ck check (
    (physical_schedule_linkage = 'source_schedule' and physical_schedule_id is not null)
    or (physical_schedule_linkage = 'scheduleless' and physical_schedule_id is null)
  )
);

create table workforce_internal.wave2b_multi_session_lifecycle_events (
  id uuid primary key default gen_random_uuid(),
  reconstruction_id uuid not null references workforce_internal.wave2b_multi_session_reconstructions(id),
  evidence_id uuid not null references workforce_internal.wave2b_multi_session_evidence(id),
  attendance_id uuid not null references public.attendance(id),
  from_review_status text not null check (from_review_status in ('corrected', 'approved')),
  to_review_status text not null check (to_review_status in ('approved', 'locked')),
  before_state_fingerprint jsonb not null,
  after_state_fingerprint jsonb not null,
  actor_user_id uuid not null references public.profiles(user_id),
  created_at timestamptz not null default now(),
  constraint wave2b_multi_session_lifecycle_uq unique (evidence_id, from_review_status, to_review_status)
);

create index wave2b_multi_session_reconstructions_period_user_date_idx
  on workforce_internal.wave2b_multi_session_reconstructions (period_id, user_id, work_date);
create index wave2b_multi_session_evidence_attendance_idx
  on workforce_internal.wave2b_multi_session_evidence (attendance_id);
create index wave2b_multi_session_lifecycle_attendance_idx
  on workforce_internal.wave2b_multi_session_lifecycle_events (attendance_id);

alter table workforce_internal.wave2b_multi_session_reconstructions enable row level security;
alter table workforce_internal.wave2b_multi_session_evidence enable row level security;
alter table workforce_internal.wave2b_multi_session_lifecycle_events enable row level security;
revoke all on table workforce_internal.wave2b_multi_session_reconstructions from public, anon, authenticated;
revoke all on table workforce_internal.wave2b_multi_session_evidence from public, anon, authenticated;
revoke all on table workforce_internal.wave2b_multi_session_lifecycle_events from public, anon, authenticated;
grant all on table workforce_internal.wave2b_multi_session_reconstructions to service_role;
grant all on table workforce_internal.wave2b_multi_session_evidence to service_role;
grant all on table workforce_internal.wave2b_multi_session_lifecycle_events to service_role;

create or replace function workforce_internal.reject_immutable_wave2b_multi_session_evidence()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'Wave 2B multi-session provenance is append-only.';
end;
$$;

create trigger wave2b_multi_session_reconstructions_immutable
before update or delete on workforce_internal.wave2b_multi_session_reconstructions
for each row execute function workforce_internal.reject_immutable_wave2b_multi_session_evidence();
create trigger wave2b_multi_session_evidence_immutable
before update or delete on workforce_internal.wave2b_multi_session_evidence
for each row execute function workforce_internal.reject_immutable_wave2b_multi_session_evidence();
create trigger wave2b_multi_session_lifecycle_immutable
before update or delete on workforce_internal.wave2b_multi_session_lifecycle_events
for each row execute function workforce_internal.reject_immutable_wave2b_multi_session_evidence();

create or replace function workforce_internal.wave2b_multi_session_pre_state(
  p_period_id uuid,
  p_user_id uuid,
  p_work_date date,
  p_schedule_id uuid
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  with period_payroll as (
    select count(*)::bigint as payroll_records,
           count(*) filter (where status = 'draft')::bigint as draft_payroll_records,
           coalesce(sum(gross_pay),0)::numeric as gross_pay,
           coalesce(sum(net_pay),0)::numeric as net_pay
    from public.payroll_records where payroll_period_id = p_period_id
  ), artifacts as (
    select
      (select count(*) from public.payroll_items i join public.payroll_records r on r.id = i.payroll_record_id where r.payroll_period_id = p_period_id) as payroll_items,
      (select count(*) from public.payroll_attendance_snapshots s join public.payroll_records r on r.id = s.payroll_record_id where r.id = s.payroll_record_id and r.payroll_period_id = p_period_id) as attendance_snapshots,
      (select count(*) from public.payroll_schedule_snapshots s join public.payroll_records r on r.id = s.payroll_record_id where r.payroll_period_id = p_period_id) as schedule_snapshots,
      (select count(*) from public.payroll_hour_allocations a join public.payroll_records r on r.id = a.destination_payroll_record_id where r.payroll_period_id = p_period_id) as allocations,
      (select count(*) from public.payroll_prepaid_commitments where payroll_period_id = p_period_id) as commitments
  ), prepaid as (
    select count(*)::bigint as active_rows, coalesce(sum(remaining_minutes), 0)::bigint as active_minutes
    from public.payroll_prepaid_hours where commitment_id is null and voided_at is null
  ), attendance_state as (
    select count(*)::bigint as attendance_rows,
           count(*) filter (where voided_at is not null)::bigint as voided_rows,
           count(*) filter (where voided_at is null)::bigint as active_rows
    from public.attendance where user_id = p_user_id and work_date = p_work_date
  ), schedule_state as (
    select s.id, s.user_id, s.shift_date, s.schedule_version, s.shift_start, s.shift_end,
           s.timezone, s.status, s.is_rest_day, s.is_holiday, s.is_leave, s.is_absent
    from public.work_schedules s where s.id = p_schedule_id
  )
  select jsonb_build_object(
    'period', (select jsonb_build_object('id', p.id, 'status', p.status, 'period_start', p.period_start, 'period_end', p.period_end) from public.payroll_periods p where p.id = p_period_id),
    'payroll', (select to_jsonb(period_payroll) from period_payroll),
    'artifacts', (select to_jsonb(artifacts) from artifacts),
    'legacy_prepaid', (select to_jsonb(prepaid) from prepaid),
    'attendance', (select to_jsonb(attendance_state) from attendance_state),
    'schedule', (select to_jsonb(schedule_state) from schedule_state)
  );
$$;

revoke all on function workforce_internal.wave2b_multi_session_pre_state(uuid, uuid, date, uuid) from public, anon, authenticated;
grant execute on function workforce_internal.wave2b_multi_session_pre_state(uuid, uuid, date, uuid) to service_role;

create or replace function workforce_internal.wave2b_multi_session_is_verified_attendance(p_attendance_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.attendance%rowtype;
  e workforce_internal.wave2b_multi_session_evidence%rowtype;
  h workforce_internal.wave2b_multi_session_reconstructions%rowtype;
  s public.work_schedules%rowtype;
  n bigint;
begin
  if p_attendance_id is null then return false; end if;
  select * into a from public.attendance where id = p_attendance_id;
  if not found or a.attendance_status <> 'present' or a.voided_at is not null
     or a.clock_in is not null or a.clock_out is not null
     or a.original_clock_in is not null or a.original_clock_out is not null then return false; end if;
  select e0.* into e from workforce_internal.wave2b_multi_session_evidence e0 where e0.attendance_id = a.id;
  if not found then return false; end if;
  select h0.* into h from workforce_internal.wave2b_multi_session_reconstructions h0 where h0.id = e.reconstruction_id;
  if not found or h.reconstruction_state <> 'complete' then return false; end if;
  if a.user_id is distinct from h.user_id or a.work_date is distinct from h.work_date
     or e.source_schedule_id is distinct from h.source_schedule_id
     or a.schedule_id is distinct from e.physical_schedule_id
     or a.billed_clock_in is distinct from e.target_billed_clock_in
     or a.billed_clock_out is distinct from e.target_billed_clock_out
     or public.workforce_canonical_billed_minutes(a.billed_clock_in, a.billed_clock_out) is distinct from e.canonical_minutes_fingerprint
     or a.total_worked_minutes is distinct from e.stored_minutes_fingerprint then return false; end if;
  if e.physical_schedule_id is not null then
    select * into s from public.work_schedules where id = e.physical_schedule_id;
    if not found or s.user_id is distinct from h.user_id or s.shift_date is distinct from h.work_date
       or s.schedule_version is distinct from h.source_schedule_version then return false; end if;
  end if;
  select count(*) into n from workforce_internal.wave2b_multi_session_evidence where reconstruction_id = h.id;
  if n <> h.expected_session_count then return false; end if;
  if exists (
    select 1 from workforce_internal.wave2b_multi_session_evidence x
    where x.reconstruction_id = h.id
      and (x.target_billed_clock_out <= x.target_billed_clock_in or x.expected_billed_minutes <> floor(extract(epoch from (x.target_billed_clock_out - x.target_billed_clock_in))/60)::integer)
  ) then return false; end if;
  if exists (
    select 1 from workforce_internal.wave2b_multi_session_evidence x
    join workforce_internal.wave2b_multi_session_evidence y on y.reconstruction_id = x.reconstruction_id and y.session_sequence > x.session_sequence
    where x.reconstruction_id = h.id and y.target_billed_clock_in <= x.target_billed_clock_out
  ) then return false; end if;
  if exists (
    select 1 from public.attendance other_row
    where other_row.user_id = a.user_id and other_row.work_date = a.work_date and other_row.id <> a.id and other_row.voided_at is null
      and coalesce(other_row.billed_clock_in, other_row.clock_in) is not null and coalesce(other_row.billed_clock_out, other_row.clock_out) is not null
      and coalesce(other_row.billed_clock_in, other_row.clock_in) < e.target_billed_clock_out
      and e.target_billed_clock_in < coalesce(other_row.billed_clock_out, other_row.clock_out)
      and not exists (select 1 from workforce_internal.wave2b_multi_session_evidence z where z.reconstruction_id = h.id and z.attendance_id = other_row.id)
  ) then return false; end if;
  return exists (
    select 1
    from workforce_internal.wave2b_approved_source_evidence source
    where source.period_id = h.period_id and source.source_type = h.source_type
      and source.source_filename = h.source_filename and source.source_sha256 = h.source_sha256
  )
  and a.review_status in ('approved', 'locked')
  and a.payroll_approved_at is not null;
end;
$$;

revoke all on function workforce_internal.wave2b_multi_session_is_verified_attendance(uuid) from public, anon, authenticated;
grant execute on function workforce_internal.wave2b_multi_session_is_verified_attendance(uuid) to service_role;

-- Preserve the existing single-session verifier as a private helper, then make
-- the public compatibility predicate the union of the two proven contracts.
create or replace function workforce_internal.wave2b_single_session_is_verified_attendance(p_attendance_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_attendance public.attendance%rowtype;
  v_ledger workforce_internal.wave2b_reconstruction_ledger%rowtype;
  v_current_fingerprint jsonb;
  v_duplicate_count bigint;
  v_visible boolean := false;
begin
  if p_attendance_id is null then return false; end if;
  select a.* into v_attendance from public.attendance a where a.id = p_attendance_id;
  if not found then return false; end if;
  if session_user in ('postgres', 'service_role') or current_setting('request.jwt.claim.role', true) = 'service_role' then
    v_visible := true;
  else
    v_visible := public.workforce_is_current_identity(v_attendance.user_id)
      or public.workforce_can_view_user(v_attendance.user_id, 'view_team_attendance')
      or public.workforce_can_view_user(v_attendance.user_id, 'manage_schedules');
  end if;
  if not v_visible then return false; end if;
  select l.* into v_ledger from workforce_internal.wave2b_reconstruction_ledger l where l.attendance_id = p_attendance_id;
  if not found then return false; end if;
  if v_attendance.user_id is distinct from v_ledger.user_id or v_attendance.work_date is distinct from v_ledger.work_date
     or v_attendance.schedule_id is distinct from v_ledger.schedule_id or v_attendance.clock_in is not null or v_attendance.clock_out is not null
     or v_attendance.original_clock_in is not null or v_attendance.original_clock_out is not null or v_attendance.voided_at is not null
     or v_attendance.billed_clock_in is distinct from v_ledger.target_billed_clock_in or v_attendance.billed_clock_out is distinct from v_ledger.target_billed_clock_out
     or public.workforce_canonical_billed_minutes(v_attendance.billed_clock_in, v_attendance.billed_clock_out) is distinct from v_ledger.canonical_minutes_fingerprint
     or v_attendance.total_worked_minutes is distinct from v_ledger.stored_minutes_fingerprint then return false; end if;
  select count(*) into v_duplicate_count from public.attendance other_row
  where other_row.user_id = v_attendance.user_id and other_row.work_date = v_attendance.work_date and other_row.id <> v_attendance.id
    and other_row.voided_at is null and coalesce(other_row.billed_clock_in, other_row.clock_in) is not null
    and coalesce(other_row.billed_clock_out, other_row.clock_out) is not null
    and coalesce(other_row.billed_clock_in, other_row.clock_in) < v_ledger.target_billed_clock_out
    and v_ledger.target_billed_clock_in < coalesce(other_row.billed_clock_out, other_row.clock_out);
  if v_duplicate_count <> 0 then return false; end if;
  v_current_fingerprint := workforce_internal.attendance_state_fingerprint(p_attendance_id);
  if v_current_fingerprint is null then return false; end if;
  if v_attendance.attendance_version = v_ledger.attendance_version_after_reconstruction then return v_current_fingerprint = v_ledger.state_fingerprint; end if;
  return exists (with recursive lifecycle_chain(version_no, state_fingerprint, depth) as (
    select v_ledger.attendance_version_after_reconstruction, v_ledger.state_fingerprint, 0
    union all select e.to_attendance_version, e.after_state_fingerprint, c.depth + 1
    from lifecycle_chain c join workforce_internal.wave2b_reconstruction_lifecycle_events e
      on e.ledger_id = v_ledger.id and e.from_attendance_version = c.version_no and e.before_state_fingerprint = c.state_fingerprint
    where c.depth < 100)
    select 1 from lifecycle_chain c where c.version_no = v_attendance.attendance_version and c.state_fingerprint = v_current_fingerprint and c.depth > 0);
end;
$$;
revoke all on function workforce_internal.wave2b_single_session_is_verified_attendance(uuid) from public, anon, authenticated;
grant execute on function workforce_internal.wave2b_single_session_is_verified_attendance(uuid) to service_role;

create or replace function public.workforce_is_verified_reconstructed_attendance(p_attendance_id uuid)
returns boolean language sql security definer set search_path = '' as $$
  select workforce_internal.wave2b_single_session_is_verified_attendance(p_attendance_id)
      or workforce_internal.wave2b_multi_session_is_verified_attendance(p_attendance_id);
$$;
revoke all on function public.workforce_is_verified_reconstructed_attendance(uuid) from public, anon;
grant execute on function public.workforce_is_verified_reconstructed_attendance(uuid) to authenticated, service_role;

create or replace function workforce_internal.wave2b_multi_session_lifecycle_trigger()
returns trigger language plpgsql security invoker set search_path = 'public', 'pg_temp' as $$
declare
  e workforce_internal.wave2b_multi_session_evidence%rowtype;
  h workforce_internal.wave2b_multi_session_reconstructions%rowtype;
begin
  if old.review_status is distinct from new.review_status then
    select e0.* into e from workforce_internal.wave2b_multi_session_evidence e0 where e0.attendance_id = new.id;
    if found then
      select h0.* into h from workforce_internal.wave2b_multi_session_reconstructions h0 where h0.id = e.reconstruction_id;
      if found and ((old.review_status = 'corrected' and new.review_status = 'approved')
                    or (old.review_status = 'approved' and new.review_status = 'locked')) then
        insert into workforce_internal.wave2b_multi_session_lifecycle_events(
          reconstruction_id,evidence_id,attendance_id,from_review_status,to_review_status,
          before_state_fingerprint,after_state_fingerprint,actor_user_id)
        values(e.reconstruction_id,e.id,new.id,old.review_status,new.review_status,
          jsonb_build_object('attendance_id',old.id,'attendance_version',old.attendance_version,'review_status',old.review_status,'payroll_approved_at',old.payroll_approved_at),
          workforce_internal.attendance_state_fingerprint(new.id),new.updated_by)
        on conflict do nothing;
      end if;
    end if;
  end if;
  return new;
end;
$$;
create trigger wave2b_multi_session_lifecycle
after update of review_status on public.attendance
for each row execute function workforce_internal.wave2b_multi_session_lifecycle_trigger();

create or replace function public.workforce_wave2b_reconstruct_multi_session_attendance(
  p_manifest jsonb,
  p_actor_user_id uuid
)
returns table(
  reconstruction_id uuid, session_sequence smallint, attendance_id uuid,
  billed_clock_in timestamptz, billed_clock_out timestamptz,
  canonical_billed_minutes integer, total_worked_minutes integer,
  regular_minutes integer, pre_shift_overtime_minutes integer,
  post_shift_overtime_minutes integer, rest_day_overtime_minutes integer,
  holiday_overtime_minutes integer, total_overtime_minutes integer,
  schedule_id uuid, attendance_version bigint, review_status text,
  payroll_approved_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
declare
  period_id uuid := nullif(p_manifest->>'period_id','')::uuid;
  user_id uuid := nullif(p_manifest->>'user_id','')::uuid;
  work_date date := nullif(p_manifest->>'work_date','')::date;
  source_schedule_id uuid := nullif(p_manifest->>'source_schedule_id','')::uuid;
  schedule_version bigint := nullif(p_manifest->>'schedule_version','')::bigint;
  source_mode text := p_manifest->>'source_schedule_mode';
  target_sessions jsonb := p_manifest->'sessions';
  s record; a public.attendance%rowtype; h workforce_internal.wave2b_multi_session_reconstructions%rowtype;
  schedule public.work_schedules%rowtype; calc jsonb; expected_pre_state jsonb;
  seq smallint := 0; total integer := 0; duration integer; previous_out timestamptz;
  expected_count smallint; expected_total integer; actor_ok boolean;
begin
  if current_user not in ('postgres','service_role') then raise exception 'Wave 2B multi-session reconstruction is service-role only.'; end if;
  if p_manifest is null or p_actor_user_id is null then raise exception 'Manifest and actor are required.'; end if;
  select exists(select 1 from public.profiles p where p.user_id=p_actor_user_id and p.is_system_admin is true and p.account_deleted_at is null) into actor_ok;
  if not actor_ok then raise exception 'A non-deleted system administrator actor is required.'; end if;
  expected_count := nullif(p_manifest->>'expected_session_count','')::smallint;
  expected_total := nullif(p_manifest->>'expected_total_minutes','')::integer;
  if period_id is null or user_id is null or work_date is null or source_schedule_id is null or schedule_version is null
     or source_mode not in ('rest_day','timed_workday') or expected_count is null or expected_total is null
     or target_sessions is null or jsonb_typeof(target_sessions) <> 'array'
     or p_manifest->>'source_type' <> 'historical_workbook'
     or nullif(p_manifest->>'source_filename','') is null or nullif(p_manifest->>'source_sha256','') is null
     or nullif(p_manifest->>'source_sheet','') is null or nullif(p_manifest->>'source_row_reference','') is null
     or nullif(p_manifest->>'source_reference','') is null or nullif(p_manifest->>'idempotency_key','') is null
     or p_manifest->'pre_state' is null then raise exception 'Manifest is incomplete.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('wave2b-multi:' || (p_manifest->>'idempotency_key'),0));
  if exists(select 1 from workforce_internal.wave2b_multi_session_reconstructions x where x.idempotency_key=p_manifest->>'idempotency_key' or (x.period_id=period_id and x.user_id=user_id and x.work_date=work_date)) then raise exception 'Multi-session reconstruction already exists.'; end if;
  select * into schedule from public.work_schedules where id=source_schedule_id for share;
  if not found or schedule.user_id is distinct from user_id or schedule.shift_date is distinct from work_date or schedule.schedule_version is distinct from schedule_version
     or schedule.status not in ('published','changed','completed') or schedule.is_leave or schedule.is_absent or schedule.is_holiday
     or (source_mode='rest_day' and (not schedule.is_rest_day or schedule.shift_start is not null or schedule.shift_end is not null))
     or (source_mode='timed_workday' and (schedule.is_rest_day or schedule.shift_start is null or schedule.shift_end is null or schedule.shift_end <= schedule.shift_start)) then raise exception 'Source schedule guard failed.'; end if;
  if not exists(select 1 from public.payroll_periods p where p.id=period_id and p.status='draft' and work_date between p.period_start and p.period_end) then raise exception 'Draft period/date guard failed.'; end if;
  if not exists(select 1 from workforce_internal.wave2b_approved_source_evidence e where e.period_id=period_id and work_date between e.period_start and e.period_end and e.source_type=p_manifest->>'source_type' and e.source_filename=p_manifest->>'source_filename' and e.source_sha256=lower(p_manifest->>'source_sha256')) then raise exception 'Approved source guard failed.'; end if;
  if workforce_internal.wave2b_multi_session_pre_state(period_id,user_id,work_date,source_schedule_id) is distinct from p_manifest->'pre_state' then raise exception 'Pre-state fingerprint guard failed.'; end if;
  if (select count(*) from public.payroll_records where payroll_period_id=period_id) is distinct from nullif(p_manifest #>> '{financial,payroll_record_count}','')::bigint
     or exists(select 1 from public.payroll_records where payroll_period_id=period_id and status <> 'draft')
     or exists(select 1 from public.payroll_items i join public.payroll_records r on r.id=i.payroll_record_id where r.payroll_period_id=period_id)
     or exists(select 1 from public.payroll_attendance_snapshots i join public.payroll_records r on r.id=i.payroll_record_id where r.payroll_period_id=period_id)
     or exists(select 1 from public.payroll_schedule_snapshots i join public.payroll_records r on r.id=i.payroll_record_id where r.payroll_period_id=period_id)
     or exists(select 1 from public.payroll_hour_allocations i join public.payroll_records r on r.id=i.destination_payroll_record_id where r.payroll_period_id=period_id)
     or exists(select 1 from public.payroll_prepaid_commitments where payroll_period_id=period_id) then raise exception 'Payroll artifact guard failed.'; end if;
  if exists(select 1 from public.attendance x where x.user_id=user_id and x.work_date=work_date and x.voided_at is null) then raise exception 'Active attendance exists for this work date.'; end if;
  if (select count(*) from public.attendance x where x.user_id=user_id and x.work_date=work_date and x.voided_at is not null) is distinct from coalesce(nullif(p_manifest->>'expected_void_history_count','')::bigint,0) then raise exception 'Void history guard failed.'; end if;
  for s in select * from jsonb_to_recordset(target_sessions) as x(session_sequence smallint,physical_schedule_id uuid,billed_clock_in timestamptz,billed_clock_out timestamptz,expected_billed_minutes integer) order by session_sequence loop
    seq := seq + 1;
    if s.session_sequence <> seq or s.billed_clock_in is null or s.billed_clock_out is null or s.billed_clock_out <= s.billed_clock_in then raise exception 'Session order/interval guard failed.'; end if;
    duration := floor(extract(epoch from (s.billed_clock_out-s.billed_clock_in))/60)::integer;
    if duration <> s.expected_billed_minutes or s.expected_billed_minutes <= 0 then raise exception 'Session duration guard failed.'; end if;
    if previous_out is not null and s.billed_clock_in <= previous_out then raise exception 'Session overlap/order guard failed.'; end if;
    if seq = 1 and s.physical_schedule_id is distinct from source_schedule_id then raise exception 'First session must retain source schedule linkage.'; end if;
    if seq > 1 and s.physical_schedule_id is not null then raise exception 'Only the first session may retain physical schedule linkage.'; end if;
    previous_out := s.billed_clock_out; total := total + duration;
  end loop;
  if seq <> expected_count or total <> expected_total then raise exception 'Session count/aggregate duration guard failed.'; end if;
  insert into workforce_internal.wave2b_multi_session_reconstructions(
    period_id,user_id,work_date,source_schedule_id,source_schedule_version,source_schedule_mode,source_schedule_fingerprint,
    source_type,source_filename,source_sha256,source_sheet,source_row_reference,source_reference,expected_session_count,expected_total_minutes,pre_state_fingerprint,created_by,idempotency_key)
  values(period_id,user_id,work_date,source_schedule_id,schedule_version,source_mode,
    jsonb_build_object('id',schedule.id,'user_id',schedule.user_id,'shift_date',schedule.shift_date,'schedule_version',schedule.schedule_version,'shift_start',schedule.shift_start,'shift_end',schedule.shift_end,'timezone',schedule.timezone,'status',schedule.status,'is_rest_day',schedule.is_rest_day,'is_holiday',schedule.is_holiday,'is_leave',schedule.is_leave,'is_absent',schedule.is_absent),
    p_manifest->>'source_type',p_manifest->>'source_filename',lower(p_manifest->>'source_sha256'),p_manifest->>'source_sheet',p_manifest->>'source_row_reference',p_manifest->>'source_reference',expected_count,expected_total,p_manifest->'pre_state',p_actor_user_id,p_manifest->>'idempotency_key') returning * into h;
  for s in select * from jsonb_to_recordset(target_sessions) as x(session_sequence smallint,physical_schedule_id uuid,billed_clock_in timestamptz,billed_clock_out timestamptz,expected_billed_minutes integer) order by session_sequence loop
    insert into public.attendance(user_id,schedule_id,work_date,clock_in,clock_out,original_clock_in,original_clock_out,billed_clock_in,billed_clock_out,attendance_status,is_corrected,correction_reason,corrected_by,corrected_at,created_by,updated_by,review_status,payroll_approved_at)
    values(user_id,s.physical_schedule_id,work_date,null,null,null,null,s.billed_clock_in,s.billed_clock_out,'present',true,'Verified historical multi-session reconstruction',p_actor_user_id,clock_timestamp(),p_actor_user_id,p_actor_user_id,'corrected',null)
    returning * into a;
    perform public.workforce_recalculate_attendance(a.id);
    select * into a from public.attendance where id=a.id;
    if a.clock_in is not null or a.clock_out is not null or a.original_clock_in is not null or a.original_clock_out is not null
       or a.billed_clock_in is distinct from s.billed_clock_in or a.billed_clock_out is distinct from s.billed_clock_out
       or public.workforce_canonical_billed_minutes(a.billed_clock_in,a.billed_clock_out) is distinct from s.expected_billed_minutes
       or a.total_worked_minutes is distinct from s.expected_billed_minutes
       or a.regular_minutes + a.total_overtime_minutes is distinct from s.expected_billed_minutes
       or a.total_overtime_minutes is distinct from (a.pre_shift_overtime_minutes+a.post_shift_overtime_minutes+a.rest_day_overtime_minutes+a.holiday_overtime_minutes) then raise exception 'Multi-session attendance postcondition failed.'; end if;
    calc := jsonb_build_object('regular',a.regular_minutes,'pre_shift_overtime',a.pre_shift_overtime_minutes,'post_shift_overtime',a.post_shift_overtime_minutes,'rest_day_overtime',a.rest_day_overtime_minutes,'holiday_overtime',a.holiday_overtime_minutes,'total_overtime',a.total_overtime_minutes);
    insert into workforce_internal.wave2b_multi_session_evidence(reconstruction_id,session_sequence,source_schedule_id,physical_schedule_id,physical_schedule_linkage,target_billed_clock_in,target_billed_clock_out,expected_billed_minutes,attendance_id,attendance_version_after_reconstruction,canonical_minutes_fingerprint,stored_minutes_fingerprint,classification_fingerprint,state_fingerprint)
    values(h.id,s.session_sequence,source_schedule_id,s.physical_schedule_id,case when s.physical_schedule_id is null then 'scheduleless' else 'source_schedule' end,s.billed_clock_in,s.billed_clock_out,s.expected_billed_minutes,a.id,a.attendance_version,public.workforce_canonical_billed_minutes(a.billed_clock_in,a.billed_clock_out),a.total_worked_minutes,calc,workforce_internal.attendance_state_fingerprint(a.id));
  end loop;
  insert into public.workforce_audit_logs(actor_user_id,action,entity_type,entity_id,after_data,reason,metadata)
  values(p_actor_user_id,'wave2b_multi_session_reconstructed','wave2b_multi_session_reconstruction',h.id,jsonb_build_object('reconstruction_id',h.id,'session_count',expected_count,'total_minutes',expected_total),p_manifest->>'reason',jsonb_build_object('source_type',p_manifest->>'source_type','source_filename',p_manifest->>'source_filename','source_sha256',lower(p_manifest->>'source_sha256'),'source_reference',p_manifest->>'source_reference','raw_timestamps_intentionally_null',true));
  return query select h.id,e.session_sequence,e.attendance_id,a.billed_clock_in,a.billed_clock_out,public.workforce_canonical_billed_minutes(a.billed_clock_in,a.billed_clock_out),a.total_worked_minutes,a.regular_minutes,a.pre_shift_overtime_minutes,a.post_shift_overtime_minutes,a.rest_day_overtime_minutes,a.holiday_overtime_minutes,a.total_overtime_minutes,a.schedule_id,a.attendance_version,a.review_status,a.payroll_approved_at
  from workforce_internal.wave2b_multi_session_evidence e join public.attendance a on a.id=e.attendance_id where e.reconstruction_id=h.id order by e.session_sequence;
end;
$$;

revoke all on function public.workforce_wave2b_reconstruct_multi_session_attendance(jsonb,uuid) from public, anon, authenticated;
grant execute on function public.workforce_wave2b_reconstruct_multi_session_attendance(jsonb,uuid) to service_role;
comment on function public.workforce_wave2b_reconstruct_multi_session_attendance(jsonb,uuid) is 'Service-role-only, guarded Wave 2B historical multi-session reconstruction; infrastructure supports a separately authorized repair.';

create or replace function workforce_internal.wave2b_multi_session_is_ready(p_reconstruction_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(
    select 1 from workforce_internal.wave2b_multi_session_reconstructions h
    where h.id=p_reconstruction_id
      and (select count(*) from workforce_internal.wave2b_multi_session_evidence e where e.reconstruction_id=h.id)=h.expected_session_count
      and not exists(select 1 from workforce_internal.wave2b_multi_session_evidence e join public.attendance a on a.id=e.attendance_id where e.reconstruction_id=h.id and (a.review_status not in ('approved','locked') or a.payroll_approved_at is null or not public.workforce_is_verified_reconstructed_attendance(a.id)))
      and not exists(select 1 from workforce_internal.wave2b_multi_session_evidence e join public.workforce_attendance_payroll_readiness r on r.id=e.attendance_id where e.reconstruction_id=h.id and exists(select 1 from unnest(coalesce(r.payroll_readiness_blockers,'{}'::text[])) b where b <> 'missing_schedule'))
  );
$$;
revoke all on function workforce_internal.wave2b_multi_session_is_ready(uuid) from public, anon, authenticated;
grant execute on function workforce_internal.wave2b_multi_session_is_ready(uuid) to service_role;

do $$
declare
  original_definition text := replace(pg_get_viewdef('public.workforce_attendance_payroll_readiness'::regclass,true), chr(13), '');
  updated_definition text;
begin
  updated_definition := regexp_replace(original_definition,
    E'WHEN attendance_row\\.schedule_id IS NULL THEN ''missing_schedule''::text',
    E'WHEN attendance_row.schedule_id IS NULL AND NOT (public.workforce_is_verified_reconstructed_attendance(attendance_row.id) AND attendance_row.review_status IN (''approved'', ''locked'') AND attendance_row.payroll_approved_at IS NOT NULL) THEN ''missing_schedule''::text',
    'g');
  if updated_definition = original_definition then raise exception 'Readiness missing_schedule anchor not found.'; end if;
  execute 'create or replace view public.workforce_attendance_payroll_readiness with (security_invoker = true) as ' || updated_definition;
end;
$$;
revoke all on public.workforce_attendance_payroll_readiness from public, anon;
grant select on public.workforce_attendance_payroll_readiness to authenticated, service_role;

comment on table workforce_internal.wave2b_multi_session_reconstructions is 'Append-only provenance header for separately authorized historical multi-session reconstruction.';
comment on table workforce_internal.wave2b_multi_session_evidence is 'Immutable child session evidence; raw employee clock events remain null.';
comment on table workforce_internal.wave2b_multi_session_lifecycle_events is 'Append-only review lifecycle evidence for verified historical multi-session attendance.';

commit;

;
