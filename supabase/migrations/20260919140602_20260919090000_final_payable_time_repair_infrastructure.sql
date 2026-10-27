-- LOCAL DESIGN ONLY. Do not deploy or run against production.
-- Final Aug 1-15 payable-time normalization infrastructure.
--
-- The JSON manifest is the authorization source. Callers pass one exact
-- manifest entry; they cannot submit a free-form target timestamp or minutes.
-- The generic RPC is reusable only for the 27 rows in the manifest. The
-- dedicated RPC is a separate allow-listed path for four atypical rows.

begin;

create table public.historical_payable_time_repair_authorizations (
  repair_key text primary key,
  period_id uuid not null references public.payroll_periods(id) on delete restrict,
  attendance_id uuid not null unique references public.attendance(id) on delete restrict,
  path_kind text not null check (path_kind in ('generic', 'dedicated')),
  manifest_version text not null,
  manifest_entry jsonb not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  constraint historical_payable_time_repair_key_check check (length(trim(repair_key)) > 0)
);

create table public.historical_payable_time_repairs (
  id uuid primary key default gen_random_uuid(),
  repair_key text not null unique references public.historical_payable_time_repair_authorizations(repair_key) on delete restrict,
  period_id uuid not null references public.payroll_periods(id) on delete restrict,
  attendance_id uuid not null unique references public.attendance(id) on delete restrict,
  path_kind text not null check (path_kind in ('generic', 'dedicated')),
  manifest_entry jsonb not null,
  before_fingerprint jsonb not null,
  after_fingerprint jsonb not null,
  applied_by uuid not null references public.profiles(user_id) on delete restrict,
  applied_at timestamptz not null default now()
);

alter table public.historical_payable_time_repair_authorizations enable row level security;
alter table public.historical_payable_time_repairs enable row level security;
revoke all on table public.historical_payable_time_repair_authorizations from public, anon, authenticated, service_role;
revoke all on table public.historical_payable_time_repairs from public, anon, authenticated, service_role;

create or replace function public.historical_payable_time_ledger_immutable()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'Historical payable-time authorization and repair ledgers are append-only.';
end;
$$;

alter function public.historical_payable_time_ledger_immutable() owner to postgres;
revoke all on function public.historical_payable_time_ledger_immutable() from public, anon, authenticated, service_role;

