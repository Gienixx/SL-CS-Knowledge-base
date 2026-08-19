-- USD is the canonical payroll and rate currency. PHP is display-only and is
-- calculated from a live PayPal quote; converted values are not stored as rates.

begin;

do $$
begin
  if exists (
    select 1 from public.agent_rates where currency_code <> 'USD'
  ) or exists (
    select 1 from public.payroll_periods where currency_code <> 'USD'
  ) or exists (
    select 1 from public.payroll_records where currency_code <> 'USD'
  ) then
    raise exception
      'Cannot change canonical payroll currency while non-USD payroll data exists. Convert it through a controlled payroll migration first.';
  end if;
end;
$$;

alter table public.agent_rates
  alter column currency_code set default 'USD';
alter table public.payroll_periods
  alter column currency_code set default 'USD';
alter table public.payroll_records
  alter column currency_code set default 'USD';

alter table public.agent_rates
  drop constraint agent_rates_currency_code_check,
  add constraint agent_rates_currency_code_check
    check (currency_code = 'USD');

alter table public.payroll_periods
  drop constraint payroll_periods_currency_code_check,
  add constraint payroll_periods_currency_code_check
    check (currency_code = 'USD');

alter table public.payroll_records
  drop constraint payroll_records_currency_code_check,
  add constraint payroll_records_currency_code_check
    check (currency_code = 'USD');

create or replace function public.payroll_create_agent_rate(
  p_employee_id uuid,
  p_effective_date date,
  p_rate_change_reason text,
  p_hourly_rate numeric default null,
  p_daily_rate numeric default null,
  p_monthly_rate numeric default null,
  p_overtime_rate numeric default null,
  p_holiday_rate numeric default null
)
returns public.agent_rates
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_user_id uuid := public.workforce_current_profile_id();
  v_employee_is_eligible boolean := false;
  v_reason text := trim(coalesce(p_rate_change_reason, ''));
  v_rate public.agent_rates%rowtype;
begin
  if auth.uid() is null
     or v_actor_user_id is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_has_permission('manage_agent_rates') then
    raise exception
      using
        errcode = '42501',
        message = 'You do not have permission to manage agent rates.';
  end if;

  select (
    profile.is_agent is true
    and profile.employment_status::text in ('active', 'on_leave')
  )
  into v_employee_is_eligible
  from public.profiles as profile
  where profile.user_id = p_employee_id;

  if not coalesce(v_employee_is_eligible, false) then
    raise exception
      using
        errcode = '22023',
        message = 'Rates can only be added for active or on-leave agents.';
  end if;

  if p_effective_date is null then
    raise exception
      using errcode = '22023', message = 'Effective date is required.';
  end if;

  if num_nonnulls(p_hourly_rate, p_daily_rate, p_monthly_rate) = 0 then
    raise exception
      using
        errcode = '22023',
        message = 'Enter at least one base rate: hourly, daily, or monthly.';
  end if;

  if coalesce(p_hourly_rate, 0) < 0
     or coalesce(p_daily_rate, 0) < 0
     or coalesce(p_monthly_rate, 0) < 0
     or coalesce(p_overtime_rate, 0) < 0
     or coalesce(p_holiday_rate, 0) < 0 then
    raise exception
      using errcode = '22023', message = 'Rates cannot be negative.';
  end if;

  if length(v_reason) = 0 then
    raise exception
      using errcode = '22023', message = 'Rate-change reason is required.';
  end if;

  if length(v_reason) > 500 then
    raise exception
      using
        errcode = '22023',
        message = 'Rate-change reason must be 500 characters or fewer.';
  end if;

  insert into public.agent_rates (
    employee_id,
    currency_code,
    hourly_rate,
    daily_rate,
    monthly_rate,
    overtime_rate,
    holiday_rate,
    effective_date,
    rate_change_reason,
    created_by
  )
  values (
    p_employee_id,
    'USD',
    p_hourly_rate,
    p_daily_rate,
    p_monthly_rate,
    p_overtime_rate,
    p_holiday_rate,
    p_effective_date,
    v_reason,
    v_actor_user_id
  )
  returning * into v_rate;

  insert into public.payroll_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    after_data,
    reason,
    metadata
  )
  values (
    v_actor_user_id,
    'agent_rate_created',
    'agent_rate',
    v_rate.id,
    to_jsonb(v_rate),
    v_reason,
    jsonb_build_object(
      'employee_id', p_employee_id,
      'effective_date', p_effective_date,
      'source', 'agent_rates_page',
      'canonical_currency', 'USD'
    )
  );

  return v_rate;
exception
  when unique_violation then
    raise exception
      using
        errcode = '23505',
        message = 'A rate already exists for this employee and effective date.';
end;
$$;

comment on function public.payroll_create_agent_rate(
  uuid, date, text, numeric, numeric, numeric, numeric, numeric
) is
  'Creates one audited, effective-dated USD rate after explicit manage_agent_rates authorization.';
comment on column public.agent_rates.currency_code is
  'Canonical stored rate currency. USD is required for all new rate records.';
comment on column public.payroll_periods.currency_code is
  'Canonical payroll-period currency. USD is the production default.';
comment on column public.payroll_records.currency_code is
  'Canonical calculated payroll currency. USD is the production default.';

commit;
