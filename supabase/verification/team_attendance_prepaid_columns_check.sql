-- Phase 2, Step 8: Team Attendance prepaid-column production checks.
-- Every blocker query must return zero rows.

-- 1. Function security and ACL blockers.
select
  procedure.oid::regprocedure as function_name,
  procedure.prosecdef as security_definer,
  procedure.proconfig as function_settings,
  has_function_privilege('public', procedure.oid, 'execute')
    as public_can_execute,
  has_function_privilege('anon', procedure.oid, 'execute')
    as anon_can_execute,
  has_function_privilege('authenticated', procedure.oid, 'execute')
    as authenticated_can_execute
from pg_proc as procedure
join pg_namespace as namespace
  on namespace.oid = procedure.pronamespace
where namespace.nspname = 'public'
  and procedure.proname = 'workforce_list_team_attendance_prepaid'
  and (
    not procedure.prosecdef
    or procedure.proconfig is distinct from array['search_path=""']
    or has_function_privilege('public', procedure.oid, 'execute')
    or has_function_privilege('anon', procedure.oid, 'execute')
    or not has_function_privilege('authenticated', procedure.oid, 'execute')
  );

-- 2. Required authorization and non-monetary output blockers.
with function_contract as (
  select
    pg_get_functiondef(procedure.oid) as definition,
    pg_get_function_result(procedure.oid) as result_type
  from pg_proc as procedure
  join pg_namespace as namespace
    on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'workforce_list_team_attendance_prepaid'
    and pg_get_function_identity_arguments(procedure.oid) =
      'p_start_date date, p_end_date date'
)
select 'invalid function contract' as blocker
from function_contract
where definition not like '%workforce_has_permission(''view_team_attendance'')%'
   or definition not like '%workforce_can_manage_user(%'
   or result_type not like '%prepaid_clock_in timestamp with time zone%'
   or result_type not like '%prepaid_clock_out timestamp with time zone%'
   or result_type not like '%prepaid_minutes integer%'
   or result_type not like '%actual_eligible_minutes integer%'
   or result_type not like '%applied_prepaid_minutes integer%'
   or result_type not like '%remaining_prepaid_minutes integer%'
   or result_type not like '%prepaid_status text%'
   or result_type ~* '(hourly_rate|daily_rate|monthly_rate|gross_pay|net_pay|salary)';

-- 3. Ledger values must remain within their source balances.
select
  prepaid.id,
  prepaid.prepaid_minutes,
  prepaid.settled_minutes,
  prepaid.remaining_minutes,
  prepaid.status
from public.payroll_prepaid_hours as prepaid
where prepaid.prepaid_minutes <= 0
   or prepaid.settled_minutes < 0
   or prepaid.remaining_minutes < 0
   or prepaid.settled_minutes + prepaid.remaining_minutes <>
      prepaid.prepaid_minutes
   or prepaid.status not in (
     'open',
     'partially_settled',
     'settled',
     'void'
   );

-- 4. Summary; review only after every blocker query above returns zero rows.
select
  'team_attendance_prepaid_columns_ready' as status,
  count(*) as prepaid_balance_count,
  coalesce(sum(prepaid.prepaid_minutes), 0) as total_prepaid_minutes,
  coalesce(sum(prepaid.settled_minutes), 0) as total_settled_minutes,
  coalesce(sum(prepaid.remaining_minutes), 0) as total_remaining_minutes
from public.payroll_prepaid_hours as prepaid;
