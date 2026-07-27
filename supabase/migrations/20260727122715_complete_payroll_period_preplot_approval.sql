-- Revised Phase 2 Step 5: support controlled early payment and explicit,
-- immutable approval of future ordinary schedules used as payroll pre-plots.

begin;

alter table public.payroll_periods
  drop constraint payroll_periods_payment_date_check;

alter table public.payroll_periods
  add column early_payment_window_days integer not null default 3,
  add column early_payment_days integer generated always as (
    period_end - payment_date
  ) stored,
  add column early_payment_override_reason text,
  add column early_payment_override_by uuid
    references public.profiles(user_id) on delete restrict,
  add column early_payment_override_at timestamptz;

alter table public.payroll_periods
  add constraint payroll_periods_payment_date_check
    check (payment_date <= period_end),
  add constraint payroll_periods_early_payment_window_check
    check (early_payment_window_days between 0 and 31),
  add constraint payroll_periods_early_payment_days_check
    check (early_payment_days >= 0),
  add constraint payroll_periods_early_payment_override_check
    check (
      (
        early_payment_days <= early_payment_window_days
        and early_payment_override_reason is null
        and early_payment_override_by is null
        and early_payment_override_at is null
      )
      or (
        early_payment_days > early_payment_window_days
        and early_payment_override_reason is not null
        and length(trim(early_payment_override_reason)) > 0
        and early_payment_override_by is not null
        and early_payment_override_at is not null
      )
    );

create index payroll_periods_early_payment_override_by_idx
  on public.payroll_periods (early_payment_override_by)
  where early_payment_override_by is not null;

comment on column public.payroll_periods.early_payment_window_days is
  'Standard early-payment window captured on the period; currently three calendar days.';
comment on column public.payroll_periods.early_payment_days is
  'Generated calendar-day difference between payroll cutoff and payment date.';
comment on column public.payroll_periods.early_payment_override_reason is
  'Required documented reason when payment is earlier than the standard window.';

drop function public.payroll_create_period(date, date, date);

