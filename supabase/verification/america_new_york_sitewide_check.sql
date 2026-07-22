-- Run after 20260714113700_standardize_america_new_york_timezone.sql.

-- Must return zero rows: no timezone-bearing record may use another zone.
select source, value, row_count
from (
  select 'profiles.timezone' source, timezone value, count(*) row_count
  from public.profiles group by timezone
  union all
  select 'work_schedules.timezone', timezone, count(*)
  from public.work_schedules group by timezone
  union all
  select 'work_schedule_templates.timezone', timezone, count(*)
  from public.work_schedule_templates group by timezone
  union all
  select 'daily_operations_metrics.report_timezone', report_timezone, count(*)
  from public.daily_operations_metrics group by report_timezone
  union all
  select 'google_calendar_connections.calendar_timezone', calendar_timezone, count(*)
  from public.google_calendar_connections group by calendar_timezone
  union all
  select 'sheet_sync_metadata.source_time_zone', source_time_zone, count(*)
  from public.sheet_sync_metadata group by source_time_zone
) timezone_records
where value is distinct from 'America/New_York';

-- Must return zero rows: active public functions may not retain the old fallback.
select procedure.proname, pg_get_function_identity_arguments(procedure.oid)
from pg_proc procedure
join pg_namespace namespace on namespace.oid = procedure.pronamespace
where namespace.nspname = 'public'
  and procedure.prokind = 'f'
  and pg_get_functiondef(procedure.oid) like '%Asia/Manila%';

-- Shows all enforced defaults and constraints for review.
select table_name, column_name, column_default
from information_schema.columns
where table_schema = 'public'
  and column_name in ('timezone', 'report_timezone', 'calendar_timezone', 'source_time_zone')
order by table_name, column_name;

select conrelid::regclass table_name, conname constraint_name
from pg_constraint
where connamespace = 'public'::regnamespace
  and conname like '%timezone_new_york_check'
order by conrelid::regclass::text;
