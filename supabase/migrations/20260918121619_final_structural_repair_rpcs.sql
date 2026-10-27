-- Final structural repair RPCs.
-- Local implementation only. These functions are intentionally service-role-only
-- and require exact production evidence before they can mutate a target row.

begin;
create table public.historical_amora_aug15_duplicate_exclusions (
  id uuid primary key default gen_random_uuid(),
  repair_key text not null unique,
  attendance_id uuid not null unique references public.attendance(id) on delete restrict,
  period_id uuid not null references public.payroll_periods(id) on delete restrict,
  legitimate_aug15_attendance_id uuid not null references public.attendance(id) on delete restrict,
  legitimate_aug16_attendance_id uuid not null references public.attendance(id) on delete restrict,
  workbook_sha256 text not null,
  source_ranges jsonb not null,
  workbook_evidence jsonb not null,
  before_fingerprint jsonb not null,
  reason text not null,
  applied_by uuid not null references public.profiles(user_id) on delete restrict,
  applied_at timestamptz not null default now(),
  constraint historical_amora_exclusion_reason_check check (length(trim(reason)) > 0)
);
create table public.historical_genevive_aug15_repairs (
  id uuid primary key default gen_random_uuid(),
  repair_key text not null unique,
  attendance_id uuid not null unique references public.attendance(id) on delete restrict,
  period_id uuid not null references public.payroll_periods(id) on delete restrict,
  target_schedule_id uuid not null references public.work_schedules(id) on delete restrict,
  target_schedule_version bigint not null,
  workbook_sha256 text not null,
  source_ranges jsonb not null,
  workbook_evidence jsonb not null,
  before_fingerprint jsonb not null,
  after_fingerprint jsonb not null,
  target_billed_clock_in timestamptz not null,
  target_billed_clock_out timestamptz not null,
  target_worked_minutes integer not null,
  target_regular_minutes integer not null,
  target_pre_shift_overtime_minutes integer not null,
  target_post_shift_overtime_minutes integer not null,
  target_total_overtime_minutes integer not null,
  reason text not null,
  applied_by uuid not null references public.profiles(user_id) on delete restrict,
  applied_at timestamptz not null default now(),
  constraint historical_genevive_repair_reason_check check (length(trim(reason)) > 0)
);
create table public.historical_arby_aug05_normalizations (
  id uuid primary key default gen_random_uuid(),
  repair_key text not null unique,
  attendance_id uuid not null unique references public.attendance(id) on delete restrict,
  period_id uuid not null references public.payroll_periods(id) on delete restrict,
  workbook_sha256 text not null,
  source_ranges jsonb not null,
  workbook_evidence jsonb not null,
  before_fingerprint jsonb not null,
  after_fingerprint jsonb not null,
  before_clock_in timestamptz not null,
  after_clock_in timestamptz not null,
  payable_minutes_unchanged boolean not null,
  reason text not null,
  applied_by uuid not null references public.profiles(user_id) on delete restrict,
  applied_at timestamptz not null default now(),
  constraint historical_arby_normalization_reason_check check (length(trim(reason)) > 0),
  constraint historical_arby_normalization_payable_check check (payable_minutes_unchanged)
);
alter table public.historical_amora_aug15_duplicate_exclusions enable row level security;
alter table public.historical_genevive_aug15_repairs enable row level security;
alter table public.historical_arby_aug05_normalizations enable row level security;
revoke all on table public.historical_amora_aug15_duplicate_exclusions from public, anon, authenticated, service_role;
revoke all on table public.historical_genevive_aug15_repairs from public, anon, authenticated, service_role;
revoke all on table public.historical_arby_aug05_normalizations from public, anon, authenticated, service_role;
create or replace function public.final_structural_repair_ledger_immutable()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'Final structural repair ledgers are append-only.';
end;
$$;
alter function public.final_structural_repair_ledger_immutable() owner to postgres;
revoke all on function public.final_structural_repair_ledger_immutable() from public, anon, authenticated, service_role;
create trigger historical_amora_exclusion_immutable
before update or delete on public.historical_amora_aug15_duplicate_exclusions
for each row execute function public.final_structural_repair_ledger_immutable();
create trigger historical_genevive_repair_immutable
before update or delete on public.historical_genevive_aug15_repairs
for each row execute function public.final_structural_repair_ledger_immutable();
create trigger historical_arby_normalization_immutable
before update or delete on public.historical_arby_aug05_normalizations
for each row execute function public.final_structural_repair_ledger_immutable();
create or replace function public.final_structural_repair_shared_guard(
  p_period_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_period public.payroll_periods%rowtype;
  v_legacy_rows bigint;
  v_legacy_minutes bigint;
  v_legacy_fingerprint text;
  v_calculated_records bigint;
begin
  if current_user not in ('postgres', 'service_role') then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;

  if p_period_id is distinct from 'b62ee64a-3da9-48d2-8c4e-f9856e352086'::uuid then
    raise exception 'Only the Aug 1-15, 2026 production period is supported.';
  end if;

  select * into v_period
  from public.payroll_periods
  where id = p_period_id
  for update;
  if not found or v_period.period_start is distinct from '2026-08-01'::date
     or v_period.period_end is distinct from '2026-08-15'::date
     or v_period.status is distinct from 'draft' then
    raise exception 'Aug 1-15 payroll period must remain the exact Draft period.';
  end if;

  if (select count(*) from public.payroll_records where payroll_period_id = p_period_id) <> 9
     or exists (
       select 1 from public.payroll_records
       where payroll_period_id = p_period_id and status is distinct from 'draft'
     ) then
    raise exception 'Exactly nine Draft payroll records are required.';
  end if;

  if exists (
    select 1 from public.payroll_items i
    join public.payroll_records r on r.id = i.payroll_record_id
    where r.payroll_period_id = p_period_id
  ) or exists (
    select 1 from public.payroll_attendance_snapshots s
    join public.payroll_records r on r.id = s.payroll_record_id
    where r.payroll_period_id = p_period_id
  ) or exists (
    select 1 from public.payroll_schedule_snapshots s
    join public.payroll_records r on r.id = s.payroll_record_id
    where r.payroll_period_id = p_period_id
  ) or exists (
    select 1 from public.payroll_hour_allocations a
    join public.payroll_records r on r.id = a.destination_payroll_record_id
    where r.payroll_period_id = p_period_id
  ) or exists (
    select 1 from public.payroll_prepaid_commitments
    where payroll_period_id = p_period_id
  ) then
    raise exception 'Payroll artifacts must be absent.';
  end if;

  select count(*) into v_calculated_records
  from public.payroll_records
  where payroll_period_id = p_period_id
    and (
      calculated_at is not null
      or calculated_by is not null
      or gross_pay <> 0
      or net_pay <> 0
    );
  if v_calculated_records <> 0 then
    raise exception 'Payroll must remain uncalculated.';
  end if;

  select count(*), coalesce(sum(remaining_minutes), 0),
    md5(coalesce(string_agg(to_jsonb(p)::text, '|' order by p.id), ''))
  into v_legacy_rows, v_legacy_minutes, v_legacy_fingerprint
  from public.payroll_prepaid_hours p
  where p.commitment_id is null and p.voided_at is null;

  if v_legacy_rows <> 111
     or v_legacy_minutes <> 10710
     or v_legacy_fingerprint is distinct from '32e1a4aa6e9f27a1ad5cc56f47d44840' then
    raise exception 'Protected legacy prepaid baseline changed.';
  end if;
end;
$$;
revoke all on function public.final_structural_repair_shared_guard(uuid) from public, anon, authenticated;
grant execute on function public.final_structural_repair_shared_guard(uuid) to service_role;
create or replace function public.workforce_historical_exclude_amora_aug15_duplicate(
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
  v_duplicate public.attendance%rowtype;
  v_legit_aug15 public.attendance%rowtype;
  v_legit_aug16 public.attendance%rowtype;
  v_before_fingerprint jsonb;
  v_after public.attendance%rowtype;
  v_audit_count bigint;
  v_preservation_metadata jsonb := jsonb_build_object(
    'classification_reconciliation', jsonb_build_object(
      'stored_total_overtime_minutes', 108,
      'stored_rest_day_overtime_minutes', 108,
      'standalone_current_rule_minutes_for_billed_interval', 900,
      'classification_origin', 'historically produced by the deployed sequential same-work-date overtime cap',
      'discrepancy_known_before_exclusion', true,
      'classifications_intentionally_preserved_during_void', true,
      'void_consumer_basis', 'active attendance and payroll consumers exclude voided_at rows'
    )
  );
begin
  if current_user not in ('postgres', 'service_role') then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;
  if p_actor_user_id is null or not exists (
    select 1 from public.profiles p
    where p.user_id = p_actor_user_id and p.is_system_admin is true
      and p.employment_status <> 'terminated'
  ) then
    raise exception 'A system administrator actor is required.';
  end if;
  if nullif(trim(coalesce(p_repair_key, '')), '') is null
     or length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Repair key and reason are required.';
  end if;
  if upper(trim(coalesce(p_workbook_sha256, ''))) <> '48F388C1A9683314DD6F1CED42D54353B9E5956F100AC287AE4DE5EAE4444E80'
     or p_source_ranges is distinct from '["AMOR!B308:L308","AMOR!B312:L312"]'::jsonb
     or p_workbook_evidence->>'filename' is distinct from '2026 Support Timesheet.xlsx'
     or upper(p_workbook_evidence->>'sha256') is distinct from '48F388C1A9683314DD6F1CED42D54353B9E5956F100AC287AE4DE5EAE4444E80' then
    raise exception 'Workbook or Amora source evidence mismatch.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('final-amora-aug15:' || p_repair_key, 0));
  perform public.final_structural_repair_shared_guard(p_period_id);

  if exists (select 1 from public.historical_amora_aug15_duplicate_exclusions where repair_key = p_repair_key or attendance_id = '050e7f17-8576-419e-8b1a-2bcc5b49a604') then
    raise exception 'Amora exclusion already exists; repeat execution rejected.';
  end if;

  select * into v_duplicate from public.attendance where id = '050e7f17-8576-419e-8b1a-2bcc5b49a604'::uuid for update;
  if not found or v_duplicate.attendance_version <> 6 or v_duplicate.review_status <> 'corrected'
     or v_duplicate.payroll_approved_at is not null or v_duplicate.schedule_id is not null
     or v_duplicate.voided_at is not null or v_duplicate.work_date is distinct from '2026-08-15'::date
     or v_duplicate.billed_clock_in is distinct from '2026-08-15 23:00:00+00'::timestamptz
     or v_duplicate.billed_clock_out is distinct from '2026-08-16 14:00:00+00'::timestamptz
     or v_duplicate.total_worked_minutes <> 900 or v_duplicate.total_overtime_minutes <> 108
     or v_duplicate.rest_day_overtime_minutes <> 108
     or v_duplicate.overtime_minutes <> 108
     or v_duplicate.regular_minutes <> 0
     or v_duplicate.pre_shift_overtime_minutes <> 0
     or v_duplicate.post_shift_overtime_minutes <> 0
     or v_duplicate.holiday_overtime_minutes <> 0 then
    raise exception 'Amora duplicate pre-state guard failed.';
  end if;

  select * into v_legit_aug15 from public.attendance where id = '26d30f4c-49c4-4b26-ae27-873fe239af9a'::uuid for share;
  if not found then raise exception 'The legitimate Amora Aug 15 reference row is missing.'; end if;
  select * into v_legit_aug16 from public.attendance where id = 'ea7a0a24-988a-41dc-9893-2082124d54b9'::uuid for share;
  if not found then raise exception 'The legitimate Amora Aug 16 reference row is missing.'; end if;
  if v_legit_aug15.voided_at is not null or v_legit_aug15.work_date is distinct from '2026-08-15'::date
     or v_legit_aug15.billed_clock_in is distinct from '2026-08-14 23:00:00+00'::timestamptz
     or v_legit_aug15.billed_clock_out is distinct from '2026-08-15 17:00:00+00'::timestamptz
     or v_legit_aug15.total_worked_minutes <> 1080 then
    raise exception 'Legitimate Aug 15 Amora reference changed.';
  end if;
  if v_legit_aug16.voided_at is not null or v_legit_aug16.work_date is distinct from '2026-08-16'::date
     or v_legit_aug16.billed_clock_in is distinct from '2026-08-15 23:00:00+00'::timestamptz
     or v_legit_aug16.billed_clock_out is distinct from '2026-08-16 14:00:00+00'::timestamptz
     or v_legit_aug16.total_worked_minutes <> 900 then
    raise exception 'Legitimate Aug 16 Amora reference changed.';
  end if;

  v_before_fingerprint := jsonb_build_object(
    'attendance', jsonb_build_object(
      'id', v_duplicate.id, 'version', v_duplicate.attendance_version,
      'review_status', v_duplicate.review_status, 'payroll_approved_at', v_duplicate.payroll_approved_at,
      'schedule_id', v_duplicate.schedule_id, 'work_date', v_duplicate.work_date,
      'clock_in', v_duplicate.clock_in, 'clock_out', v_duplicate.clock_out,
      'original_clock_in', v_duplicate.original_clock_in, 'original_clock_out', v_duplicate.original_clock_out,
      'billed_clock_in', v_duplicate.billed_clock_in, 'billed_clock_out', v_duplicate.billed_clock_out,
      'total_worked_minutes', v_duplicate.total_worked_minutes,
      'regular_minutes', v_duplicate.regular_minutes, 'pre_shift_overtime_minutes', v_duplicate.pre_shift_overtime_minutes,
      'post_shift_overtime_minutes', v_duplicate.post_shift_overtime_minutes,
      'rest_day_overtime_minutes', v_duplicate.rest_day_overtime_minutes,
      'holiday_overtime_minutes', v_duplicate.holiday_overtime_minutes,
      'total_overtime_minutes', v_duplicate.total_overtime_minutes,
      'is_corrected', v_duplicate.is_corrected, 'voided_at', v_duplicate.voided_at
    ),
    'references', jsonb_build_object('aug15', to_jsonb(v_legit_aug15), 'aug16', to_jsonb(v_legit_aug16)),
    'source_ranges', p_source_ranges, 'workbook_sha256', upper(trim(p_workbook_sha256))
  );
  if v_before_fingerprint is distinct from p_expected_fingerprint then
    raise exception 'Amora exact pre-state fingerprint mismatch.';
  end if;

  update public.attendance
  set voided_at = statement_timestamp(), voided_by = p_actor_user_id,
      void_reason = trim(p_reason), updated_by = p_actor_user_id,
      updated_at = statement_timestamp()
  where id = v_duplicate.id
  returning * into v_after;

  if v_after.attendance_version <> 7 or v_after.review_status <> 'corrected'
     or v_after.voided_at is null or v_after.schedule_id is not null
     or v_after.billed_clock_in is distinct from v_duplicate.billed_clock_in
     or v_after.billed_clock_out is distinct from v_duplicate.billed_clock_out
     or v_after.total_worked_minutes is distinct from v_duplicate.total_worked_minutes
     or v_after.original_clock_in is distinct from v_duplicate.original_clock_in
     or v_after.original_clock_out is distinct from v_duplicate.original_clock_out then
    raise exception 'Amora soft-void postcondition failed.';
  end if;

  insert into public.historical_amora_aug15_duplicate_exclusions(
    repair_key, attendance_id, period_id, legitimate_aug15_attendance_id,
    legitimate_aug16_attendance_id, workbook_sha256, source_ranges,
    workbook_evidence, before_fingerprint, reason, applied_by
  ) values (
    p_repair_key, v_after.id, p_period_id, v_legit_aug15.id, v_legit_aug16.id,
    upper(trim(p_workbook_sha256)), p_source_ranges, p_workbook_evidence || v_preservation_metadata,
    v_before_fingerprint, trim(p_reason), p_actor_user_id
  );

  insert into public.workforce_audit_logs(
    actor_user_id, action, entity_type, entity_id, before_data, after_data, reason, metadata
  ) values (
    p_actor_user_id, 'historical_amora_aug15_duplicate_excluded', 'attendance', v_after.id,
    v_before_fingerprint, jsonb_build_object('voided_at', v_after.voided_at, 'version', v_after.attendance_version),
    trim(p_reason), jsonb_build_object(
      'repair_key', p_repair_key, 'workbook_sha256', upper(trim(p_workbook_sha256)),
      'source_ranges', p_source_ranges, 'legitimate_aug15_attendance_id', v_legit_aug15.id,
      'legitimate_aug16_attendance_id', v_legit_aug16.id
    ) || v_preservation_metadata
  );

  select count(*) into v_audit_count from public.workforce_audit_logs
  where action = 'historical_amora_aug15_duplicate_excluded' and entity_id = v_after.id;
  if v_audit_count <> 1 or not exists (
    select 1 from public.attendance where id = v_after.id and voided_at is not null
  ) then
    raise exception 'Amora ledger/audit postcondition failed.';
  end if;

  return jsonb_build_object('attendance_id', v_after.id, 'previous_version', 6, 'new_version', v_after.attendance_version, 'review_status', v_after.review_status, 'voided', true, 'ledger_count', 1, 'dedicated_audit_count', v_audit_count);
end;
$$;
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
  select * into v_schedule from public.work_schedules where id = '7dfa9c4b-5f31-406b-9be7-973fd3e5383c'::uuid for update;
  if not found then raise exception 'Genevive target schedule is missing.'; end if;
  if v_before.attendance_version <> 6 or v_before.review_status <> 'corrected'
     or v_before.payroll_approved_at is not null or v_before.schedule_id is not null
     or v_before.work_date is distinct from '2026-08-15'::date
     or v_before.billed_clock_in is distinct from '2026-08-15 06:00:00+00'::timestamptz
     or v_before.billed_clock_out is not null or v_before.total_worked_minutes <> 1249
     or public.workforce_canonical_billed_minutes(v_before.billed_clock_in, v_before.billed_clock_out) <> 1376
     or v_before.original_clock_in is distinct from '2026-08-15 08:06:19.372265+00'::timestamptz
     or v_before.original_clock_out is distinct from '2026-08-16 04:56:10.103086+00'::timestamptz then
    raise exception 'Genevive attendance pre-state guard failed.';
  end if;
  if v_schedule.user_id is distinct from v_before.user_id or v_schedule.shift_date is distinct from v_before.work_date
     or v_schedule.status <> 'published' or v_schedule.is_rest_day or v_schedule.is_holiday
     or v_schedule.schedule_version <> 1 or v_schedule.shift_start is null or v_schedule.shift_end is null then
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
  if public.workforce_canonical_billed_minutes('2026-08-15 06:00:00+00'::timestamptz, '2026-08-16 01:00:00+00'::timestamptz) <> 1140
     or v_calc.total_worked_minutes <> 1140 or v_calc.regular_minutes <> 480
     or v_calc.pre_shift_overtime_minutes <> 360 or v_calc.post_shift_overtime_minutes <> 300
     or v_calc.total_overtime_minutes <> 660 then
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

  if v_after.attendance_version <> 7 or v_after.schedule_id is distinct from v_schedule.id
     or v_after.review_status <> 'corrected' or v_after.payroll_approved_at is not null
     or v_after.billed_clock_in is distinct from '2026-08-15 06:00:00+00'::timestamptz
     or v_after.billed_clock_out is distinct from '2026-08-16 01:00:00+00'::timestamptz
     or v_after.total_worked_minutes <> 1140 or v_after.regular_minutes <> 480
     or v_after.pre_shift_overtime_minutes <> 360 or v_after.post_shift_overtime_minutes <> 300
     or v_after.total_overtime_minutes <> 660
     or v_after.original_clock_in is distinct from v_before.original_clock_in
     or v_after.original_clock_out is distinct from v_before.original_clock_out then
    raise exception 'Genevive reconstruction postcondition failed.';
  end if;

  v_after_fingerprint := jsonb_build_object(
    'attendance', jsonb_build_object('id', v_after.id, 'version', v_after.attendance_version, 'schedule_id', v_after.schedule_id, 'review_status', v_after.review_status, 'payroll_approved_at', v_after.payroll_approved_at, 'billed_clock_in', v_after.billed_clock_in, 'billed_clock_out', v_after.billed_clock_out, 'total_worked_minutes', v_after.total_worked_minutes, 'regular_minutes', v_after.regular_minutes, 'pre_shift_overtime_minutes', v_after.pre_shift_overtime_minutes, 'post_shift_overtime_minutes', v_after.post_shift_overtime_minutes, 'total_overtime_minutes', v_after.total_overtime_minutes, 'original_clock_in', v_after.original_clock_in, 'original_clock_out', v_after.original_clock_out),
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
create or replace function public.workforce_historical_normalize_arby_aug05_clock_in(
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
  v_before_fingerprint jsonb;
  v_after_fingerprint jsonb;
begin
  if current_user not in ('postgres', 'service_role') then raise exception using errcode = '42501', message = 'service_role is required'; end if;
  if p_actor_user_id is null or not exists (select 1 from public.profiles p where p.user_id = p_actor_user_id and p.is_system_admin is true and p.employment_status <> 'terminated') then raise exception 'A system administrator actor is required.'; end if;
  if nullif(trim(coalesce(p_repair_key, '')), '') is null or length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Repair key and reason are required.'; end if;
  if upper(trim(coalesce(p_workbook_sha256, ''))) <> '48F388C1A9683314DD6F1CED42D54353B9E5956F100AC287AE4DE5EAE4444E80'
     or p_source_ranges is distinct from '["ARBY!B298:L298"]'::jsonb
     or p_workbook_evidence->>'filename' is distinct from '2026 Support Timesheet.xlsx'
     or upper(p_workbook_evidence->>'sha256') is distinct from '48F388C1A9683314DD6F1CED42D54353B9E5956F100AC287AE4DE5EAE4444E80' then raise exception 'Workbook or Arby source evidence mismatch.'; end if;

  perform pg_advisory_xact_lock(hashtextextended('final-arby-aug05:' || p_repair_key, 0));
  perform public.final_structural_repair_shared_guard(p_period_id);
  if exists (select 1 from public.historical_arby_aug05_normalizations where repair_key = p_repair_key or attendance_id = '94549865-28cb-4242-b73a-aa5e90ea20f9'::uuid) then raise exception 'Arby normalization already exists; repeat execution rejected.'; end if;

  select * into v_before from public.attendance where id = '94549865-28cb-4242-b73a-aa5e90ea20f9'::uuid for update;
  if not found or v_before.attendance_version <> 12 or v_before.review_status <> 'approved'
     or v_before.payroll_approved_at is null or v_before.clock_in is distinct from '2026-08-04 04:00:00+00'::timestamptz
     or v_before.original_clock_in is distinct from '2026-08-05 03:54:49.774081+00'::timestamptz
     or v_before.original_clock_out is distinct from '2026-08-05 22:00:00.518812+00'::timestamptz
     or v_before.billed_clock_in is distinct from '2026-08-05 04:00:00+00'::timestamptz
     or v_before.billed_clock_out is distinct from '2026-08-05 22:00:00+00'::timestamptz
     or v_before.total_worked_minutes <> 1080 then raise exception 'Arby normalization pre-state guard failed.'; end if;
  if exists (select 1 from public.attendance a where a.id <> v_before.id and a.user_id = v_before.user_id and a.voided_at is null and coalesce(a.billed_clock_in, a.clock_in) < v_before.billed_clock_out and coalesce(a.billed_clock_out, a.clock_out) > v_before.billed_clock_in) then raise exception 'Arby billed overlap guard failed.'; end if;

  v_before_fingerprint := jsonb_build_object('attendance', jsonb_build_object('id', v_before.id, 'version', v_before.attendance_version, 'user_id', v_before.user_id, 'work_date', v_before.work_date, 'schedule_id', v_before.schedule_id, 'review_status', v_before.review_status, 'payroll_approved_at', v_before.payroll_approved_at, 'clock_in', v_before.clock_in, 'clock_out', v_before.clock_out, 'original_clock_in', v_before.original_clock_in, 'original_clock_out', v_before.original_clock_out, 'billed_clock_in', v_before.billed_clock_in, 'billed_clock_out', v_before.billed_clock_out, 'total_worked_minutes', v_before.total_worked_minutes, 'regular_minutes', v_before.regular_minutes, 'pre_shift_overtime_minutes', v_before.pre_shift_overtime_minutes, 'post_shift_overtime_minutes', v_before.post_shift_overtime_minutes, 'rest_day_overtime_minutes', v_before.rest_day_overtime_minutes, 'holiday_overtime_minutes', v_before.holiday_overtime_minutes, 'total_overtime_minutes', v_before.total_overtime_minutes), 'source_ranges', p_source_ranges, 'workbook_sha256', upper(trim(p_workbook_sha256)));
  if v_before_fingerprint is distinct from p_expected_fingerprint then raise exception 'Arby exact pre-state fingerprint mismatch.'; end if;

  update public.attendance
  set clock_in = '2026-08-05 04:00:00+00'::timestamptz,
      review_status = 'corrected', reviewed_by = null, reviewed_at = null,
      payroll_approved_at = null, correction_reason = trim(p_reason),
      corrected_by = p_actor_user_id, corrected_at = statement_timestamp(),
      updated_by = p_actor_user_id, updated_at = statement_timestamp()
  where id = v_before.id returning * into v_after;

  if v_after.attendance_version <> 13 or v_after.clock_in is distinct from '2026-08-05 04:00:00+00'::timestamptz
     or v_after.review_status <> 'corrected' or v_after.payroll_approved_at is not null
     or v_after.original_clock_in is distinct from v_before.original_clock_in
     or v_after.original_clock_out is distinct from v_before.original_clock_out
     or v_after.billed_clock_in is distinct from v_before.billed_clock_in
     or v_after.billed_clock_out is distinct from v_before.billed_clock_out
     or v_after.total_worked_minutes is distinct from v_before.total_worked_minutes
     or v_after.regular_minutes is distinct from v_before.regular_minutes
     or v_after.pre_shift_overtime_minutes is distinct from v_before.pre_shift_overtime_minutes
     or v_after.post_shift_overtime_minutes is distinct from v_before.post_shift_overtime_minutes
     or v_after.total_overtime_minutes is distinct from v_before.total_overtime_minutes
     or v_after.schedule_id is distinct from v_before.schedule_id then raise exception 'Arby normalization postcondition failed.'; end if;

  v_after_fingerprint := jsonb_build_object('attendance', jsonb_build_object('id', v_after.id, 'version', v_after.attendance_version, 'clock_in', v_after.clock_in, 'review_status', v_after.review_status, 'payroll_approved_at', v_after.payroll_approved_at, 'original_clock_in', v_after.original_clock_in, 'original_clock_out', v_after.original_clock_out, 'billed_clock_in', v_after.billed_clock_in, 'billed_clock_out', v_after.billed_clock_out, 'total_worked_minutes', v_after.total_worked_minutes, 'regular_minutes', v_after.regular_minutes, 'pre_shift_overtime_minutes', v_after.pre_shift_overtime_minutes, 'post_shift_overtime_minutes', v_after.post_shift_overtime_minutes, 'total_overtime_minutes', v_after.total_overtime_minutes, 'schedule_id', v_after.schedule_id), 'source_ranges', p_source_ranges, 'workbook_sha256', upper(trim(p_workbook_sha256)));
  insert into public.historical_arby_aug05_normalizations(repair_key, attendance_id, period_id, workbook_sha256, source_ranges, workbook_evidence, before_fingerprint, after_fingerprint, before_clock_in, after_clock_in, payable_minutes_unchanged, reason, applied_by)
  values (p_repair_key, v_after.id, p_period_id, upper(trim(p_workbook_sha256)), p_source_ranges, p_workbook_evidence, v_before_fingerprint, v_after_fingerprint, v_before.clock_in, v_after.clock_in, true, trim(p_reason), p_actor_user_id);
  insert into public.workforce_audit_logs(actor_user_id, action, entity_type, entity_id, before_data, after_data, reason, metadata)
  values (p_actor_user_id, 'historical_arby_aug05_clock_normalized', 'attendance', v_after.id, v_before_fingerprint, v_after_fingerprint, trim(p_reason), jsonb_build_object('repair_key', p_repair_key, 'workbook_sha256', upper(trim(p_workbook_sha256)), 'source_ranges', p_source_ranges, 'payable_minutes_unchanged', true));
  return jsonb_build_object('attendance_id', v_after.id, 'previous_version', 12, 'new_version', v_after.attendance_version, 'review_status', v_after.review_status, 'payroll_approved_at', v_after.payroll_approved_at, 'clock_in', v_after.clock_in, 'payable_minutes_unchanged', true, 'ledger_count', 1);
end;
$$;
revoke all on function public.workforce_historical_exclude_amora_aug15_duplicate(uuid,uuid,text,text,text,jsonb,jsonb,jsonb) from public, anon, authenticated;
revoke all on function public.workforce_historical_reconstruct_genevive_aug15(uuid,uuid,text,text,text,jsonb,jsonb,jsonb) from public, anon, authenticated;
revoke all on function public.workforce_historical_normalize_arby_aug05_clock_in(uuid,uuid,text,text,text,jsonb,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.workforce_historical_exclude_amora_aug15_duplicate(uuid,uuid,text,text,text,jsonb,jsonb,jsonb) to service_role;
grant execute on function public.workforce_historical_reconstruct_genevive_aug15(uuid,uuid,text,text,text,jsonb,jsonb,jsonb) to service_role;
grant execute on function public.workforce_historical_normalize_arby_aug05_clock_in(uuid,uuid,text,text,text,jsonb,jsonb,jsonb) to service_role;
comment on function public.workforce_historical_exclude_amora_aug15_duplicate(uuid,uuid,text,text,text,jsonb,jsonb,jsonb) is 'Service-role-only exact-evidence soft exclusion for the Amora Aug 15 historical duplicate.';
comment on function public.workforce_historical_reconstruct_genevive_aug15(uuid,uuid,text,text,text,jsonb,jsonb,jsonb) is 'Service-role-only exact-evidence reconstruction for Genevive Aug 15; leaves the row corrected and unapproved.';
comment on function public.workforce_historical_normalize_arby_aug05_clock_in(uuid,uuid,text,text,text,jsonb,jsonb,jsonb) is 'Service-role-only exact-evidence Arby Aug 5 stored clock normalization; payable minutes remain unchanged.';
commit;
