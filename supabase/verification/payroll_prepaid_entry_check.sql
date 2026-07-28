with function_status as (
  select
    routine.oid,
    routine.prosecdef,
    routine.proconfig,
    pg_catalog.pg_get_functiondef(routine.oid) as definition,
    pg_catalog.has_function_privilege(
      'authenticated',
      routine.oid,
      'EXECUTE'
    ) as authenticated_can_execute,
    pg_catalog.has_function_privilege(
      'anon',
      routine.oid,
      'EXECUTE'
    ) as anon_can_execute,
    pg_catalog.has_function_privilege(
      'public',
      routine.oid,
      'EXECUTE'
    ) as public_can_execute
  from pg_catalog.pg_proc as routine
  join pg_catalog.pg_namespace as namespace
    on namespace.oid = routine.pronamespace
  where namespace.nspname = 'public'
    and routine.proname = 'payroll_save_and_approve_prepaid_schedule'
)
select jsonb_build_object(
  'payroll_prepaid_entry_ready',
  count(*) = 1
  and bool_and(prosecdef)
  and bool_and(proconfig @> array['search_path=""'])
  and bool_and(authenticated_can_execute)
  and not bool_or(anon_can_execute)
  and not bool_or(public_can_execute)
  and bool_and(definition like '%workforce_has_permission(''create_payroll'')%')
  and bool_and(definition like '%workforce_can_manage_user(%')
  and bool_and(definition like '%insert into public.payroll_schedule_snapshots%')
  and not bool_or(definition ~* 'insert[[:space:]]+into[[:space:]]+public\.attendance'),
  'function_count', count(*),
  'security_definer', coalesce(bool_and(prosecdef), false),
  'authenticated_execute', coalesce(bool_and(authenticated_can_execute), false),
  'anon_execute', coalesce(bool_or(anon_can_execute), false),
  'public_execute', coalesce(bool_or(public_can_execute), false),
  'writes_attendance', coalesce(
    bool_or(definition ~* 'insert[[:space:]]+into[[:space:]]+public\.attendance'),
    false
  )
) as result
from function_status;
