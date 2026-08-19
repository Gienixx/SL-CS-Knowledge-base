-- Keep payroll eligibility separate from workforce account eligibility so
-- testing-only agents can continue using attendance without entering payroll.

begin;

alter table public.profiles
  add column is_payroll_eligible boolean not null default true;

comment on column public.profiles.is_payroll_eligible is
  'Whether this active workforce profile may be loaded into payroll periods.';

create or replace function public.payroll_guard_profile_eligibility_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.is_payroll_eligible is distinct from old.is_payroll_eligible
     and coalesce(
       current_setting('payroll.eligibility_change_allowed', true),
       ''
     ) <> 'true' then
    raise exception
      using
        errcode = '55000',
        message = 'Payroll eligibility must be changed through the audited payroll function.';
  end if;

  return new;
end;
$$;

create trigger profiles_payroll_eligibility_guard
before update of is_payroll_eligible on public.profiles
for each row
execute function public.payroll_guard_profile_eligibility_change();

revoke all on function public.payroll_guard_profile_eligibility_change()
  from public, anon, authenticated;
grant execute on function public.payroll_guard_profile_eligibility_change()
  to service_role;

create or replace function public.payroll_guard_employee_eligibility()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_eligible boolean;
begin
  select profile.is_payroll_eligible
  into v_is_eligible
  from public.profiles as profile
  where profile.user_id = new.employee_id;

  if not coalesce(v_is_eligible, false) then
    raise exception
      using
        errcode = '55000',
        message = 'This employee is excluded from payroll.';
  end if;

  return new;
end;
$$;

drop trigger if exists payroll_records_employee_eligibility
  on public.payroll_records;

create trigger payroll_records_employee_eligibility
before insert or update of employee_id on public.payroll_records
for each row
execute function public.payroll_guard_employee_eligibility();

revoke all on function public.payroll_guard_employee_eligibility()
  from public, anon, authenticated;
grant execute on function public.payroll_guard_employee_eligibility()
  to service_role;

create or replace function public.payroll_set_employee_eligibility(
  p_employee_id uuid,
  p_is_eligible boolean,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := public.workforce_current_profile_id();
  v_profile public.profiles%rowtype;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_removed_record_ids uuid[] := array[]::uuid[];
begin
  if auth.uid() is null
     or v_actor_user_id is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_has_permission('create_payroll') then
    raise exception
      using
        errcode = '42501',
        message = 'You do not have permission to manage payroll eligibility.';
  end if;

  if p_employee_id is null or p_is_eligible is null then
    raise exception
      using
        errcode = '22023',
        message = 'Employee and payroll eligibility are required.';
  end if;

  if v_reason is null then
    raise exception
      using
        errcode = '22023',
        message = 'A payroll eligibility reason is required.';
  end if;

  select profile.*
  into v_profile
  from public.profiles as profile
  where profile.user_id = p_employee_id
  for update;

  if not found then
    raise exception
      using errcode = 'P0002', message = 'Employee profile was not found.';
  end if;

  if not p_is_eligible then
    if exists (
      select 1
      from public.payroll_records as record
      join public.payroll_periods as period
        on period.id = record.payroll_period_id
      where record.employee_id = p_employee_id
        and period.status in ('draft', 'reopened')
        and record.status <> 'void'
        and (
          record.status <> 'draft'
          or record.calculated_at is not null
          or record.gross_pay <> 0
          or record.net_pay <> 0
          or exists (
            select 1
            from public.payroll_items as item
            where item.payroll_record_id = record.id
          )
          or exists (
            select 1
            from public.payroll_attendance_snapshots as snapshot
            where snapshot.payroll_record_id = record.id
          )
          or exists (
            select 1
            from public.payroll_schedule_snapshots as schedule_snapshot
            where schedule_snapshot.payroll_record_id = record.id
          )
          or exists (
            select 1
            from public.payroll_prepaid_hours as prepaid
            where prepaid.source_payroll_record_id = record.id
          )
          or exists (
            select 1
            from public.payroll_hour_allocations as allocation
            where allocation.destination_payroll_record_id = record.id
          )
          or exists (
            select 1
            from public.payslips as payslip
            where payslip.payroll_record_id = record.id
          )
          or exists (
            select 1
            from public.payroll_audit_logs as audit
            where audit.payroll_record_id = record.id
          )
        )
    ) then
      raise exception
        using
          errcode = '55000',
          message = 'This employee has payroll work in progress. Resolve or void it before excluding the employee.';
    end if;

    select coalesce(array_agg(record.id order by record.created_at), array[]::uuid[])
    into v_removed_record_ids
    from public.payroll_records as record
    join public.payroll_periods as period
      on period.id = record.payroll_period_id
    where record.employee_id = p_employee_id
      and period.status in ('draft', 'reopened')
      and record.status = 'draft'
      and record.calculated_at is null
      and record.gross_pay = 0
      and record.net_pay = 0;

    delete from public.payroll_records as record
    using public.payroll_periods as period
    where period.id = record.payroll_period_id
      and record.employee_id = p_employee_id
      and period.status in ('draft', 'reopened')
      and record.status = 'draft'
      and record.calculated_at is null
      and record.gross_pay = 0
      and record.net_pay = 0;
  end if;

  perform set_config(
    'payroll.eligibility_change_allowed',
    'true',
    true
  );

  update public.profiles
  set is_payroll_eligible = p_is_eligible
  where user_id = p_employee_id;

  perform set_config(
    'payroll.eligibility_change_allowed',
    'false',
    true
  );

  insert into public.payroll_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    before_data,
    after_data,
    reason,
    metadata
  )
  values (
    v_actor_user_id,
    case
      when p_is_eligible then 'payroll_employee_included'
      else 'payroll_employee_excluded'
    end,
    'employee_profile',
    p_employee_id,
    jsonb_build_object(
      'is_payroll_eligible',
      v_profile.is_payroll_eligible
    ),
    jsonb_build_object(
      'is_payroll_eligible',
      p_is_eligible
    ),
    v_reason,
    jsonb_build_object(
      'removed_empty_draft_record_ids',
      to_jsonb(v_removed_record_ids)
    )
  );

  return jsonb_build_object(
    'employee_id', p_employee_id,
    'is_payroll_eligible', p_is_eligible,
    'removed_empty_draft_record_ids', to_jsonb(v_removed_record_ids)
  );
end;
$$;

revoke all on function public.payroll_set_employee_eligibility(
  uuid, boolean, text
) from public, anon;
grant execute on function public.payroll_set_employee_eligibility(
  uuid, boolean, text
) to authenticated, service_role;

comment on function public.payroll_set_employee_eligibility(
  uuid, boolean, text
) is
  'Audits payroll-only inclusion changes and removes only untouched draft record shells when excluding an employee.';

create or replace function public.payroll_create_period(
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
    and profile.is_payroll_eligible is true
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

revoke all on function public.payroll_create_period(
  date, date, date, text
) from public, anon;
grant execute on function public.payroll_create_period(
  date, date, date, text
) to authenticated, service_role;

comment on function public.payroll_create_period(
  date, date, date, text
) is
  'Creates an audited payroll period and loads only active payroll-eligible agents.';

commit;
