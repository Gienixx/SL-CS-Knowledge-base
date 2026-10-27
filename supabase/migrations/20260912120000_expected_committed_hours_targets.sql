-- Expected Committed Hours planning layer.
--
-- This migration deliberately does not rename the existing prepaid tables or
-- columns.  Existing schedule-backed prepaid balances remain valid; the new
-- planning parent is used when an administrator commits an expected total for
-- a date without changing attendance or creating a schedule.
-- A zero-coverage target is retained for history/display; do not create an
-- invalid zero-minute payroll_prepaid_hours balance.

begin;
alter table public.payroll_records
  add constraint payroll_records_period_id_key unique (payroll_period_id, id);
create table public.payroll_prepaid_commitments (
  id uuid primary key default gen_random_uuid(),
  payroll_period_id uuid not null references public.payroll_periods(id) on delete restrict,
  payroll_record_id uuid not null,
  employee_id uuid not null references public.profiles(user_id) on delete restrict,
  work_date date not null,
  expected_minutes integer not null,
  payroll_ready_minutes_at_creation integer not null,
  coverage_minutes integer not null,
  replacement_coverage_minutes integer not null,
  prepaid_day_type text not null,
  approval_evidence jsonb not null default '[]'::jsonb,
  created_by uuid references public.profiles(user_id) on delete restrict,
  reason text not null,
  commitment_version integer not null default 1,
  root_commitment_id uuid,
  supersedes_commitment_id uuid references public.payroll_prepaid_commitments(id) on delete restrict,
  superseded_at timestamptz,
  superseded_by uuid references public.profiles(user_id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint payroll_prepaid_commitments_record_employee_fkey
    foreign key (payroll_record_id, employee_id)
    references public.payroll_records(id, employee_id) on delete restrict,
  constraint payroll_prepaid_commitments_period_record_fkey
    foreign key (payroll_period_id, payroll_record_id)
    references public.payroll_records(payroll_period_id, id) on delete restrict,
  constraint payroll_prepaid_commitments_day_type_check
    check (prepaid_day_type in ('ordinary', 'rest_day')),
  constraint payroll_prepaid_commitments_expected_check
    check (expected_minutes > 0 and expected_minutes <= 1440),
  constraint payroll_prepaid_commitments_ready_check
    check (payroll_ready_minutes_at_creation >= 0),
  constraint payroll_prepaid_commitments_coverage_check
    check (coverage_minutes = greatest(expected_minutes - payroll_ready_minutes_at_creation, 0)),
  constraint payroll_prepaid_commitments_replacement_check
    check (replacement_coverage_minutes >= 0),
  constraint payroll_prepaid_commitments_evidence_check
    check (jsonb_typeof(approval_evidence) = 'array'),
  constraint payroll_prepaid_commitments_reason_check
    check (length(trim(reason)) > 0),
  constraint payroll_prepaid_commitments_version_check
    check (commitment_version > 0),
  constraint payroll_prepaid_commitments_superseded_pair_check
    check ((superseded_at is null) = (superseded_by is null)),
  constraint payroll_prepaid_commitments_root_check
    check (root_commitment_id is null or root_commitment_id <> id)
);
alter table public.payroll_prepaid_commitments
  add constraint payroll_prepaid_commitments_id_employee_key unique (id, employee_id);
create unique index payroll_prepaid_commitments_active_target_key
  on public.payroll_prepaid_commitments
    (payroll_period_id, employee_id, work_date, prepaid_day_type)
  where superseded_at is null;
create index payroll_prepaid_commitments_period_date_idx
  on public.payroll_prepaid_commitments (payroll_period_id, work_date, employee_id);
create index payroll_prepaid_commitments_employee_date_idx
  on public.payroll_prepaid_commitments (employee_id, work_date, created_at desc);
create table public.payroll_prepaid_commitment_evidence (
  id uuid primary key default gen_random_uuid(),
  commitment_id uuid not null,
  employee_id uuid not null,
  attendance_id uuid not null references public.attendance(id) on delete restrict,
  attendance_updated_at timestamptz,
  payroll_approved_at timestamptz,
  minute_category text not null,
  eligible_minutes integer not null,
  captured_at timestamptz not null default now(),
  constraint payroll_prepaid_commitment_evidence_commitment_fkey
    foreign key (commitment_id, employee_id)
    references public.payroll_prepaid_commitments(id, employee_id) on delete restrict,
  constraint payroll_prepaid_commitment_evidence_category_check
    check (minute_category in ('regular', 'rest_day_overtime')),
  constraint payroll_prepaid_commitment_evidence_minutes_check
    check (eligible_minutes > 0),
  constraint payroll_prepaid_commitment_evidence_key
    unique (commitment_id, attendance_id, minute_category)
);
create index payroll_prepaid_commitment_evidence_attendance_idx
  on public.payroll_prepaid_commitment_evidence (attendance_id, captured_at desc);
drop trigger if exists payroll_prepaid_commitment_evidence_immutable
  on public.payroll_prepaid_commitment_evidence;
create trigger payroll_prepaid_commitment_evidence_immutable
before update or delete on public.payroll_prepaid_commitment_evidence
for each row execute function public.payroll_prevent_reconciliation_history_mutation();
-- A planning commitment is a valid source even when no schedule snapshot
-- exists.  Legacy rows continue to use source_schedule_snapshot_id.
alter table public.payroll_prepaid_hours
  alter column source_schedule_snapshot_id drop not null;
alter table public.payroll_prepaid_hours
  add column commitment_id uuid,
  add constraint payroll_prepaid_hours_commitment_employee_fkey
    foreign key (commitment_id, employee_id)
    references public.payroll_prepaid_commitments(id, employee_id) on delete restrict,
  add constraint payroll_prepaid_hours_one_source_check
    check (num_nonnulls(source_schedule_snapshot_id, commitment_id) = 1);
alter table public.payroll_prepaid_hours
  drop constraint if exists payroll_prepaid_hours_source_fkey,
  add constraint payroll_prepaid_hours_source_snapshot_fkey
    foreign key (
      source_schedule_snapshot_id,
      source_payroll_record_id,
      employee_id
    ) references public.payroll_schedule_snapshots(
      id, payroll_record_id, employee_id
    ) on delete restrict;
create unique index payroll_prepaid_hours_commitment_key
  on public.payroll_prepaid_hours (commitment_id)
  where commitment_id is not null;
create index payroll_prepaid_hours_commitment_fifo_idx
  on public.payroll_prepaid_hours (commitment_id, created_at, id)
  where commitment_id is not null and voided_at is null;
comment on table public.payroll_prepaid_commitments is
  'Date-level expected Committed Hours targets. Rendered attendance is informational; only payroll-ready minutes captured at creation reduce coverage.';
comment on column public.payroll_prepaid_commitments.payroll_ready_minutes_at_creation is
  'Canonical approved/payroll-ready eligible base minutes captured atomically when this target version was created. Never use rendered or clock-in minutes here.';
comment on column public.payroll_prepaid_commitments.coverage_minutes is
  'Initial coverage: max(expected_minutes - payroll_ready_minutes_at_creation, 0).';
comment on column public.payroll_prepaid_commitments.replacement_coverage_minutes is
  'New balance coverage after preserving settled minutes from superseded target versions.';
comment on column public.payroll_prepaid_commitments.approval_evidence is
  'Immutable JSON summary of approved/payroll-ready attendance used for the creation baseline.';
comment on column public.payroll_prepaid_hours.commitment_id is
  'Planning-level Committed Hours source. Null identifies legacy schedule-backed prepaid history.';
alter table public.payroll_prepaid_commitments enable row level security;
alter table public.payroll_prepaid_commitment_evidence enable row level security;
revoke all on table public.payroll_prepaid_commitments, public.payroll_prepaid_commitment_evidence
  from public, anon, authenticated;
grant select on table public.payroll_prepaid_commitments, public.payroll_prepaid_commitment_evidence
  to authenticated;
grant all on table public.payroll_prepaid_commitments, public.payroll_prepaid_commitment_evidence
  to service_role;
create policy "Payroll processors can view expected prepaid commitments"
on public.payroll_prepaid_commitments for select to authenticated
using (
  public.workforce_has_permission('create_payroll')
  or public.workforce_has_permission('review_payroll')
  or public.workforce_has_permission('finalize_payroll')
  or public.workforce_has_permission('reopen_payroll')
);
create policy "Payroll processors can view commitment evidence"
on public.payroll_prepaid_commitment_evidence for select to authenticated
using (
  public.workforce_has_permission('create_payroll')
  or public.workforce_has_permission('review_payroll')
  or public.workforce_has_permission('finalize_payroll')
  or public.workforce_has_permission('reopen_payroll')
);
-- Return the authoritative day type without materializing a schedule. Holiday
-- remains the only blocked type; a recurring Rest Day template is enough to
-- classify a no-schedule planning date as Rest Day.
create or replace function public.payroll_expected_commitment_day_type(
  p_employee_id uuid,
  p_work_date date
)
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when exists (
      select 1 from public.work_schedules schedule
      where schedule.user_id = p_employee_id
        and schedule.shift_date = p_work_date
        and schedule.is_holiday
        and schedule.status in ('published', 'changed', 'completed')
    ) then 'holiday'
    when exists (
      select 1 from public.work_schedules schedule
      where schedule.user_id = p_employee_id
        and schedule.shift_date = p_work_date
        and schedule.is_rest_day
        and schedule.status in ('published', 'changed', 'completed')
    ) then 'rest_day'
    when exists (
      select 1 from public.work_schedule_template_assignments assignment
      join public.profiles profile on profile.user_id = p_employee_id
      join public.work_schedule_templates template
        on template.id = assignment.template_id and template.is_active
      join public.work_schedule_template_days template_day
        on template_day.template_id = template.id
       and template_day.weekday = extract(dow from p_work_date)::integer
       and template_day.is_rest_day
      where assignment.is_active
        and (assignment.user_id = p_employee_id or (assignment.user_id is null and assignment.team_id = profile.team_id))
        and assignment.effective_from <= p_work_date
        and (assignment.effective_until is null or assignment.effective_until >= p_work_date)
    ) then 'rest_day'
    else 'ordinary'
  end;
$function$;
-- Candidate read model intentionally reports rendered minutes separately from
-- payroll-ready minutes. It does not reject an attendance row or clocked-in
-- state, and it includes Rest Day/no-schedule planning dates.
create or replace function public.payroll_get_expected_prepaid_commitment_candidates(
  p_payroll_period_id uuid
)
returns table (
  payroll_record_id uuid,
  employee_user_id uuid,
  employee_name text,
  employee_number text,
  employee_email text,
  work_date date,
  attendance_status text,
  rendered_minutes integer,
  payroll_ready_minutes integer,
  expected_minutes integer,
  coverage_minutes integer,
  prepaid_day_type text,
  commitment_id uuid,
  commitment_version integer,
  schedule_id uuid,
  is_holiday boolean,
  can_approve boolean,
  approval_message text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if auth.uid() is null
     or not public.workforce_current_user_is_active()
     or not (
       public.workforce_has_permission('create_payroll')
       or public.workforce_has_permission('review_payroll')
       or public.workforce_has_permission('finalize_payroll')
       or public.workforce_has_permission('reopen_payroll')
     ) then
    raise exception using errcode = '42501', message = 'You do not have permission to view Committed Hours planning.';
  end if;

  return query
  select
    record.id,
    profile.user_id,
    profile.full_name,
    profile.employee_id,
    profile.email,
    dates.work_date::date,
    case
      when exists (
        select 1 from public.attendance a
        where a.user_id = profile.user_id and a.work_date = dates.work_date
          and a.clock_out is null and a.clock_in is not null
      ) then 'In Progress'
      when exists (
        select 1 from public.attendance a
        where a.user_id = profile.user_id and a.work_date = dates.work_date
          and a.review_status in ('approved', 'locked')
      ) then 'Approved'
      when exists (
        select 1 from public.attendance a
        where a.user_id = profile.user_id and a.work_date = dates.work_date
      ) then 'Rendered / awaiting approval'
      else 'No attendance'
    end,
    coalesce((
      select sum(greatest(a.total_worked_minutes, 0))::integer
      from public.attendance a
      where a.user_id = profile.user_id and a.work_date = dates.work_date
    ), 0),
    coalesce((
      select sum(case when public.payroll_expected_commitment_day_type(profile.user_id, dates.work_date::date) = 'rest_day'
        then greatest(r.rest_day_overtime_minutes, 0)
        else greatest(r.regular_minutes, 0) end)::integer
      from public.workforce_attendance_payroll_readiness r
      where r.user_id = profile.user_id and r.work_date = dates.work_date
        and r.is_payroll_ready and r.review_status in ('approved', 'locked')
    ), 0),
    target.expected_minutes,
    coalesce(balance.remaining_minutes, 0),
    public.payroll_expected_commitment_day_type(profile.user_id, dates.work_date::date),
    target.id,
    target.commitment_version,
    schedule.id,
    coalesce(schedule.is_holiday, false),
    period.status in ('draft', 'reopened')
      and record.status <> 'finalized'
      and public.payroll_expected_commitment_day_type(profile.user_id, dates.work_date::date) <> 'holiday',
    case
      when coalesce(schedule.is_holiday, false) then 'Holiday dates remain blocked.'
      when period.status not in ('draft', 'reopened') or record.status = 'finalized' then 'Finalized or locked payroll cannot be changed.'
      else 'Attendance is informational. Only approved/payroll-ready minutes reduce coverage.'
    end
  from public.payroll_records record
  join public.payroll_periods period on period.id = record.payroll_period_id
  join public.profiles profile on profile.user_id = record.employee_id
  cross join lateral generate_series(period.period_start, period.period_end, interval '1 day') dates(work_date)
  left join lateral (
    select s.* from public.work_schedules s
    where s.user_id = profile.user_id and s.shift_date = dates.work_date
    order by s.shift_sequence, s.id desc limit 1
  ) schedule on true
  left join lateral (
    select c.* from public.payroll_prepaid_commitments c
    where c.payroll_period_id = period.id and c.employee_id = profile.user_id
      and c.work_date = dates.work_date and c.superseded_at is null
    order by c.commitment_version desc, c.created_at desc limit 1
  ) target on true
  left join public.payroll_prepaid_hours balance
    on balance.commitment_id = target.id and balance.voided_at is null
  where record.payroll_period_id = p_payroll_period_id
    and record.status <> 'void'
  order by profile.full_name, dates.work_date;
end;
$function$;
-- Capture only canonical approved/payroll-ready eligible minutes. This is the
-- exact baseline used by the coverage formula; rendered minutes never enter it.
create or replace function public.payroll_capture_expected_commitment_evidence(
  p_commitment_id uuid,
  p_employee_id uuid,
  p_work_date date,
  p_prepaid_day_type text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_evidence jsonb := '[]'::jsonb;
  v_minutes integer;
  v_category text;
  row_data record;
begin
  for row_data in
    select
      r.id as attendance_id,
      r.updated_at as attendance_updated_at,
      r.reviewed_at as payroll_approved_at,
      case when p_prepaid_day_type = 'rest_day' then 'rest_day_overtime' else 'regular' end as minute_category,
      case when p_prepaid_day_type = 'rest_day' then r.rest_day_overtime_minutes else r.regular_minutes end as eligible_minutes
    from public.workforce_attendance_payroll_readiness r
    where r.user_id = p_employee_id
      and r.work_date = p_work_date
      and r.is_payroll_ready
      and r.review_status in ('approved', 'locked')
      and (case when p_prepaid_day_type = 'rest_day' then r.rest_day_overtime_minutes else r.regular_minutes end) > 0
    order by r.id
  loop
    insert into public.payroll_prepaid_commitment_evidence (
      commitment_id, employee_id, attendance_id, attendance_updated_at,
      payroll_approved_at, minute_category, eligible_minutes
    ) values (
      p_commitment_id, p_employee_id, row_data.attendance_id,
      row_data.attendance_updated_at, row_data.payroll_approved_at,
      row_data.minute_category, row_data.eligible_minutes
    );
    v_evidence := v_evidence || jsonb_build_array(jsonb_build_object(
      'attendance_id', row_data.attendance_id,
      'attendance_updated_at', row_data.attendance_updated_at,
      'payroll_approved_at', row_data.payroll_approved_at,
      'minute_category', row_data.minute_category,
      'eligible_minutes', row_data.eligible_minutes
    ));
  end loop;
  return v_evidence;
end;
$function$;
-- New target RPC. It replaces the active target for the date/day type. It does
-- not inspect clock-in as an eligibility gate, change schedules, or insert
-- attendance. Concurrent writes for the same employee/date are serialized by
-- an advisory transaction lock plus the partial unique active-target index.
create or replace function public.payroll_save_expected_prepaid_commitment(
  p_payroll_period_id uuid,
  p_employee_id uuid,
  p_work_date date,
  p_expected_minutes integer,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := public.workforce_current_profile_id();
  v_period public.payroll_periods%rowtype;
  v_record public.payroll_records%rowtype;
  v_old public.payroll_prepaid_commitments%rowtype;
  v_day_type text;
  v_ready integer := 0;
  v_coverage integer;
  v_replacement integer;
  v_prior_settled integer := 0;
  v_root_baseline integer;
  v_version integer := 1;
  v_commitment_id uuid;
  v_balance_id uuid;
  v_evidence jsonb := '[]'::jsonb;
begin
  if auth.uid() is null or v_actor is null
     or not public.workforce_has_permission('create_payroll') then
    raise exception using errcode = '42501', message = 'You do not have permission to add Committed Hours.';
  end if;
  if p_expected_minutes is null or p_expected_minutes <= 0 or p_expected_minutes > 1440 then
    raise exception using errcode = '22023', message = 'Expected Committed Hours must be between 1 minute and 24 hours.';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception using errcode = '22023', message = 'An approval reason is required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'public.payroll_expected_commitment:' || p_payroll_period_id::text || ':' ||
      p_employee_id::text || ':' || p_work_date::text, 0));

  select * into v_period from public.payroll_periods where id = p_payroll_period_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Payroll period was not found.'; end if;
  if v_period.status not in ('draft', 'reopened') then
    raise exception using errcode = '55000', message = 'Committed Hours can only be changed while payroll is draft or reopened.';
  end if;
  if p_work_date < v_period.period_start or p_work_date > v_period.period_end then
    raise exception using errcode = '22023', message = 'The commitment date must be inside the payroll cutoff.';
  end if;

  select * into v_record from public.payroll_records
  where payroll_period_id = p_payroll_period_id and employee_id = p_employee_id and status <> 'void'
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'The employee has no payroll record in this period.'; end if;
  if v_record.status = 'finalized' then raise exception using errcode = '55000', message = 'Finalized payroll cannot be changed.'; end if;

  v_day_type := public.payroll_expected_commitment_day_type(p_employee_id, p_work_date);
  if v_day_type = 'holiday' then raise exception using errcode = '22023', message = 'Holiday dates remain blocked for Committed Hours.'; end if;

  select coalesce(sum(case when v_day_type = 'rest_day' then r.rest_day_overtime_minutes else r.regular_minutes end), 0)::integer
  into v_ready
  from public.workforce_attendance_payroll_readiness r
  where r.user_id = p_employee_id and r.work_date = p_work_date
    and r.is_payroll_ready and r.review_status in ('approved', 'locked')
    and (case when v_day_type = 'rest_day' then r.rest_day_overtime_minutes else r.regular_minutes end) > 0;

  select * into v_old from public.payroll_prepaid_commitments
  where payroll_period_id = p_payroll_period_id and employee_id = p_employee_id
    and work_date = p_work_date and prepaid_day_type = v_day_type and superseded_at is null
  for update;

  if v_old.id is not null then
    select coalesce(sum(allocation.allocated_minutes), 0)::integer into v_prior_settled
    from public.payroll_prepaid_commitments c
    join public.payroll_prepaid_hours prepaid on prepaid.commitment_id = c.id
    join public.payroll_hour_allocations allocation
      on allocation.prepaid_hour_id = prepaid.id
     and allocation.employee_id = prepaid.employee_id
     and allocation.allocation_type = 'settlement'
     and not exists (
       select 1
       from public.payroll_hour_allocations reversal
       where reversal.reverses_allocation_id = allocation.id
     )
    where c.payroll_period_id = p_payroll_period_id and c.employee_id = p_employee_id
      and c.work_date = p_work_date and c.prepaid_day_type = v_day_type;
    if v_old.root_commitment_id is null then
      v_root_baseline := v_old.payroll_ready_minutes_at_creation;
    else
      select coalesce(root.payroll_ready_minutes_at_creation, v_old.payroll_ready_minutes_at_creation)
      into v_root_baseline
      from public.payroll_prepaid_commitments root
      where root.id = coalesce(v_old.root_commitment_id, v_old.id);
    end if;
    v_version := v_old.commitment_version + 1;
  else
    v_root_baseline := v_ready;
  end if;

  v_coverage := greatest(p_expected_minutes - v_ready, 0);
  v_replacement := greatest(p_expected_minutes - coalesce(v_root_baseline, v_ready) - v_prior_settled, 0);

  -- Deactivate the old target before inserting its replacement so the partial
  -- unique active-target index is never violated. The surrounding transaction
  -- rolls this back if any later correction step fails.
  if v_old.id is not null then
    update public.payroll_prepaid_commitments
    set superseded_at = statement_timestamp(), superseded_by = v_actor
    where id = v_old.id;
  end if;

  insert into public.payroll_prepaid_commitments (
    payroll_period_id, payroll_record_id, employee_id, work_date,
    expected_minutes, payroll_ready_minutes_at_creation, coverage_minutes,
    replacement_coverage_minutes, prepaid_day_type, created_by, reason,
    commitment_version, root_commitment_id, supersedes_commitment_id
  ) values (
    p_payroll_period_id, v_record.id, p_employee_id, p_work_date,
    p_expected_minutes, v_ready, v_coverage, v_replacement, v_day_type,
    v_actor, trim(p_reason), v_version,
    coalesce(v_old.root_commitment_id, v_old.id), v_old.id
  ) returning id into v_commitment_id;

  v_evidence := public.payroll_capture_expected_commitment_evidence(
    v_commitment_id, p_employee_id, p_work_date, v_day_type);

  update public.payroll_prepaid_commitments
  set approval_evidence = v_evidence
  where id = v_commitment_id;

  if v_old.id is not null then
    update public.payroll_prepaid_hours old_balance
    set voided_at = statement_timestamp(), voided_by = v_actor,
        void_reason = 'Replaced by expected Committed Hours target version ' || v_version::text || '.',
        superseded_by_id = v_balance_id
    where old_balance.commitment_id = v_old.id and old_balance.voided_at is null;
  end if;

  if v_replacement > 0 then
    insert into public.payroll_prepaid_hours (
      source_payroll_record_id, source_schedule_snapshot_id, commitment_id,
      employee_id, prepaid_minutes, settled_minutes, created_by, created_at, updated_at
    ) values (
      v_record.id, null, v_commitment_id, p_employee_id, v_replacement,
      0, v_actor, statement_timestamp(), statement_timestamp()
    ) returning id into v_balance_id;

    if v_old.id is not null then
      update public.payroll_prepaid_hours old_balance
      set superseded_by_id = v_balance_id
      where old_balance.commitment_id = v_old.id and old_balance.voided_at is not null
        and old_balance.superseded_by_id is null;
    end if;
  end if;

  insert into public.payroll_audit_logs (
    actor_user_id, action, entity_type, entity_id, payroll_period_id,
    payroll_record_id, before_data, after_data, reason, metadata
  ) values (
    v_actor, case when v_old.id is null then 'payroll_expected_commitment_created' else 'payroll_expected_commitment_corrected' end,
    'payroll_prepaid_commitment', v_commitment_id, p_payroll_period_id,
    v_record.id, case when v_old.id is null then null else to_jsonb(v_old) end,
    jsonb_build_object(
      'commitment_id', v_commitment_id, 'employee_id', p_employee_id,
      'work_date', p_work_date, 'expected_minutes', p_expected_minutes,
      'payroll_ready_minutes_at_creation', v_ready, 'coverage_minutes', v_coverage,
      'replacement_coverage_minutes', v_replacement, 'prepaid_day_type', v_day_type,
      'rendered_minutes_used_as_baseline', false, 'balance_id', v_balance_id
    ), trim(p_reason), jsonb_build_object(
      'supersedes_commitment_id', v_old.id, 'prior_settled_minutes', v_prior_settled,
      'approval_evidence_count', jsonb_array_length(v_evidence)
    )
  );

  return jsonb_build_object(
    'commitment_id', v_commitment_id, 'payroll_record_id', v_record.id,
    'employee_id', p_employee_id, 'work_date', p_work_date,
    'prepaid_day_type', v_day_type, 'expected_minutes', p_expected_minutes,
    'payroll_ready_minutes_at_creation', v_ready, 'coverage_minutes', v_coverage,
    'replacement_coverage_minutes', v_replacement, 'prepaid_hour_id', v_balance_id,
    'commitment_version', v_version, 'replaced_commitment_id', v_old.id
  );
end;
$function$;
-- New commitments settle by approval delta, never by rendered duration. The
-- existing legacy trigger continues to own source-snapshot balances.
create or replace function public.payroll_reconcile_expected_commitment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_commitment record;
  v_balance record;
  v_current integer;
  v_baseline integer;
  v_allocated integer;
  v_needed integer;
  v_snapshot_minutes integer;
  v_category text;
  v_actor uuid := public.workforce_current_profile_id();
begin
  for v_commitment in
    select
      c.*,
      p.prepaid_minutes,
      greatest(
        p.prepaid_minutes - coalesce((
          select sum(active_allocation.allocated_minutes)
          from public.payroll_hour_allocations active_allocation
          where active_allocation.prepaid_hour_id = p.id
            and active_allocation.employee_id = p.employee_id
            and active_allocation.allocation_type = 'settlement'
            and not exists (
              select 1
              from public.payroll_hour_allocations reversal
              where reversal.reverses_allocation_id = active_allocation.id
            )
        ), 0),
        0
      )::integer as remaining_minutes,
      p.id as prepaid_hour_id
    from public.payroll_prepaid_commitments c
    join public.payroll_prepaid_hours p on p.commitment_id = c.id and p.voided_at is null
    where c.employee_id = new.employee_id and c.work_date = new.work_date
      and c.payroll_period_id = (select payroll_period_id from public.payroll_records where id = new.payroll_record_id)
    order by c.created_at, c.id
  loop
    if v_commitment.prepaid_day_type = 'rest_day' then
      v_category := 'rest_day_overtime';
      v_snapshot_minutes := greatest(new.rest_day_overtime_minutes, 0);
    else
      v_category := 'regular';
      v_snapshot_minutes := greatest(new.regular_minutes, 0);
    end if;

    select coalesce(sum(case when v_commitment.prepaid_day_type = 'rest_day' then r.rest_day_overtime_minutes else r.regular_minutes end), 0)::integer
    into v_current
    from public.workforce_attendance_payroll_readiness r
    where r.user_id = new.employee_id and r.work_date = new.work_date
      and r.is_payroll_ready and r.review_status in ('approved', 'locked');

    v_baseline := v_commitment.payroll_ready_minutes_at_creation;
    select coalesce(sum(a.allocated_minutes), 0)::integer into v_allocated
    from public.payroll_hour_allocations a
    where a.prepaid_hour_id = v_commitment.prepaid_hour_id
      and a.allocation_type = 'settlement'
      and not exists (
        select 1
        from public.payroll_hour_allocations reversal
        where reversal.reverses_allocation_id = a.id
      );

    v_needed := least(
      greatest(v_commitment.remaining_minutes, 0),
      greatest(v_current - v_baseline - v_allocated, 0),
      v_snapshot_minutes
    );

    if v_needed > 0 then
      insert into public.payroll_hour_allocations (
        prepaid_hour_id, employee_id, destination_payroll_record_id,
        attendance_snapshot_id, allocation_type, minute_category,
        allocated_minutes, calculation_version, reason, created_by
      ) values (
        v_commitment.prepaid_hour_id, new.employee_id, new.payroll_record_id,
        new.id, 'settlement', v_category, v_needed,
        greatest(new.attendance_version::integer, 1),
        'Approved attendance delta fulfilled expected Committed Hours target.', v_actor
      ) on conflict do nothing;

      -- Allocation history is authoritative. Recompute the mutable balance
      -- counter from valid active settlement allocations after every insert
      -- (including a conflict retry), keeping remaining_minutes and status in
      -- sync without allowing a negative balance.
      update public.payroll_prepaid_hours balance
      set settled_minutes = least(
            balance.prepaid_minutes,
            coalesce((
              select sum(active_allocation.allocated_minutes)
              from public.payroll_hour_allocations active_allocation
              where active_allocation.prepaid_hour_id = balance.id
                and active_allocation.employee_id = balance.employee_id
                and active_allocation.allocation_type = 'settlement'
                and not exists (
                  select 1
                  from public.payroll_hour_allocations reversal
                  where reversal.reverses_allocation_id = active_allocation.id
                )
            ), 0)
          )::integer,
          last_settled_at = statement_timestamp()
      where balance.id = v_commitment.prepaid_hour_id;
    end if;
  end loop;
  return new;
end;
$function$;
drop trigger if exists payroll_attendance_snapshot_reconcile_expected_commitment
  on public.payroll_attendance_snapshots;
create trigger payroll_attendance_snapshot_reconcile_expected_commitment
after insert on public.payroll_attendance_snapshots
for each row execute function public.payroll_reconcile_expected_commitment();
-- Generated payroll items for no-schedule planning sources. The existing
-- calculator remains authoritative for totals; this helper only adds the
-- economic line for a positive remaining planning balance.
create or replace function public.payroll_insert_expected_commitment_earnings(
  p_payroll_record_id uuid,
  p_actor uuid,
  p_money_scale integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  delete from public.payroll_items
  where payroll_record_id = p_payroll_record_id
    and not is_manual
    and metadata ->> 'display_only_target_reference' = 'true'
    and metadata ? 'commitment_id';

  insert into public.payroll_items (
    payroll_record_id, item_type, item_code, description, quantity,
    unit_rate, amount, rate_id, work_date, calculation_version,
    metadata, is_manual, created_by, created_at
  )
  select
    record.id, 'earning', 'regular_earnings',
    'Committed Hours included in payroll',
    greatest(prepaid.remaining_minutes, 0)::numeric / 60,
    rate.hourly_rate,
    round(greatest(prepaid.remaining_minutes, 0)::numeric / 60 * rate.hourly_rate, p_money_scale),
    rate.id, commitment.work_date, record.calculation_version,
    jsonb_build_object(
      'commitment_id', commitment.id,
      'prepaid_hour_id', prepaid.id,
      'expected_minutes', commitment.expected_minutes,
      'payroll_ready_minutes_at_creation', commitment.payroll_ready_minutes_at_creation,
      'coverage_minutes', commitment.coverage_minutes,
      'remaining_minutes', prepaid.remaining_minutes,
      'prepaid_day_type', commitment.prepaid_day_type,
      'display_only_target_reference', true
    ), false, p_actor, statement_timestamp()
  from public.payroll_records record
  join public.payroll_prepaid_commitments commitment
    on commitment.payroll_record_id = record.id and commitment.employee_id = record.employee_id
   and commitment.superseded_at is null
  join public.payroll_prepaid_hours prepaid
    on prepaid.commitment_id = commitment.id and prepaid.voided_at is null
   and prepaid.remaining_minutes > 0
  join lateral (
    select r.* from public.agent_rates r
    where r.employee_id = record.employee_id and r.effective_date <= commitment.work_date
    order by r.effective_date desc limit 1
  ) rate on true
  where (p_payroll_record_id is null or record.id = p_payroll_record_id)
    and record.status <> 'void';
end;
$function$;
-- The active calculator deletes generated items before rebuilding them. Add
-- planning-source earnings at the same point as legacy pre-plot earnings so
-- record totals continue to be calculated by the existing total reducer.
do $patch$
declare
  v_definition text;
  v_marker text := '  return v_result;';
begin
  select pg_catalog.pg_get_functiondef(
    'public.payroll_calculate_draft_for_record(uuid,uuid)'::regprocedure
  ) into v_definition;
  if position(v_marker in v_definition) = 0 then
    raise exception 'Expected payroll calculator insertion marker was not found.';
  end if;
  v_definition := replace(v_definition, v_marker,
    '  perform public.payroll_insert_expected_commitment_earnings(p_payroll_record_id, public.workforce_current_profile_id(), coalesce((select (rounding_rules ->> ''money_scale'')::integer from public.payroll_periods where id = p_payroll_period_id), 2));' || chr(10) ||
    '  with totals as (' || chr(10) ||
    '    select record.id, coalesce(sum(item.amount) filter (where item.item_type = ''earning''), 0)::numeric(14,2) as gross_pay, coalesce(sum(item.amount) filter (where item.item_type = ''deduction''), 0)::numeric(14,2) as total_deductions, coalesce(sum(item.amount) filter (where item.item_code in (''rest_day_work'', ''rest_day_excess'')), 0)::numeric(14,2) as rest_day_pay' || chr(10) ||
    '    from public.payroll_records record left join public.payroll_items item on item.payroll_record_id = record.id' || chr(10) ||
    '    where record.payroll_period_id = p_payroll_period_id and record.status <> ''void'' group by record.id' || chr(10) ||
    '  ) update public.payroll_records record set gross_pay = totals.gross_pay, total_deductions = totals.total_deductions, net_pay = totals.gross_pay - totals.total_deductions, rest_day_pay = totals.rest_day_pay from totals where record.id = totals.id;' || chr(10) ||
    '  select v_result || jsonb_build_object(''gross_pay'', coalesce(sum(record.gross_pay), 0)::numeric(14,2), ''net_pay'', coalesce(sum(record.net_pay), 0)::numeric(14,2), ''total_deductions'', coalesce(sum(record.total_deductions), 0)::numeric(14,2), ''item_count'', coalesce((select count(*) from public.payroll_items item where item.payroll_record_id = p_payroll_record_id), 0)) into v_result from public.payroll_records record where record.payroll_period_id = p_payroll_period_id and (p_payroll_record_id is null or record.id = p_payroll_record_id) and record.status <> ''void'';' || chr(10) || chr(10) || v_marker);
  execute v_definition;
end;
$patch$;
-- Preserve planning targets in the immutable finalization evidence without
-- changing the legacy prepaid balance projection.
do $patch$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.payroll_collect_finalization_evidence(uuid)'::regprocedure
  ) into v_definition;
  v_old := $old$
    'prepaid_minute_balances', balance.value,
$old$;
  v_new := $new$
    'prepaid_minute_balances', balance.value,
    'expected_committed_targets', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'commitment_id', commitment.id,
        'employee_id', commitment.employee_id,
        'work_date', commitment.work_date,
        'expected_minutes', commitment.expected_minutes,
        'payroll_ready_minutes_at_creation', commitment.payroll_ready_minutes_at_creation,
        'coverage_minutes', commitment.coverage_minutes,
        'replacement_coverage_minutes', commitment.replacement_coverage_minutes,
        'prepaid_day_type', commitment.prepaid_day_type,
        'commitment_version', commitment.commitment_version,
        'superseded_at', commitment.superseded_at
      ) order by commitment.employee_id, commitment.work_date, commitment.commitment_version), '[]'::jsonb)
      from public.payroll_prepaid_commitments commitment
      where commitment.payroll_period_id = p_payroll_period_id
    ),