create function public.payroll_create_period(
  p_period_start date,
  p_period_end date,
  p_payment_date date,
  p_early_payment_override_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := public.workforce_current_profile_id();
  v_period public.payroll_periods%rowtype;
  v_employee_count integer := 0;
  v_overlap public.payroll_periods%rowtype;
  v_early_payment_days integer;
  v_override_reason text := nullif(trim(p_early_payment_override_reason), '');
begin
  if auth.uid() is null
     or v_actor_user_id is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_has_permission('create_payroll') then
    raise exception
      using
        errcode = '42501',
        message = 'You do not have permission to create payroll periods.';
  end if;

  if p_period_start is null or p_period_end is null or p_payment_date is null then
    raise exception
      using
        errcode = '22023',
        message = 'Payroll start, end, and payment dates are required.';
  end if;

  if p_period_end < p_period_start then
    raise exception
      using errcode = '22023', message = 'Payroll end date cannot be before the start date.';
  end if;

  if p_payment_date > p_period_end then
    raise exception
      using
        errcode = '22023',
        message = 'Payment date cannot be after the payroll cutoff date.';
  end if;

  v_early_payment_days := p_period_end - p_payment_date;

  if v_early_payment_days > 3 and v_override_reason is null then
    raise exception
      using
        errcode = '22023',
        message = 'Payment more than 3 days before cutoff requires a documented override reason.';
  end if;

  if v_early_payment_days <= 3 then
    v_override_reason := null;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('public.payroll_periods:create', 0)
  );

  select period.*
  into v_overlap
  from public.payroll_periods as period
  where period.status <> 'void'
    and daterange(period.period_start, period.period_end, '[]')
      && daterange(p_period_start, p_period_end, '[]')
  order by period.period_start
  limit 1;

  if found then
    raise exception
      using
        errcode = '23P01',
        message = format(
          'This payroll period overlaps %s through %s.',
          to_char(v_overlap.period_start, 'YYYY-MM-DD'),
          to_char(v_overlap.period_end, 'YYYY-MM-DD')
        );
  end if;

  insert into public.payroll_periods (
    period_start,
    period_end,
    payment_date,
    status,
    currency_code,
    created_by,
    early_payment_window_days,
    early_payment_override_reason,
    early_payment_override_by,
    early_payment_override_at
  )
  values (
    p_period_start,
    p_period_end,
    p_payment_date,
    'draft',
    'USD',
    v_actor_user_id,
    3,
    v_override_reason,
    case when v_override_reason is not null then v_actor_user_id end,
    case when v_override_reason is not null then now() end
  )
  returning * into v_period;

  insert into public.payroll_records (
    payroll_period_id,
    employee_id,
    status,
    currency_code
  )
  select
    v_period.id,
    profile.user_id,
    'draft',
    'USD'
  from public.profiles as profile
  where profile.is_agent is true
    and profile.employment_status in ('active', 'on_leave')
  order by profile.full_name, profile.user_id;

  get diagnostics v_employee_count = row_count;

  insert into public.payroll_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    payroll_period_id,
    after_data,
    reason,
    metadata
  )
  values (
    v_actor_user_id,
    'payroll_period_created',
    'payroll_period',
    v_period.id,
    v_period.id,
    to_jsonb(v_period),
    coalesce(v_override_reason, 'Created draft payroll period'),
    jsonb_build_object(
      'eligible_employee_count', v_employee_count,
      'source', 'payroll_dashboard',
      'attendance_imported', false,
      'early_payment_days', v_period.early_payment_days,
      'early_payment_window_days', v_period.early_payment_window_days,
      'early_payment_override', v_override_reason is not null
    )
  );

  return jsonb_build_object(
    'period_id', v_period.id,
    'period_start', v_period.period_start,
    'period_end', v_period.period_end,
    'payment_date', v_period.payment_date,
    'early_payment_days', v_period.early_payment_days,
    'early_payment_override', v_override_reason is not null,
    'status', v_period.status,
    'currency_code', v_period.currency_code,
    'eligible_employee_count', v_employee_count
  );
exception
  when unique_violation then
    raise exception
      using
        errcode = '23505',
        message = 'A payroll period already exists for these dates.';
end;
$$;

alter function public.payroll_get_period_dashboard()
  rename to payroll_get_period_dashboard_base;
revoke all on function public.payroll_get_period_dashboard_base()
  from public, anon, authenticated;
grant execute on function public.payroll_get_period_dashboard_base()
  to service_role;