-- Jerson's dedicated path relies on one pre-existing historical correction.
-- The evidence payload is a versioned, fixed-key canonical serialization:
--   * scalar UUID/text values are serialized as text; SQL NULL remains JSON null
--   * every timestamptz is normalized to UTC with six fractional digits and Z
--   * calculation payloads remain jsonb, whose object keys are canonicalized by
--     PostgreSQL; array order and JSON nulls are preserved
--   * jsonb::text is used only after jsonb canonicalization, so key order is
--     deterministic and independent of the physical row/column order
-- The payload includes every immutable attendance_corrections field, including
-- both old/new value payloads and their version-transition keys when present.
create or replace function public.historical_payable_time_correction_evidence(
  p_correction public.attendance_corrections
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'format_version', 'attendance_correction_v2',
    'id', p_correction.id::text,
    'attendance_id', p_correction.attendance_id::text,
    'employee_user_id', p_correction.employee_user_id::text,
    'schedule_id', p_correction.schedule_id::text,
    'previous_schedule_id', p_correction.previous_schedule_id::text,
    'new_schedule_id', p_correction.new_schedule_id::text,
    'previous_clock_in', case when p_correction.previous_clock_in is null then null else to_char(p_correction.previous_clock_in at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
    'previous_clock_out', case when p_correction.previous_clock_out is null then null else to_char(p_correction.previous_clock_out at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
    'new_clock_in', case when p_correction.new_clock_in is null then null else to_char(p_correction.new_clock_in at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
    'new_clock_out', case when p_correction.new_clock_out is null then null else to_char(p_correction.new_clock_out at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
    'previous_billed_clock_in', case when p_correction.previous_billed_clock_in is null then null else to_char(p_correction.previous_billed_clock_in at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
    'previous_billed_clock_out', case when p_correction.previous_billed_clock_out is null then null else to_char(p_correction.previous_billed_clock_out at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
    'new_billed_clock_in', case when p_correction.new_billed_clock_in is null then null else to_char(p_correction.new_billed_clock_in at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
    'new_billed_clock_out', case when p_correction.new_billed_clock_out is null then null else to_char(p_correction.new_billed_clock_out at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
    'previous_status', p_correction.previous_status,
    'new_status', p_correction.new_status,
    'previous_calculations', p_correction.previous_calculations,
    'new_calculations', p_correction.new_calculations,
    'version_transition', jsonb_build_object(
      'old', p_correction.previous_calculations->'attendance_version',
      'new', p_correction.new_calculations->'attendance_version'
    ),
    'reason_code', p_correction.reason_code,
    'reason_notes', p_correction.reason_notes,
    'corrected_by', p_correction.corrected_by::text,
    'corrected_at', to_char(p_correction.corrected_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'created_at', to_char(p_correction.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'updated_at', to_char(p_correction.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  );
$$;

create or replace function public.historical_payable_time_correction_fingerprint(
  p_correction public.attendance_corrections
)
returns text
language sql
immutable
as $$
  select md5(public.historical_payable_time_correction_evidence(p_correction)::text);
$$;

alter function public.historical_payable_time_correction_evidence(public.attendance_corrections) owner to postgres;
alter function public.historical_payable_time_correction_fingerprint(public.attendance_corrections) owner to postgres;
revoke all on function public.historical_payable_time_correction_evidence(public.attendance_corrections) from public, anon, authenticated, service_role;
revoke all on function public.historical_payable_time_correction_fingerprint(public.attendance_corrections) from public, anon, authenticated, service_role;

create or replace function public.historical_payable_time_prior_correction_matches(
  p_attendance_id uuid,
  p_manifest_entry jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pre jsonb := p_manifest_entry->'pre';
  v_expected_id uuid;
  v_expected_fingerprint text;
  v_count bigint;
  v_correction public.attendance_corrections%rowtype;
  v_actual_fingerprint text;
begin
  if p_attendance_id is null or p_manifest_entry is null or v_pre is null then
    return false;
  end if;
  if (v_pre ? 'prior_correction_id') <> (v_pre ? 'prior_correction_fingerprint') then
    return false;
  end if;

  select count(*) into v_count
  from public.attendance_corrections c
  where c.attendance_id = p_attendance_id;

  if not (v_pre ? 'prior_correction_id') then
    return v_count = 0;
  end if;
  if v_count <> 1 then
    return false;
  end if;

  begin
    v_expected_id := nullif(v_pre->>'prior_correction_id', '')::uuid;
    v_expected_fingerprint := nullif(v_pre->>'prior_correction_fingerprint', '');
  exception when others then
    return false;
  end;
  if v_expected_id is null
     or v_expected_fingerprint is null
     or v_expected_fingerprint !~ '^[0-9a-f]{32}$' then
    return false;
  end if;

  select * into v_correction
  from public.attendance_corrections c
  where c.attendance_id = p_attendance_id
  for share;
  if not found
     or v_correction.id is distinct from v_expected_id
     or v_correction.attendance_id is distinct from p_attendance_id then
    return false;
  end if;

  begin
    v_actual_fingerprint := public.historical_payable_time_correction_fingerprint(v_correction);
  exception when others then
    return false;
  end;
  return v_actual_fingerprint is not null
    and v_actual_fingerprint = v_expected_fingerprint;
end;
$$;

alter function public.historical_payable_time_prior_correction_matches(uuid, jsonb) owner to postgres;
revoke all on function public.historical_payable_time_prior_correction_matches(uuid, jsonb) from public, anon, authenticated, service_role;

create trigger historical_payable_time_authorizations_immutable
before update or delete on public.historical_payable_time_repair_authorizations
for each row execute function public.historical_payable_time_ledger_immutable();

create trigger historical_payable_time_repairs_immutable
before update or delete on public.historical_payable_time_repairs
for each row execute function public.historical_payable_time_ledger_immutable();

create or replace function public.historical_payable_time_pre_state_matches(
  p_attendance_id uuid,
  p_manifest_entry jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_a public.attendance%rowtype;
  v_s public.work_schedules%rowtype;
  v_pre jsonb := p_manifest_entry->'pre';
  v_active bigint;
  v_overlap bigint;
  v_corrections bigint;
  v_repairs bigint;
begin
  select * into v_a from public.attendance where id = p_attendance_id;
  if not found then return false; end if;
  select * into v_s from public.work_schedules where id = v_a.schedule_id;
  if not found then return false; end if;

  select count(*) into v_active
  from public.attendance x
  where x.user_id = v_a.user_id and x.work_date = v_a.work_date and x.voided_at is null;
  select count(*) into v_overlap
  from public.attendance x
  where x.user_id = v_a.user_id and x.work_date = v_a.work_date
    and x.voided_at is null and x.id <> v_a.id
    and coalesce(x.billed_clock_in, x.clock_in) < coalesce(v_a.billed_clock_out, v_a.clock_out)
    and coalesce(x.billed_clock_out, x.clock_out) > coalesce(v_a.billed_clock_in, v_a.clock_in);
  select count(*) into v_corrections from public.attendance_corrections c where c.attendance_id = v_a.id;
  select count(*) into v_repairs from public.historical_payable_time_repairs r where r.attendance_id = v_a.id;

  if v_corrections is distinct from (v_pre->>'corrections')::bigint then
    return false;
  end if;
  if not public.historical_payable_time_prior_correction_matches(p_attendance_id, p_manifest_entry) then
    return false;
  end if;

  return v_a.user_id is not distinct from (v_pre->>'user_id')::uuid
    and v_a.attendance_version is not distinct from (v_pre->>'version')::bigint
    and v_a.attendance_status is not distinct from v_pre->>'attendance_status'
    and v_a.review_status is not distinct from v_pre->>'review_status'
    and v_a.payroll_approved_at is not distinct from (v_pre->>'payroll_approved_at')::timestamptz
    and v_a.total_worked_minutes is not distinct from (v_pre->>'stored_minutes')::integer
    and v_a.original_clock_in is not distinct from (v_pre->'raw'->>0)::timestamptz
    and v_a.original_clock_out is not distinct from (v_pre->'raw'->>1)::timestamptz
    and v_a.billed_clock_in is not distinct from (v_pre->'billed'->>0)::timestamptz
    and v_a.billed_clock_out is not distinct from (v_pre->'billed'->>1)::timestamptz
    and v_a.regular_minutes is not distinct from (v_pre->'classifications'->>0)::integer
    and v_a.pre_shift_overtime_minutes is not distinct from (v_pre->'classifications'->>1)::integer
    and v_a.post_shift_overtime_minutes is not distinct from (v_pre->'classifications'->>2)::integer
    and v_a.rest_day_overtime_minutes is not distinct from (v_pre->'classifications'->>3)::integer
    and v_a.total_overtime_minutes is not distinct from (v_pre->'classifications'->>4)::integer
    and v_a.schedule_id is not distinct from (v_pre->>'schedule_id')::uuid
    and v_s.schedule_version is not distinct from (v_pre->>'schedule_version')::bigint
    and v_active is not distinct from (v_pre->>'active_rows')::bigint
    and v_overlap is not distinct from (v_pre->>'overlaps')::bigint
    and v_repairs is not distinct from (v_pre->>'repair_ledger')::bigint
    and (v_a.is_corrected is true) is not distinct from ((v_pre->>'is_corrected')::boolean)
    and (v_a.voided_at is not null) is not distinct from ((v_pre->>'voided')::boolean);
end;
$$;

revoke all on function public.historical_payable_time_pre_state_matches(uuid, jsonb) from public, anon, authenticated, service_role;

create or replace function public.workforce_historical_apply_payable_time(
  p_period_id uuid,
  p_attendance_id uuid,
  p_actor_user_id uuid,
  p_path_kind text,
  p_manifest_entry jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_auth public.historical_payable_time_repair_authorizations%rowtype;
  v_before public.attendance%rowtype;
  v_after public.attendance%rowtype;
  v_schedule public.work_schedules%rowtype;
  v_calc record;
  v_canonical integer;
  v_other_overtime integer;
  v_available_overtime integer;
  v_period public.payroll_periods%rowtype;
  v_before_fingerprint jsonb;
  v_after_fingerprint jsonb;
  v_prior_correction public.attendance_corrections%rowtype;
  v_prior_correction_evidence jsonb;
  v_prior_correction_fingerprint text;
  v_audit_count bigint;
  v_is_open_schedule boolean := false;
begin
  if current_user not in ('postgres', 'service_role') then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;
  if p_period_id is distinct from 'b62ee64a-3da9-48d2-8c4e-f9856e352086'::uuid then
    raise exception 'Only Aug 1-15, 2026 is authorized.';
  end if;
  if p_path_kind not in ('generic', 'dedicated') or p_manifest_entry is null then
    raise exception 'A valid path and exact manifest entry are required.';
  end if;
  if not exists (
    select 1 from public.profiles p
    where p.user_id = p_actor_user_id and p.is_system_admin is true
      and p.employment_status <> 'terminated' and p.account_deleted_at is null
  ) then
    raise exception 'A non-deleted system administrator actor is required.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('final-payable-time:' || p_attendance_id::text, 0));
  select * into v_auth
  from public.historical_payable_time_repair_authorizations a
  where a.period_id = p_period_id and a.attendance_id = p_attendance_id
    and a.path_kind = p_path_kind and a.enabled is true
    and a.manifest_entry = p_manifest_entry
  for share;
  if not found then
    raise exception 'Attendance/target is not authorized by the exact reviewed manifest.';
  end if;
  if exists (select 1 from public.historical_payable_time_repairs r where r.repair_key = v_auth.repair_key or r.attendance_id = p_attendance_id) then
    raise exception 'Historical payable-time repair already exists; repeat execution rejected.';
  end if;

  select * into v_period from public.payroll_periods where id = p_period_id for update;
  if not found or v_period.period_start is distinct from '2026-08-01'::date
     or v_period.period_end is distinct from '2026-08-15'::date or v_period.status is distinct from 'draft' then
    raise exception 'Aug 1-15 period must remain the exact Draft period.';
  end if;
  perform public.final_structural_repair_shared_guard(p_period_id);

  select * into v_before from public.attendance where id = p_attendance_id for update;
  if not found or v_before.work_date < v_period.period_start or v_before.work_date > v_period.period_end then
    raise exception 'Attendance is missing or outside the authorized period.';
  end if;
  if not public.historical_payable_time_pre_state_matches(p_attendance_id, p_manifest_entry) then
    raise exception 'Exact attendance pre-state fingerprint changed.';
  end if;
  if p_manifest_entry->'pre' ? 'prior_correction_id' then
    select * into v_prior_correction
    from public.attendance_corrections c
    where c.attendance_id = p_attendance_id
      and c.id = (p_manifest_entry->'pre'->>'prior_correction_id')::uuid;
    if not found then
      raise exception 'Exact prior correction evidence is required.';
    end if;
    v_prior_correction_evidence := public.historical_payable_time_correction_evidence(v_prior_correction);
    v_prior_correction_fingerprint := public.historical_payable_time_correction_fingerprint(v_prior_correction);
    if v_prior_correction_fingerprint is null
       or v_prior_correction_fingerprint is distinct from p_manifest_entry->'pre'->>'prior_correction_fingerprint' then
      raise exception 'Exact prior correction fingerprint evidence is required.';
    end if;
  end if;
  if v_before.voided_at is not null or v_before.schedule_id is null then
    raise exception 'Voided or scheduleless attendance is not eligible.';
  end if;
  select * into v_schedule from public.work_schedules where id = v_before.schedule_id for share;
  if not found or v_schedule.user_id is distinct from v_before.user_id or v_schedule.status is distinct from 'published'
     or v_schedule.schedule_version is null then
    raise exception 'Published schedule ownership/version guard failed.';
  end if;
  if exists (select 1 from public.payroll_attendance_snapshots s where s.attendance_id = v_before.id)
     or exists (select 1 from public.payroll_schedule_snapshots s where s.schedule_id = v_before.schedule_id and s.work_date = v_before.work_date)
     or exists (
       select 1 from public.payroll_hour_allocations a
       join public.payroll_attendance_snapshots s on s.id = a.attendance_snapshot_id
       where s.attendance_id = v_before.id
     ) then
    raise exception 'Attendance payroll/snapshot/allocation references must be absent.';
  end if;

  v_canonical := public.workforce_canonical_billed_minutes(
    (p_manifest_entry->'target'->'billed'->>0)::timestamptz,
    (p_manifest_entry->'target'->'billed'->>1)::timestamptz
  );
  select coalesce(sum(greatest(coalesce(x.total_overtime_minutes, 0), 0)), 0)::integer into v_other_overtime
  from public.attendance x
  where x.user_id = v_before.user_id and x.work_date = v_before.work_date and x.id <> v_before.id and x.voided_at is null;
  v_available_overtime := greatest(0, 1200 - v_other_overtime);
  v_is_open_schedule := not v_schedule.is_rest_day and not v_schedule.is_holiday
    and v_schedule.shift_start is null and v_schedule.shift_end is null;
  if v_is_open_schedule then
    if v_schedule.planned_paid_minutes is null then
      raise exception 'Open schedule attendance requires planned paid time.';
    end if;
    select 0::integer as pre_shift_overtime_minutes,
      least(v_canonical, v_schedule.planned_paid_minutes) as regular_minutes,
      least(greatest(v_canonical - v_schedule.planned_paid_minutes, 0), v_available_overtime) as post_shift_overtime_minutes,
      0::integer as rest_day_overtime_minutes, 0::integer as holiday_overtime_minutes,
      least(greatest(v_canonical - v_schedule.planned_paid_minutes, 0), v_available_overtime) as total_overtime_minutes,
      v_canonical as total_worked_minutes, 0::integer as minutes_late, 0::integer as undertime_minutes
    into v_calc;
  else
    select * into v_calc from public.workforce_calculate_attendance(
      v_schedule.shift_start, v_schedule.shift_end,
      (p_manifest_entry->'target'->'billed'->>0)::timestamptz,
      (p_manifest_entry->'target'->'billed'->>1)::timestamptz,
      v_before.work_date, v_schedule.timezone, v_available_overtime,
      v_schedule.is_rest_day, v_schedule.is_holiday
    );
  end if;
  if v_canonical is distinct from (p_manifest_entry->'target'->>'minutes')::integer
     or v_calc.total_worked_minutes is distinct from v_canonical
     or v_calc.regular_minutes is distinct from (p_manifest_entry->'target'->'classifications'->>0)::integer
     or v_calc.pre_shift_overtime_minutes is distinct from (p_manifest_entry->'target'->'classifications'->>1)::integer
     or v_calc.post_shift_overtime_minutes is distinct from (p_manifest_entry->'target'->'classifications'->>2)::integer
     or v_calc.rest_day_overtime_minutes is distinct from (p_manifest_entry->'target'->'classifications'->>3)::integer
     or v_calc.total_overtime_minutes is distinct from (p_manifest_entry->'target'->'classifications'->>4)::integer then
    raise exception 'Target duration or classification does not follow current production rules.';
  end if;

  v_before_fingerprint := jsonb_build_object('attendance', to_jsonb(v_before), 'schedule', to_jsonb(v_schedule), 'manifest', p_manifest_entry);
  if v_prior_correction.id is not null then
    v_before_fingerprint := v_before_fingerprint || jsonb_build_object(
      'prior_correction', jsonb_build_object(
        'id', v_prior_correction.id,
        'fingerprint', v_prior_correction_fingerprint,
        'evidence', v_prior_correction_evidence
      )
    );
  end if;
  perform set_config('workforce.correction_recalculation', 'true', true);
  update public.attendance
  set billed_clock_in = (p_manifest_entry->'target'->'billed'->>0)::timestamptz,
      billed_clock_out = (p_manifest_entry->'target'->'billed'->>1)::timestamptz,
      regular_minutes = v_calc.regular_minutes,
      pre_shift_overtime_minutes = v_calc.pre_shift_overtime_minutes,
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
      payroll_approved_at = null, is_corrected = true,
      correction_reason = 'final_payable_time_normalization', corrected_by = p_actor_user_id,
      corrected_at = statement_timestamp(), updated_by = p_actor_user_id,
      updated_at = statement_timestamp()
  where id = v_before.id
  returning * into v_after;
  perform set_config('workforce.correction_recalculation', 'false', true);

  if v_after.attendance_version is distinct from v_before.attendance_version + 1
     or v_after.original_clock_in is distinct from v_before.original_clock_in
     or v_after.original_clock_out is distinct from v_before.original_clock_out
     or v_after.clock_in is distinct from v_before.clock_in
     or v_after.clock_out is distinct from v_before.clock_out
     or v_after.schedule_id is distinct from v_before.schedule_id
     or v_after.user_id is distinct from v_before.user_id
     or v_after.work_date is distinct from v_before.work_date
     or v_after.total_worked_minutes is distinct from v_canonical
     or v_after.review_status is distinct from 'corrected'
     or v_after.payroll_approved_at is not null then
    raise exception 'Post-write preservation or corrected-state invariant failed.';
  end if;

  insert into public.attendance_corrections(
    attendance_id, employee_user_id, schedule_id, previous_schedule_id, new_schedule_id,
    previous_clock_in, previous_clock_out, new_clock_in, new_clock_out,
    previous_billed_clock_in, previous_billed_clock_out, new_billed_clock_in, new_billed_clock_out,
    previous_status, new_status, reason_code, reason_notes, previous_calculations,
    new_calculations, corrected_by, corrected_at
  ) values (
    v_after.id, v_after.user_id, v_after.schedule_id, v_before.schedule_id, v_after.schedule_id,
    v_before.clock_in, v_before.clock_out, v_after.clock_in, v_after.clock_out,
    v_before.billed_clock_in, v_before.billed_clock_out, v_after.billed_clock_in, v_after.billed_clock_out,
    v_before.attendance_status, v_after.attendance_status, 'other', 'Final payable-time normalization',
    jsonb_build_object('attendance_version', v_before.attendance_version, 'total_worked_minutes', v_before.total_worked_minutes),
    jsonb_build_object('attendance_version', v_after.attendance_version, 'total_worked_minutes', v_after.total_worked_minutes),
    p_actor_user_id, statement_timestamp()
  );
  v_after_fingerprint := jsonb_build_object('attendance', to_jsonb(v_after), 'schedule', to_jsonb(v_schedule), 'manifest', p_manifest_entry);
  if v_prior_correction.id is not null then
    v_after_fingerprint := v_after_fingerprint || jsonb_build_object(
      'prior_correction', jsonb_build_object(
        'id', v_prior_correction.id,
        'fingerprint', v_prior_correction_fingerprint,
        'evidence', v_prior_correction_evidence
      )
    );
  end if;
  insert into public.workforce_audit_logs(actor_user_id, action, entity_type, entity_id, before_data, after_data, reason, metadata)
  values (p_actor_user_id, 'historical_payable_time_normalized', 'attendance', v_after.id,
    v_before_fingerprint, v_after_fingerprint,
    'Final payable-time normalization', jsonb_build_object(
      'repair_key', v_auth.repair_key,
      'path_kind', p_path_kind,
      'prior_correction_id', case when v_prior_correction.id is not null then v_prior_correction.id else null end,
      'prior_correction_fingerprint', v_prior_correction_fingerprint,
      'prior_correction_evidence', v_prior_correction_evidence,
      'prior_correction_verified', v_prior_correction.id is not null
    ));
  insert into public.historical_payable_time_repairs(
    repair_key, period_id, attendance_id, path_kind, manifest_entry,
    before_fingerprint, after_fingerprint, applied_by
  ) values (
    v_auth.repair_key, p_period_id, v_after.id, p_path_kind, p_manifest_entry,
    v_before_fingerprint, v_after_fingerprint,
    p_actor_user_id
  );

  select count(*) into v_audit_count
  from public.workforce_audit_logs l
  where l.entity_id = v_after.id and l.action = 'historical_payable_time_normalized';
  if v_audit_count <> 1 then raise exception 'Historical repair audit postcondition failed.'; end if;
  return jsonb_build_object(
    'repair_key', v_auth.repair_key, 'attendance_id', v_after.id,
    'previous_version', v_before.attendance_version, 'new_version', v_after.attendance_version,
    'review_status', v_after.review_status, 'payroll_approved_at', v_after.payroll_approved_at,
    'billed_clock_in', v_after.billed_clock_in, 'billed_clock_out', v_after.billed_clock_out,
    'worked_minutes', v_after.total_worked_minutes, 'audit_count', v_audit_count, 'ledger_count', 1
  );
exception when others then
  perform set_config('workforce.correction_recalculation', 'false', true);
  raise;
end;
$$;

create or replace function public.workforce_historical_normalize_payable_time(
  p_period_id uuid,
  p_attendance_id uuid,
  p_actor_user_id uuid,
  p_manifest_entry jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.historical_payable_time_repair_authorizations
    where period_id = p_period_id and attendance_id = p_attendance_id
      and path_kind = 'generic' and enabled is true and manifest_entry = p_manifest_entry
  ) then
    raise exception 'Only the 27 reviewed generic manifest rows are authorized.';
  end if;
  return public.workforce_historical_apply_payable_time(p_period_id, p_attendance_id, p_actor_user_id, 'generic', p_manifest_entry);
end;
$$;

create or replace function public.workforce_historical_repair_dedicated_payable_time(
  p_period_id uuid,
  p_attendance_id uuid,
  p_actor_user_id uuid,
  p_manifest_entry jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_attendance_id not in (
    '3076ca2e-b8b1-4d2f-a0f8-457b8314ab7e'::uuid,
    'f300a6e3-5da4-41b1-9534-82b3a607669b'::uuid,
    '433760ac-d04b-423c-9a30-e8d31726538b'::uuid,
    '86a56253-5512-4387-aac3-1b4374fed8ee'::uuid
  ) then
    raise exception 'Attendance is not one of the four dedicated authorized rows.';
  end if;
  if not exists (
    select 1 from public.historical_payable_time_repair_authorizations
    where period_id = p_period_id and attendance_id = p_attendance_id
      and path_kind = 'dedicated' and enabled is true and manifest_entry = p_manifest_entry
  ) then
    raise exception 'Dedicated repair requires its exact reviewed manifest entry.';
  end if;
  if p_attendance_id = '86a56253-5512-4387-aac3-1b4374fed8ee'::uuid
     and not public.historical_payable_time_prior_correction_matches(p_attendance_id, p_manifest_entry) then
    raise exception 'Jerson Aug 5 prior correction fingerprint or identity guard failed.';
  end if;
  return public.workforce_historical_apply_payable_time(p_period_id, p_attendance_id, p_actor_user_id, 'dedicated', p_manifest_entry);
end;
$$;

revoke all on function public.workforce_historical_apply_payable_time(uuid, uuid, uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.historical_payable_time_prior_correction_matches(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.workforce_historical_normalize_payable_time(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.workforce_historical_repair_dedicated_payable_time(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.workforce_historical_normalize_payable_time(uuid, uuid, uuid, jsonb) to service_role;
grant execute on function public.workforce_historical_repair_dedicated_payable_time(uuid, uuid, uuid, jsonb) to service_role;

alter function public.workforce_historical_apply_payable_time(uuid, uuid, uuid, text, jsonb) owner to postgres;
alter function public.workforce_historical_normalize_payable_time(uuid, uuid, uuid, jsonb) owner to postgres;
alter function public.workforce_historical_repair_dedicated_payable_time(uuid, uuid, uuid, jsonb) owner to postgres;

comment on function public.workforce_historical_normalize_payable_time(uuid, uuid, uuid, jsonb)
  is 'Service-role-only, exact-manifest-authorized generic billed-time normalization for the 27 final Aug 1-15 rows; does not accept free-form targets.';
comment on function public.workforce_historical_repair_dedicated_payable_time(uuid, uuid, uuid, jsonb)
  is 'Service-role-only dedicated guard for Almar Aug 5/Aug 10/Aug 11 and Jerson Aug 5; exact manifest entry required.';

commit;

;