$new$;
  if position(v_old in v_definition) = 0 then
    raise exception 'Expected finalization evidence marker was not found; Committed Hours finalization integration cannot be installed safely.';
  end if;
  execute replace(v_definition, v_old, v_new);
end;
$patch$;
-- The approved baseline exposes the exception read model through the stable
-- complete-base wrapper. Planning-source balances have no schedule snapshot,
-- so filter only the legacy missing-source issue for balances linked to a
-- committed target. All other legacy exception behavior remains delegated to
-- the baseline function.
create or replace function public.payroll_get_period_exceptions(
  p_payroll_period_id uuid
)
returns table (
  exception_key text,
  exception_code text,
  exception_label text,
  severity text,
  is_blocking boolean,
  employee_user_id uuid,
  employee_name text,
  employee_number text,
  work_date date,
  attendance_id uuid,
  schedule_id uuid,
  payroll_record_id uuid,
  message text,
  details jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null
     or public.workforce_current_profile_id() is null
     or not public.workforce_current_user_is_active()
     or not (
       public.workforce_has_permission('create_payroll')
       or public.workforce_has_permission('review_payroll')
       or public.workforce_has_permission('finalize_payroll')
       or public.workforce_has_permission('reopen_payroll')
     ) then
    raise exception using errcode = '42501', message = 'You do not have permission to review payroll exceptions.';
  end if;

  return query
  select issue.*
  from public.payroll_get_period_exceptions_complete_base(p_payroll_period_id) as issue
  where (
      issue.exception_code <> 'schedule_changed_after_preplot_approval'
      or (issue.details ->> 'approved_schedule_version')::bigint is distinct from
         (issue.details ->> 'current_schedule_version')::bigint
    )
    and not (
      issue.exception_code = 'prepaid_balance_missing_source'
      and exists (
        select 1
        from public.payroll_prepaid_hours balance
        where balance.id = (issue.details ->> 'prepaid_hour_id')::uuid
          and balance.commitment_id is not null
      )
    );
end;
$$;
-- Extend the existing exception read model without changing its public API.
-- Planning-source balances have no schedule snapshot by design, so they must
-- be validated through the commitment/evidence record rather than reported as
-- missing-source errors. Legacy schedule-backed balances retain every prior
-- exception rule.
do $patch$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.payroll_get_period_exceptions(uuid)'::regprocedure
  ) into v_definition;

  v_old := $old$
      prepaid.source_schedule_snapshot_id,
      prepaid.employee_id,
