-- Hourly rate is the canonical input for new agent rates.
-- Daily = hourly * 8 paid hours.
-- Monthly = hourly * 8 paid hours * 22 working days.

begin;

do $$
begin
  if exists (
    select 1
    from public.agent_rates
    where hourly_rate is null
       or daily_rate is distinct from round(hourly_rate * 8, 4)
       or monthly_rate is distinct from round(hourly_rate * 176, 4)
  ) then
    raise exception
      'Existing agent rates do not match the hourly-derived daily and monthly rules. Resolve them through a controlled rate migration first.';
  end if;
end;
$$;

create or replace function public.payroll_derive_agent_rates_from_hourly()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.hourly_rate is null then
    raise exception
      using
        errcode = '22023',
        message = 'Hourly rate is required to calculate daily and monthly rates.';
  end if;

  new.daily_rate := round(new.hourly_rate * 8, 4);
  new.monthly_rate := round(new.hourly_rate * 176, 4);

  return new;
end;
$$;

drop trigger if exists agent_rates_derive_from_hourly
  on public.agent_rates;

create trigger agent_rates_derive_from_hourly
before insert on public.agent_rates
for each row
execute function public.payroll_derive_agent_rates_from_hourly();

alter table public.agent_rates
  add constraint agent_rates_hourly_derivation_check
  check (
    hourly_rate is not null
    and daily_rate = round(hourly_rate * 8, 4)
    and monthly_rate = round(hourly_rate * 176, 4)
  );

comment on function public.payroll_derive_agent_rates_from_hourly() is
  'Derives immutable daily and monthly rates from hourly using 8 hours/day and 22 days/month.';
comment on constraint agent_rates_hourly_derivation_check
  on public.agent_rates is
  'Requires daily = hourly * 8 and monthly = hourly * 176 for every stored rate.';

revoke all on function public.payroll_derive_agent_rates_from_hourly()
  from public, anon, authenticated;

commit;