create function public.payroll_get_period_dashboard()
returns table (
  payroll_period_id uuid,
  period_start date,
  period_end date,
  payment_date date,
  period_status text,
  currency_code text,
  employee_count bigint,
  draft_record_count bigint,
  exception_record_count bigint,
  ready_record_count bigint,
  requires_recalculation_count bigint,
  created_at timestamptz,
  finalized_at timestamptz,
  early_payment_days integer,
  early_payment_window_days integer,
  has_early_payment_override boolean,
  early_payment_override_reason text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    dashboard.payroll_period_id,
    dashboard.period_start,
    dashboard.period_end,
    dashboard.payment_date,
    dashboard.period_status,
    dashboard.currency_code,
    dashboard.employee_count,
    dashboard.draft_record_count,
    dashboard.exception_record_count,
    dashboard.ready_record_count,
    dashboard.requires_recalculation_count,
    dashboard.created_at,
    dashboard.finalized_at,
    period.early_payment_days,
    period.early_payment_window_days,
    period.early_payment_override_reason is not null,
    period.early_payment_override_reason
  from public.payroll_get_period_dashboard_base() as dashboard
  join public.payroll_periods as period
    on period.id = dashboard.payroll_period_id;
$$;

alter function public.payroll_get_period_employee_readiness(uuid)
  rename to payroll_get_period_employee_readiness_base;
revoke all on function public.payroll_get_period_employee_readiness_base(uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_get_period_employee_readiness_base(uuid)
  to service_role;

create function public.payroll_get_period_employee_readiness(
  p_payroll_period_id uuid
)
returns table (
  payroll_period_id uuid,
  employee_user_id uuid,
  employee_name text,
  employee_number text,
  employee_email text,
  employment_status text,
  has_effective_rate boolean,
  missing_rate_date_count bigint,
  scheduled_shift_count bigint,
  attendance_record_count bigint,
  payroll_ready_attendance_count bigint,
  incomplete_attendance_count bigint,
  missing_attendance_count bigint,
  missing_clock_out_count bigint,
  pending_review_count bigint,
  readiness_status text
)
language sql
stable
security definer
set search_path = ''
as $$
  with readiness as materialized (
    select *
    from public.payroll_get_period_employee_readiness_base(
      p_payroll_period_id
    )
  ),
  current_preplots as materialized (
    select
      snapshot.employee_id,
      count(*)::bigint as approved_missing_count
    from public.payroll_schedule_snapshots as snapshot
    join public.payroll_records as record
      on record.id = snapshot.payroll_record_id
     and record.employee_id = snapshot.employee_id
    join public.work_schedules as schedule
      on schedule.id = snapshot.schedule_id
     and schedule.user_id = snapshot.employee_id
     and schedule.schedule_version = snapshot.schedule_version
    where record.payroll_period_id = p_payroll_period_id
      and not exists (
        select 1
        from public.attendance as attendance_row
        where attendance_row.user_id = snapshot.employee_id
          and attendance_row.schedule_id = snapshot.schedule_id
      )
    group by snapshot.employee_id
  ),
  adjusted as (
    select
      readiness.*,
      greatest(
        readiness.missing_attendance_count
          - coalesce(current_preplots.approved_missing_count, 0),
        0
      )::bigint as adjusted_missing_attendance_count
    from readiness
    left join current_preplots
      on current_preplots.employee_id = readiness.employee_user_id
  )
  select
    adjusted.payroll_period_id,
    adjusted.employee_user_id,
    adjusted.employee_name,
    adjusted.employee_number,
    adjusted.employee_email,
    adjusted.employment_status,
    adjusted.has_effective_rate,
    adjusted.missing_rate_date_count,
    adjusted.scheduled_shift_count,
    adjusted.attendance_record_count,
    adjusted.payroll_ready_attendance_count,
    adjusted.incomplete_attendance_count,
    adjusted.adjusted_missing_attendance_count,
    adjusted.missing_clock_out_count,
    adjusted.pending_review_count,
    case
      when not adjusted.has_effective_rate
        or adjusted.incomplete_attendance_count > 0
        or adjusted.adjusted_missing_attendance_count > 0
      then 'attention_required'
      else 'ready'
    end
  from adjusted
  order by adjusted.employee_name, adjusted.employee_user_id;
$$;

alter function public.payroll_get_period_missing_attendance(uuid)
  rename to payroll_get_period_missing_attendance_base;
revoke all on function public.payroll_get_period_missing_attendance_base(uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_get_period_missing_attendance_base(uuid)
  to service_role;

create function public.payroll_get_period_missing_attendance(
  p_payroll_period_id uuid
)
returns table (
  employee_user_id uuid,
  work_date date,
  schedule_id uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    missing.employee_user_id,
    missing.work_date,
    missing.schedule_id
  from public.payroll_get_period_missing_attendance_base(
    p_payroll_period_id
  ) as missing
  join public.work_schedules as schedule
    on schedule.id = missing.schedule_id
  where not exists (
    select 1
    from public.payroll_schedule_snapshots as snapshot
    join public.payroll_records as record
      on record.id = snapshot.payroll_record_id
    where record.payroll_period_id = p_payroll_period_id
      and snapshot.employee_id = missing.employee_user_id
      and snapshot.schedule_id = missing.schedule_id
      and snapshot.schedule_version = schedule.schedule_version
  );
$$;

alter function public.payroll_get_period_exceptions(uuid)
  rename to payroll_get_period_exceptions_base;
revoke all on function public.payroll_get_period_exceptions_base(uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_get_period_exceptions_base(uuid)
  to service_role;

create function public.payroll_get_period_exceptions(
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
language sql
stable
security definer
set search_path = ''
as $$
  select
    issue.exception_key,
    issue.exception_code,
    issue.exception_label,
    issue.severity,
    issue.is_blocking,
    issue.employee_user_id,
    issue.employee_name,
    issue.employee_number,
    issue.work_date,
    issue.attendance_id,
    issue.schedule_id,
    issue.payroll_record_id,
    issue.message,
    issue.details
  from public.payroll_get_period_exceptions_base(
    p_payroll_period_id
  ) as issue
  where issue.exception_code <> 'missing_attendance'
     or not exists (
       select 1
       from public.work_schedules as schedule
       join public.payroll_schedule_snapshots as snapshot
         on snapshot.schedule_id = schedule.id
        and snapshot.schedule_version = schedule.schedule_version
       where schedule.id = issue.schedule_id
         and snapshot.payroll_record_id = issue.payroll_record_id
         and snapshot.employee_id = issue.employee_user_id
     );
$$;

create function public.payroll_get_preplot_candidates(
  p_payroll_period_id uuid
)
returns table (
  payroll_record_id uuid,
  schedule_id uuid,
  employee_user_id uuid,
  employee_name text,
  employee_number text,
  employee_email text,
  work_date date,
  shift_start timestamptz,
  shift_end timestamptz,
  timezone text,
  scheduled_minutes integer,
  schedule_status text,
  is_rest_day boolean,
  is_holiday boolean,
  holiday_name text,
  special_day_type text,
  schedule_version bigint,
  schedule_updated_at timestamptz,
  can_approve boolean,
  approval_status text,
  approval_message text,
  current_snapshot_id uuid,
  approved_at timestamptz,
  approval_reason text,
  approved_by_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_period public.payroll_periods%rowtype;
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
    raise exception
      using
        errcode = '42501',
        message = 'You do not have permission to view payroll pre-plots.';
  end if;

  select period.*
  into v_period
  from public.payroll_periods as period
  where period.id = p_payroll_period_id;

  if not found then
    raise exception
      using errcode = 'P0002', message = 'Payroll period was not found.';
  end if;

  return query
  select
    record.id,
    schedule.id,
    profile.user_id,
    profile.full_name,
    profile.employee_id,
    profile.email,
    schedule.shift_date,
    schedule.shift_start,
    schedule.shift_end,
    schedule.timezone,
    case
      when schedule.shift_start is null or schedule.shift_end is null then 0
      else floor(
        extract(epoch from (schedule.shift_end - schedule.shift_start)) / 60
      )::integer
    end,
    schedule.status,
    schedule.is_rest_day,
    schedule.is_holiday,
    schedule.holiday_name,
    case
      when schedule.is_rest_day then 'rest_day'
      when schedule.is_holiday then 'holiday'
      else 'ordinary'
    end,
    schedule.schedule_version,
    schedule.updated_at,
    (
      schedule.status in ('published', 'changed')
      and not schedule.is_rest_day
      and not schedule.is_holiday
      and schedule.shift_start is not null
      and schedule.shift_end is not null
      and schedule.shift_end > schedule.shift_start
      and attendance_status.attendance_id is null
      and current_approval.snapshot_id is null
    ),
    case
      when current_approval.snapshot_id is not null then 'approved'
      when attendance_status.attendance_id is not null then 'attendance_exists'
      when schedule.is_rest_day then 'rest_day'
      when schedule.is_holiday then 'guaranteed_special_day'
      when schedule.status not in ('published', 'changed') then 'unpublished'
      when schedule.shift_start is null or schedule.shift_end is null
        then 'incomplete_shift'
      when schedule.shift_end <= schedule.shift_start then 'invalid_shift'
      when previous_approval.has_previous then 'schedule_changed'
      else 'eligible'
    end,
    case
      when current_approval.snapshot_id is not null
        then 'This exact schedule version is approved.'
      when attendance_status.attendance_id is not null
        then 'Attendance already exists; use approved attendance instead.'
      when schedule.is_rest_day
        then 'Rest days do not create prepaid-hour debt.'
      when schedule.is_holiday
        then 'Guaranteed special-day pay remains additional and is not prepaid debt.'
      when schedule.status not in ('published', 'changed')
        then 'Only published or changed schedules may be pre-plotted.'
      when schedule.shift_start is null or schedule.shift_end is null
        then 'Complete shift times are required.'
      when schedule.shift_end <= schedule.shift_start
        then 'Shift end must be after shift start.'
      when previous_approval.has_previous
        then 'The schedule changed after an earlier approval; approve this version again.'
      else 'Eligible for explicit pre-plot approval.'
    end,
    current_approval.snapshot_id,
    current_approval.approved_at,
    current_approval.approval_reason,
    current_approval.approved_by_name
  from public.payroll_records as record
  join public.profiles as profile
    on profile.user_id = record.employee_id
  join public.work_schedules as schedule
    on schedule.user_id = record.employee_id
   and schedule.shift_date > v_period.payment_date
   and schedule.shift_date <= v_period.period_end
  left join lateral (
    select attendance_row.id as attendance_id
    from public.attendance as attendance_row
    where attendance_row.user_id = record.employee_id
      and attendance_row.schedule_id = schedule.id
    order by attendance_row.created_at
    limit 1
  ) as attendance_status on true
  left join lateral (
    select
      snapshot.id as snapshot_id,
      snapshot.approved_at,
      snapshot.approval_reason,
      approver.full_name as approved_by_name
    from public.payroll_schedule_snapshots as snapshot
    join public.profiles as approver
      on approver.user_id = snapshot.approved_by
    where snapshot.payroll_record_id = record.id
      and snapshot.employee_id = record.employee_id
      and snapshot.schedule_id = schedule.id
      and snapshot.schedule_version = schedule.schedule_version
    order by snapshot.approved_at desc
    limit 1
  ) as current_approval on true
  left join lateral (
    select exists (
      select 1
      from public.payroll_schedule_snapshots as snapshot
      where snapshot.payroll_record_id = record.id
        and snapshot.employee_id = record.employee_id
        and snapshot.schedule_id = schedule.id
    ) as has_previous
  ) as previous_approval on true
  where record.payroll_period_id = v_period.id
    and record.status <> 'void'
  order by schedule.shift_date, profile.full_name, schedule.shift_start, schedule.id;
end;
$$;

create function public.payroll_approve_preplots(
  p_payroll_period_id uuid,
  p_schedule_ids uuid[],
  p_approval_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := public.workforce_current_profile_id();
  v_period public.payroll_periods%rowtype;
  v_reason text := nullif(trim(p_approval_reason), '');
  v_requested_count integer;
  v_distinct_count integer;
  v_matched_count integer;
  v_invalid record;
  v_approved_count integer := 0;
  v_already_current_count integer := 0;
  v_snapshot_ids jsonb := '[]'::jsonb;
begin
  if auth.uid() is null
     or v_actor_user_id is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_has_permission('create_payroll') then
    raise exception
      using
        errcode = '42501',
        message = 'You do not have permission to approve payroll pre-plots.';
  end if;

  if p_payroll_period_id is null then
    raise exception
      using errcode = '22023', message = 'Payroll period is required.';
  end if;

  if p_schedule_ids is null or cardinality(p_schedule_ids) = 0 then
    raise exception
      using errcode = '22023', message = 'Select at least one schedule to approve.';
  end if;

  if v_reason is null then
    raise exception
      using errcode = '22023', message = 'A pre-plot approval reason is required.';
  end if;

  v_requested_count := cardinality(p_schedule_ids);
  select count(distinct requested.schedule_id)
  into v_distinct_count
  from unnest(p_schedule_ids) as requested(schedule_id);

  if v_requested_count <> v_distinct_count then
    raise exception
      using errcode = '22023', message = 'Duplicate schedules cannot be approved.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.payroll_preplots:' || p_payroll_period_id::text,
      0
    )
  );

  select period.*
  into v_period
  from public.payroll_periods as period
  where period.id = p_payroll_period_id
  for update;

  if not found then
    raise exception
      using errcode = 'P0002', message = 'Payroll period was not found.';
  end if;

  if v_period.status not in ('draft', 'reopened') then
    raise exception
      using
        errcode = '55000',
        message = 'Pre-plots can only be approved for draft or reopened payroll periods.';
  end if;

  perform 1
  from public.work_schedules as schedule
  where schedule.id = any(p_schedule_ids)
  order by schedule.id
  for update;

  get diagnostics v_matched_count = row_count;
  if v_matched_count <> v_requested_count then
    raise exception
      using errcode = '22023', message = 'One or more selected schedules were not found.';
  end if;

  select
    schedule.id as schedule_id,
    case
      when record.id is null then 'The schedule does not belong to an employee in this payroll period.'
      when schedule.shift_date <= v_period.payment_date
        or schedule.shift_date > v_period.period_end
        then 'The schedule is outside the post-payment portion of this payroll period.'
      when schedule.status not in ('published', 'changed')
        then 'Only published or changed schedules may be pre-plotted.'
      when schedule.is_rest_day
        then 'Rest days do not create prepaid-hour debt.'
      when schedule.is_holiday
        then 'Guaranteed special days do not create prepaid-hour debt.'
      when schedule.shift_start is null or schedule.shift_end is null
        then 'Complete shift times are required.'
      when schedule.shift_end <= schedule.shift_start
        then 'Shift end must be after shift start.'
      when exists (
        select 1
        from public.attendance as attendance_row
        where attendance_row.user_id = schedule.user_id
          and attendance_row.schedule_id = schedule.id
      ) then 'Attendance already exists for the selected schedule.'
      else null
    end as validation_message
  into v_invalid
  from public.work_schedules as schedule
  left join public.payroll_records as record
    on record.payroll_period_id = v_period.id
   and record.employee_id = schedule.user_id
   and record.status <> 'void'
  where schedule.id = any(p_schedule_ids)
    and (
      record.id is null
      or schedule.shift_date <= v_period.payment_date
      or schedule.shift_date > v_period.period_end
      or schedule.status not in ('published', 'changed')
      or schedule.is_rest_day
      or schedule.is_holiday
      or schedule.shift_start is null
      or schedule.shift_end is null
      or schedule.shift_end <= schedule.shift_start
      or exists (
        select 1
        from public.attendance as attendance_row
        where attendance_row.user_id = schedule.user_id
          and attendance_row.schedule_id = schedule.id
      )
    )
  order by schedule.id
  limit 1;

  if found then
    raise exception
      using
        errcode = '22023',
        message = format(
          'Schedule %s cannot be approved: %s',
          v_invalid.schedule_id,
          v_invalid.validation_message
        );
  end if;

  select count(*)
  into v_already_current_count
  from public.work_schedules as schedule
  join public.payroll_records as record
    on record.payroll_period_id = v_period.id
   and record.employee_id = schedule.user_id
   and record.status <> 'void'
  where schedule.id = any(p_schedule_ids)
    and exists (
      select 1
      from public.payroll_schedule_snapshots as snapshot
      where snapshot.payroll_record_id = record.id
        and snapshot.employee_id = schedule.user_id
        and snapshot.schedule_id = schedule.id
        and snapshot.schedule_version = schedule.schedule_version
    );

  with inserted as (
    insert into public.payroll_schedule_snapshots (
      payroll_record_id,
      schedule_id,
      employee_id,
      work_date,
      shift_start,
      shift_end,
      timezone,
      schedule_status,
      is_rest_day,
      is_holiday,
      holiday_name,
      schedule_version,
      schedule_updated_at,
      approved_by,
      approved_at,
      approval_reason
    )
    select
      record.id,
      schedule.id,
      schedule.user_id,
      schedule.shift_date,
      schedule.shift_start,
      schedule.shift_end,
      schedule.timezone,
      schedule.status,
      schedule.is_rest_day,
      schedule.is_holiday,
      schedule.holiday_name,
      schedule.schedule_version,
      schedule.updated_at,
      v_actor_user_id,
      now(),
      v_reason
    from public.work_schedules as schedule
    join public.payroll_records as record
      on record.payroll_period_id = v_period.id
     and record.employee_id = schedule.user_id
     and record.status <> 'void'
    where schedule.id = any(p_schedule_ids)
      and not exists (
        select 1
        from public.payroll_schedule_snapshots as snapshot
        where snapshot.payroll_record_id = record.id
          and snapshot.employee_id = schedule.user_id
          and snapshot.schedule_id = schedule.id
          and snapshot.schedule_version = schedule.schedule_version
      )
    returning id
  )
  select
    count(*)::integer,
    coalesce(jsonb_agg(id order by id), '[]'::jsonb)
  into v_approved_count, v_snapshot_ids
  from inserted;

  if v_approved_count > 0 then
    insert into public.payroll_audit_logs (
      actor_user_id,
      action,
      entity_type,
      entity_id,
      payroll_period_id,
      after_data,
      reason,
      metadata
    )
    values (
      v_actor_user_id,
      'payroll_preplots_approved',
      'payroll_period',
      v_period.id,
      v_period.id,
      jsonb_build_object('schedule_snapshot_ids', v_snapshot_ids),
      v_reason,
      jsonb_build_object(
        'approved_schedule_count', v_approved_count,
        'already_current_count', v_already_current_count,
        'source', 'payroll_period'
      )
    );
  end if;

  return jsonb_build_object(
    'payroll_period_id', v_period.id,
    'approved_schedule_count', v_approved_count,
    'already_current_count', v_already_current_count,
    'schedule_snapshot_ids', v_snapshot_ids
  );
end;
$$;

revoke all on function public.payroll_create_period(date, date, date, text)
  from public, anon;
revoke all on function public.payroll_get_period_dashboard()
  from public, anon;
revoke all on function public.payroll_get_period_employee_readiness(uuid)
  from public, anon;
revoke all on function public.payroll_get_period_missing_attendance(uuid)
  from public, anon;
revoke all on function public.payroll_get_period_exceptions(uuid)
  from public, anon;
revoke all on function public.payroll_get_preplot_candidates(uuid)
  from public, anon;
revoke all on function public.payroll_approve_preplots(uuid, uuid[], text)
  from public, anon;

grant execute on function public.payroll_create_period(date, date, date, text)
  to authenticated, service_role;
grant execute on function public.payroll_get_period_dashboard()
  to authenticated, service_role;
grant execute on function public.payroll_get_period_employee_readiness(uuid)
  to authenticated, service_role;
grant execute on function public.payroll_get_period_missing_attendance(uuid)
  to authenticated, service_role;
grant execute on function public.payroll_get_period_exceptions(uuid)
  to authenticated, service_role;
grant execute on function public.payroll_get_preplot_candidates(uuid)
  to authenticated, service_role;
grant execute on function public.payroll_approve_preplots(uuid, uuid[], text)
  to authenticated, service_role;

comment on function public.payroll_create_period(date, date, date, text) is
  'Creates an audited USD payroll period, allowing up to three days early payment or requiring a documented override.';
comment on function public.payroll_get_preplot_candidates(uuid) is
  'Returns post-payment schedule candidates and exact-version approval state without exposing pay rates.';
comment on function public.payroll_approve_preplots(uuid, uuid[], text) is
  'Atomically validates and snapshots selected future ordinary schedules after explicit create_payroll approval.';

commit;