$old$;
  v_new := $new$
      prepaid.source_schedule_snapshot_id,
      prepaid.commitment_id,
      prepaid.employee_id,
$new$;
  if position(v_old in v_definition) = 0 then
    -- The stable wrapper above is the complete integration for the approved
    -- baseline. The legacy textual rewrite is intentionally not applicable.
    return;
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $old$
      snapshot.work_date,
      snapshot.schedule_id,
      snapshot.shift_start,
      snapshot.shift_end,
      snapshot.timezone,
      snapshot.scheduled_minutes,
      snapshot.schedule_status,
      snapshot.is_rest_day,
      snapshot.is_holiday,
      snapshot.schedule_version as snapshot_schedule_version,
      snapshot.approved_by,
      snapshot.approval_reason,
      snapshot.source_type,
      snapshot.source_reference,
      snapshot.source_metadata,
$old$;
  v_new := $new$
      coalesce(snapshot.work_date, commitment.work_date),
      snapshot.schedule_id,
      snapshot.shift_start,
      snapshot.shift_end,
      snapshot.timezone,
      snapshot.scheduled_minutes,
      snapshot.schedule_status,
      coalesce(snapshot.is_rest_day, commitment.prepaid_day_type = 'rest_day'),
      coalesce(snapshot.is_holiday, false),
      snapshot.schedule_version as snapshot_schedule_version,
      coalesce(snapshot.approved_by, commitment.created_by),
      coalesce(snapshot.approval_reason, commitment.reason),
      coalesce(snapshot.source_type, 'expected_commitment'),
      coalesce(snapshot.source_reference, commitment.id::text),
      coalesce(snapshot.source_metadata, jsonb_build_object(
        'commitment_id', commitment.id,
        'expected_minutes', commitment.expected_minutes,
        'approval_evidence', commitment.approval_evidence
      )),
