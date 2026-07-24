-- Payroll period management verification.
-- Every blocker query in section 3 must return zero rows.

-- 1. Required functions and index.
select
  to_regprocedure('public.payroll_check_period_overlap(date,date)') is not null
    as overlap_rpc_exists,
  to_regprocedure('public.payroll_create_period(date,date,date)') is not null
    as create_rpc_exists,
  to_regprocedure('public.payroll_get_period_dashboard()') is not null
    as dashboard_rpc_exists,
  to_regprocedure('public.payroll_get_period_employee_readiness(uuid)') is not null
    as readiness_rpc_exists,
  to_regclass('public.payroll_periods_active_range_idx') is not null
    as active_range_index_exists;

-- 2. Browser permissions are RPC-only and anonymous execution is denied.
select
  has_table_privilege('authenticated', 'public.payroll_periods', 'insert')
    as authenticated_can_insert_periods_should_be_false,
  has_table_privilege('authenticated', 'public.payroll_records', 'insert')
    as authenticated_can_insert_records_should_be_false,
  has_function_privilege(
    'anon',
    'public.payroll_create_period(date,date,date)',
    'execute'
  ) as anon_can_create_period_should_be_false,
  has_function_privilege(
    'authenticated',
    'public.payroll_create_period(date,date,date)',
    'execute'
  ) as authenticated_can_call_create_rpc_should_be_true;

-- 3. Blockers: zero rows required.
select id, period_start, period_end, payment_date
from public.payroll_periods
where period_end < period_start
   or payment_date < period_end;

select
  earlier.id as earlier_period_id,
  later.id as later_period_id,
  earlier.period_start as earlier_start,
  earlier.period_end as earlier_end,
  later.period_start as later_start,
  later.period_end as later_end
from public.payroll_periods as earlier
join public.payroll_periods as later
  on earlier.id < later.id
 and earlier.status <> 'void'
 and later.status <> 'void'
 and daterange(earlier.period_start, earlier.period_end, '[]')
   && daterange(later.period_start, later.period_end, '[]');

select period.id, period.period_start, period.period_end
from public.payroll_periods as period
left join public.payroll_records as record
  on record.payroll_period_id = period.id
left join public.profiles as profile
  on profile.user_id = record.employee_id
 and profile.is_agent is true
where period.status = 'draft'
group by period.id
having count(record.id) filter (where profile.user_id is not null)
  <> (
    select count(*)
    from public.profiles
    where is_agent is true
      and employment_status in ('active', 'on_leave')
  );

-- 4. Audit evidence for created periods.
select
  period.id,
  period.period_start,
  period.period_end,
  audit.created_at as audited_at
from public.payroll_periods as period
left join public.payroll_audit_logs as audit
  on audit.payroll_period_id = period.id
 and audit.action = 'payroll_period_created'
where period.status = 'draft'
order by period.period_start desc;
