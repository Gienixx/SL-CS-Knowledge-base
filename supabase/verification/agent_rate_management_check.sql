-- Agent-rate management acceptance checks. Every row should report true/zero.

select
  to_regprocedure(
    'public.payroll_create_agent_rate(uuid,date,text,numeric,numeric,numeric,numeric,numeric)'
  ) is not null as create_rate_rpc_exists,
  to_regprocedure(
    'public.payroll_prevent_agent_rate_mutation()'
  ) is not null as immutability_function_exists,
  to_regprocedure(
    'public.payroll_get_agent_rate_directory()'
  ) is not null as rate_directory_rpc_exists;

select
  has_function_privilege(
    'authenticated',
    'public.payroll_create_agent_rate(uuid,date,text,numeric,numeric,numeric,numeric,numeric)',
    'EXECUTE'
  ) as authenticated_can_execute_create_rate,
  not has_function_privilege(
    'anon',
    'public.payroll_create_agent_rate(uuid,date,text,numeric,numeric,numeric,numeric,numeric)',
    'EXECUTE'
  ) as anon_cannot_execute_create_rate,
  has_function_privilege(
    'authenticated',
    'public.payroll_get_agent_rate_directory()',
    'EXECUTE'
  ) as authenticated_can_execute_rate_directory,
  not has_function_privilege(
    'anon',
    'public.payroll_get_agent_rate_directory()',
    'EXECUTE'
  ) as anon_cannot_execute_rate_directory;

select
  not has_table_privilege('authenticated', 'public.agent_rates', 'INSERT')
    as authenticated_cannot_insert_directly,
  not has_table_privilege('authenticated', 'public.agent_rates', 'UPDATE')
    as authenticated_cannot_update_directly,
  not has_table_privilege('authenticated', 'public.agent_rates', 'DELETE')
    as authenticated_cannot_delete_directly;

select count(*) = 1 as exactly_one_immutability_trigger
from pg_trigger
where tgrelid = 'public.agent_rates'::regclass
  and tgname = 'agent_rates_prevent_mutation'
  and not tgisinternal;

select count(*) = 1 as exactly_one_rate_read_policy
from pg_policies
where schemaname = 'public'
  and tablename = 'agent_rates'
  and cmd = 'SELECT'
  and roles @> array['authenticated']::name[]
  and coalesce(qual, '') like '%manage_agent_rates%';

select count(*)::int as existing_rate_rows
from public.agent_rates;