$new$;
  if position(v_old in v_definition) = 0 then
    raise exception 'Expected payroll exception snapshot marker was not found; Committed Hours exception integration cannot be installed safely.';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $old$
    left join public.work_schedules as schedule
      on schedule.id = snapshot.schedule_id
  $old$;
  v_new := $new$
    left join public.work_schedules as schedule
      on schedule.id = snapshot.schedule_id
    left join public.payroll_prepaid_commitments as commitment
      on commitment.id = prepaid.commitment_id
     and commitment.employee_id = prepaid.employee_id
  $new$;
  if position(v_old in v_definition) = 0 then
    raise exception 'Expected payroll exception join marker was not found; Committed Hours exception integration cannot be installed safely.';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $old$
    where prepaid.source_schedule_snapshot_id is null
       or prepaid.schedule_id is null
$old$;
  v_new := $new$
    where prepaid.commitment_id is null
      and (prepaid.source_schedule_snapshot_id is null
       or prepaid.schedule_id is null)
$new$;
  if position(v_old in v_definition) = 0 then
    raise exception 'Expected payroll exception filter marker was not found; Committed Hours exception integration cannot be installed safely.';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $old$
      and not exists (
        select 1
        from public.payroll_schedule_snapshots as snapshot
        where snapshot.payroll_record_id = record.payroll_record_id
          and snapshot.employee_id = record.employee_id
          and snapshot.schedule_id = schedule.id
          and snapshot.schedule_version = schedule.schedule_version
      )
