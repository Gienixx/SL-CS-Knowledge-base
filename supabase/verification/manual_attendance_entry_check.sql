-- Run after 20260714070649_manual_attendance_entry.sql.

select
  to_regprocedure(
    'public.workforce_create_manual_attendance(uuid,date,timestamp with time zone,timestamp with time zone,uuid,text,text,text)'
  ) is not null as manual_attendance_function_exists,
  procedure.prosecdef as uses_security_definer,
  procedure.proconfig @> array['search_path=""']::text[] as has_empty_search_path,
  has_function_privilege(
    'authenticated',
    'public.workforce_create_manual_attendance(uuid,date,timestamp with time zone,timestamp with time zone,uuid,text,text,text)',
    'execute'
  ) as authenticated_can_execute,
  not has_function_privilege(
    'anon',
    'public.workforce_create_manual_attendance(uuid,date,timestamp with time zone,timestamp with time zone,uuid,text,text,text)',
    'execute'
  ) as anon_cannot_execute
from pg_proc procedure
where procedure.oid =
  'public.workforce_create_manual_attendance(uuid,date,timestamp with time zone,timestamp with time zone,uuid,text,text,text)'::regprocedure;

-- Every returned value must be true. Then manually verify:
-- 1. An admin with manage_schedules can create a complete record.
-- 2. A supervisor, agent, or admin without manage_schedules is rejected.
-- 3. An incorrect employee/schedule/date combination is rejected.
-- 4. The new attendance totals and manual_attendance_created audit event exist.
