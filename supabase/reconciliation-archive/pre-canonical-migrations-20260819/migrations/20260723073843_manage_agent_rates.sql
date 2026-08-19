-- Effective-dated payroll rates are append-only. Browser clients can create a
-- rate only through the audited RPC below; existing rows cannot be changed.

create or replace function public.payroll_prevent_agent_rate_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception
    using
      errcode = '55000',
      message = 'Agent rate history is immutable. Add a new effective-dated rate instead.';
end;
$$;

drop trigger if exists agent_rates_prevent_mutation on public.agent_rates;
create trigger agent_rates_prevent_mutation
before update or delete on public.agent_rates
for each row execute function public.payroll_prevent_agent_rate_mutation();

revoke all on function public.payroll_prevent_agent_rate_mutation() from public;
revoke execute on function public.payroll_prevent_agent_rate_mutation() from anon, authenticated;

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
    'PHP',
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
      'source', 'agent_rates_page'
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

revoke all on function public.payroll_create_agent_rate(
  uuid, date, text, numeric, numeric, numeric, numeric, numeric
) from public;
revoke execute on function public.payroll_create_agent_rate(
  uuid, date, text, numeric, numeric, numeric, numeric, numeric
) from anon;
grant execute on function public.payroll_create_agent_rate(
  uuid, date, text, numeric, numeric, numeric, numeric, numeric
) to authenticated, service_role;

comment on function public.payroll_create_agent_rate(
  uuid, date, text, numeric, numeric, numeric, numeric, numeric
) is
  'Creates one audited, effective-dated PHP rate after explicit manage_agent_rates authorization.';
comment on function public.payroll_prevent_agent_rate_mutation() is
  'Rejects every UPDATE or DELETE so agent rate history remains append-only.';

create or replace function public.payroll_get_agent_rate_directory()
returns table (
  employee_user_id uuid,
  employee_name text,
  employee_number text,
  employee_email text,
  employment_status text,
  rate_id uuid,
  effective_date date,
  currency_code text,
  hourly_rate numeric,
  daily_rate numeric,
  monthly_rate numeric,
  overtime_rate numeric,
  holiday_rate numeric,
  rate_change_reason text,
  created_by uuid,
  created_at timestamptz
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null
     or public.workforce_current_profile_id() is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_has_permission('manage_agent_rates') then
    raise exception
      using
        errcode = '42501',
        message = 'You do not have permission to view agent rates.';
  end if;

  return query
  select
    profile.user_id,
    coalesce(nullif(trim(profile.full_name), ''), profile.email),
    profile.employee_id,
    profile.email,
    profile.employment_status::text,
    rate.id,
    rate.effective_date,
    rate.currency_code,
    rate.hourly_rate,
    rate.daily_rate,
    rate.monthly_rate,
    rate.overtime_rate,
    rate.holiday_rate,
    rate.rate_change_reason,
    rate.created_by,
    rate.created_at
  from public.profiles as profile
  left join public.agent_rates as rate
    on rate.employee_id = profile.user_id
  where profile.is_agent is true
    and profile.employment_status::text in ('active', 'on_leave')
  order by
    coalesce(nullif(trim(profile.full_name), ''), profile.email),
    rate.effective_date desc nulls last,
    rate.created_at desc nulls last;
end;
$$;

revoke all on function public.payroll_get_agent_rate_directory() from public;
revoke execute on function public.payroll_get_agent_rate_directory() from anon;
grant execute on function public.payroll_get_agent_rate_directory()
  to authenticated, service_role;

comment on function public.payroll_get_agent_rate_directory() is
  'Returns eligible employees and append-only rate history after explicit manage_agent_rates authorization.';
