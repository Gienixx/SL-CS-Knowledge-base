-- Payroll period setup and readiness diagnostics.
-- Draft creation is atomic: overlapping active periods are rejected and every
-- currently eligible agent is loaded into one payroll record.

begin;

create index if not exists payroll_periods_active_range_idx
  on public.payroll_periods
  using gist (daterange(period_start, period_end, '[]'))
  where status <> 'void';

create or replace function public.payroll_check_period_overlap(
  p_period_start date,
  p_period_end date
)
returns table (
  payroll_period_id uuid,
  period_start date,
  period_end date,
  payment_date date,
  period_status text
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
     or not public.workforce_has_permission('create_payroll') then
    raise exception
      using
        errcode = '42501',
        message = 'You do not have permission to create payroll periods.';
  end if;

  if p_period_start is null or p_period_end is null then
    raise exception
      using errcode = '22023', message = 'Payroll start and end dates are required.';
  end if;

  if p_period_end < p_period_start then
    raise exception
      using errcode = '22023', message = 'Payroll end date cannot be before the start date.';
  end if;

  return query
  select
    period.id,
    period.period_start,
    period.period_end,
    period.payment_date,
    period.status
  from public.payroll_periods as period
  where period.status <> 'void'
    and daterange(period.period_start, period.period_end, '[]')
      && daterange(p_period_start, p_period_end, '[]')
  order by period.period_start, period.period_end;
end;
$$;

create or replace function public.payroll_create_period(
  p_period_start date,
  p_period_end date,
  p_payment_date date
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

  if p_payment_date < p_period_end then
    raise exception
      using
        errcode = '22023',
        message = 'Payment date cannot be before the payroll end date.';
  end if;

  -- All browser creation flows use this RPC. The transaction-scoped lock keeps
  -- concurrent overlap checks and inserts serialized without holding a
  -- long-running table lock.
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
    created_by
  )
  values (
    p_period_start,
    p_period_end,
    p_payment_date,
    'draft',
    'USD',
    v_actor_user_id
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
    'Created draft payroll period',
    jsonb_build_object(
      'eligible_employee_count', v_employee_count,
      'source', 'payroll_dashboard',
      'attendance_imported', false
    )
  );

  return jsonb_build_object(
    'period_id', v_period.id,
    'period_start', v_period.period_start,
    'period_end', v_period.period_end,
    'payment_date', v_period.payment_date,
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

create or replace function public.payroll_get_period_dashboard()
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
  finalized_at timestamptz
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
    raise exception
      using
        errcode = '42501',
        message = 'You do not have permission to access payroll period management.';
  end if;

  return query
  select
    period.id,
    period.period_start,
    period.period_end,
    period.payment_date,
    period.status,
    period.currency_code,
    count(record.id),
    count(record.id) filter (where record.status = 'draft'),
    count(record.id) filter (where record.status = 'exception'),
    count(record.id) filter (
      where record.status in ('ready_for_review', 'approved', 'finalized')
    ),
    count(record.id) filter (where record.requires_recalculation),
    period.created_at,
    period.finalized_at
  from public.payroll_periods as period
  left join public.payroll_records as record
    on record.payroll_period_id = period.id
  group by period.id
  order by period.period_start desc, period.created_at desc;
end;
$$;

create or replace function public.payroll_get_period_employee_readiness(
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
        message = 'You do not have permission to view payroll readiness.';
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
  with readiness as (
    select
      record.payroll_period_id,
      profile.user_id as employee_user_id,
      profile.full_name as employee_name,
      profile.employee_id as employee_number,
      profile.email as employee_email,
      profile.employment_status,
      coalesce(rate_status.has_period_end_rate, false)
        and coalesce(attendance_stats.missing_rate_date_count, 0) = 0
        as has_effective_rate,
      case
        when coalesce(attendance_stats.attendance_record_count, 0) = 0
          and not coalesce(rate_status.has_period_end_rate, false)
        then 1::bigint
        else coalesce(attendance_stats.missing_rate_date_count, 0)
      end as missing_rate_date_count,
      coalesce(schedule_stats.scheduled_shift_count, 0)
        as scheduled_shift_count,
      coalesce(attendance_stats.attendance_record_count, 0)
        as attendance_record_count,
      coalesce(attendance_stats.payroll_ready_attendance_count, 0)
        as payroll_ready_attendance_count,
      coalesce(attendance_stats.incomplete_attendance_count, 0)
        as incomplete_attendance_count,
      coalesce(schedule_stats.missing_attendance_count, 0)
        as missing_attendance_count,
      coalesce(attendance_stats.missing_clock_out_count, 0)
        as missing_clock_out_count,
      coalesce(attendance_stats.pending_review_count, 0)
        as pending_review_count
    from public.payroll_records as record
    join public.profiles as profile
      on profile.user_id = record.employee_id
    left join lateral (
      select exists (
        select 1
        from public.agent_rates as rate
        where rate.employee_id = profile.user_id
          and rate.effective_date <= v_period.period_end
      ) as has_period_end_rate
    ) as rate_status on true
    left join lateral (
      select
        count(*)::bigint as scheduled_shift_count,
        count(*) filter (
          where not exists (
            select 1
            from public.attendance as attendance_row
            where attendance_row.user_id = profile.user_id
              and attendance_row.schedule_id = schedule.id
          )
        ) as missing_attendance_count
      from public.work_schedules as schedule
      where schedule.user_id = profile.user_id
        and schedule.shift_date between v_period.period_start and v_period.period_end
        and schedule.status in ('published', 'changed', 'completed')
        and schedule.is_rest_day is false
        and schedule.is_holiday is false
    ) as schedule_stats on true
    left join lateral (
      select
        count(*)::bigint as attendance_record_count,
        count(*) filter (
          where attendance_row.is_payroll_ready
        ) as payroll_ready_attendance_count,
        count(*) filter (
          where not attendance_row.is_payroll_ready
        ) as incomplete_attendance_count,
        count(*) filter (
          where 'missing_clock_out' = any(attendance_row.payroll_readiness_blockers)
        ) as missing_clock_out_count,
        count(*) filter (
          where 'review_required' = any(attendance_row.payroll_readiness_blockers)
        ) as pending_review_count,
        count(distinct attendance_row.work_date) filter (
          where not exists (
            select 1
            from public.agent_rates as rate
            where rate.employee_id = profile.user_id
              and rate.effective_date <= attendance_row.work_date
          )
        ) as missing_rate_date_count
      from public.workforce_attendance_payroll_readiness as attendance_row
      where attendance_row.user_id = profile.user_id
        and attendance_row.work_date
          between v_period.period_start and v_period.period_end
    ) as attendance_stats on true
    where record.payroll_period_id = v_period.id
  )
  select
    readiness.payroll_period_id,
    readiness.employee_user_id,
    readiness.employee_name,
    readiness.employee_number,
    readiness.employee_email,
    readiness.employment_status,
    readiness.has_effective_rate,
    readiness.missing_rate_date_count,
    readiness.scheduled_shift_count,
    readiness.attendance_record_count,
    readiness.payroll_ready_attendance_count,
    readiness.incomplete_attendance_count,
    readiness.missing_attendance_count,
    readiness.missing_clock_out_count,
    readiness.pending_review_count,
    case
      when not readiness.has_effective_rate
        or readiness.incomplete_attendance_count > 0
        or readiness.missing_attendance_count > 0
      then 'attention_required'
      else 'ready'
    end
  from readiness
  order by readiness.employee_name, readiness.employee_user_id;
end;
$$;

revoke all on function public.payroll_check_period_overlap(date, date)
  from public, anon;
revoke all on function public.payroll_create_period(date, date, date)
  from public, anon;
revoke all on function public.payroll_get_period_dashboard()
  from public, anon;
revoke all on function public.payroll_get_period_employee_readiness(uuid)
  from public, anon;

grant execute on function public.payroll_check_period_overlap(date, date)
  to authenticated, service_role;
grant execute on function public.payroll_create_period(date, date, date)
  to authenticated, service_role;
grant execute on function public.payroll_get_period_dashboard()
  to authenticated, service_role;
grant execute on function public.payroll_get_period_employee_readiness(uuid)
  to authenticated, service_role;

comment on function public.payroll_check_period_overlap(date, date) is
  'Returns active payroll periods that overlap a proposed date range after create_payroll authorization.';
comment on function public.payroll_create_period(date, date, date) is
  'Atomically creates one non-overlapping draft USD payroll period, loads eligible agents, and writes an audit log.';
comment on function public.payroll_get_period_dashboard() is
  'Returns payroll-period lifecycle and record counts to explicitly authorized payroll processors.';
comment on function public.payroll_get_period_employee_readiness(uuid) is
  'Returns rate and attendance readiness diagnostics without exposing rate amounts.';

commit;
