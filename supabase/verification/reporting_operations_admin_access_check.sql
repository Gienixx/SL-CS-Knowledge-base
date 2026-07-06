-- Verify that Reporting Operations is restricted to active administrators
-- with the explicit view_workforce_reports permission.

begin;

select
  tablename,
  policyname,
  roles,
  cmd,
  qual
from pg_policies
where schemaname = 'public'
  and tablename in (
    'dashboard_audit_events',
    'dashboard_alert_events',
    'dashboard_data_quality_results',
    'sheet_sync_runs'
  )
order by tablename, policyname;

do $$
declare
  v_missing_tables text;
  v_function_source text;
begin
  select string_agg(expected.table_name, ', ' order by expected.table_name)
  into v_missing_tables
  from (
    values
      ('dashboard_audit_events'::text),
      ('dashboard_alert_events'::text),
      ('dashboard_data_quality_results'::text),
      ('sheet_sync_runs'::text)
  ) as expected(table_name)
  where not exists (
    select 1
    from pg_policies policy
    where policy.schemaname = 'public'
      and policy.tablename = expected.table_name
      and policy.cmd = 'SELECT'
      and policy.policyname like 'Reporting administrators can read%'
      and policy.qual ilike '%workforce_is_admin%'
      and policy.qual ilike '%view_workforce_reports%'
  );

  if v_missing_tables is not null then
    raise exception
      'Missing administrator-scoped Reporting Operations policy for: %',
      v_missing_tables;
  end if;

  if has_function_privilege(
    'anon',
    'public.record_dashboard_export(text, integer, date, date)',
    'EXECUTE'
  ) then
    raise exception 'anon must not execute record_dashboard_export';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.record_dashboard_export(text, integer, date, date)',
    'EXECUTE'
  ) then
    raise exception 'authenticated must retain conditional RPC execution';
  end if;

  select procedure.prosrc
  into v_function_source
  from pg_proc procedure
  join pg_namespace namespace
    on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'record_dashboard_export'
    and pg_get_function_identity_arguments(procedure.oid) =
      'p_dataset text, p_row_count integer, p_start_date date, p_end_date date';

  if v_function_source is null
    or v_function_source not ilike '%workforce_is_admin%'
    or v_function_source not ilike '%view_workforce_reports%'
    or v_function_source not ilike '%reporting_operations_admin_required%' then
    raise exception
      'record_dashboard_export is missing the Reporting Operations administrator guard';
  end if;
end;
$$;

select
  has_function_privilege(
    'anon',
    'public.record_dashboard_export(text, integer, date, date)',
    'EXECUTE'
  ) as anon_can_export,
  has_function_privilege(
    'authenticated',
    'public.record_dashboard_export(text, integer, date, date)',
    'EXECUTE'
  ) as authenticated_can_call_guarded_export;

rollback;