$old$;
  v_new := $new$
      and not exists (
        select 1
        from public.payroll_schedule_snapshots as snapshot
        where snapshot.payroll_record_id = record.payroll_record_id
          and snapshot.employee_id = record.employee_id
          and snapshot.schedule_id = schedule.id
          and snapshot.schedule_version = schedule.schedule_version
      )
      and not exists (
        select 1
        from public.payroll_prepaid_commitments commitment
        where commitment.payroll_period_id = v_period.id
          and commitment.payroll_record_id = record.payroll_record_id
          and commitment.employee_id = record.employee_id
          and commitment.work_date = schedule.shift_date
          and commitment.superseded_at is null
      )
$new$;
  if position(v_old in v_definition) = 0 then
    raise exception 'Expected payroll exception missing-attendance marker was not found; Committed Hours exception integration cannot be installed safely.';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  execute v_definition;
end;
$patch$;
revoke all on function public.payroll_expected_commitment_day_type(uuid, date),
  public.payroll_get_expected_prepaid_commitment_candidates(uuid),
  public.payroll_save_expected_prepaid_commitment(uuid, uuid, date, integer, text),
  public.payroll_capture_expected_commitment_evidence(uuid, uuid, date, text),
  public.payroll_reconcile_expected_commitment(),
  public.payroll_insert_expected_commitment_earnings(uuid, uuid, integer)
  from public, anon;
grant execute on function public.payroll_expected_commitment_day_type(uuid, date),
  public.payroll_get_expected_prepaid_commitment_candidates(uuid),
  public.payroll_save_expected_prepaid_commitment(uuid, uuid, date, integer, text)
  to authenticated, service_role;
grant execute on function public.payroll_capture_expected_commitment_evidence(uuid, uuid, date, text),
  public.payroll_reconcile_expected_commitment(),
  public.payroll_insert_expected_commitment_earnings(uuid, uuid, integer)
  to service_role;
commit;
