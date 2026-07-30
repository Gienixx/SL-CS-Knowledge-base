select
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'is_payroll_eligible'
  ) as eligibility_column_exists,
  to_regprocedure(
    'public.payroll_set_employee_eligibility(uuid,boolean,text)'
  ) is not null as eligibility_rpc_exists,
  to_regprocedure(
    'public.payroll_guard_employee_eligibility()'
  ) is not null as record_guard_exists,
  exists (
    select 1
    from pg_trigger
    where tgname = 'profiles_payroll_eligibility_guard'
      and not tgisinternal
  ) as profile_guard_trigger_exists,
  exists (
    select 1
    from pg_trigger
    where tgname = 'payroll_records_employee_eligibility'
      and not tgisinternal
  ) as record_guard_trigger_exists;

select
  p.full_name,
  p.email,
  p.is_payroll_eligible,
  count(pr.id) filter (
    where pp.status in ('draft', 'reopened')
      and pr.status <> 'void'
  ) as open_payroll_record_count
from public.profiles as p
left join public.payroll_records as pr
  on pr.employee_id = p.user_id
left join public.payroll_periods as pp
  on pp.id = pr.payroll_period_id
where lower(p.email) = 'trashlangto@gmail.com'
group by p.user_id, p.full_name, p.email, p.is_payroll_eligible;
