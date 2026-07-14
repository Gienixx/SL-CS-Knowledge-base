-- Run after deployment. Every boolean must be true.
with function_definition as (
  select pg_get_functiondef(
    'public.workforce_recalculate_attendance(uuid)'::regprocedure
  ) as source
)
select
  source ~* 'if\s+v_attendance\.clock_out\s+is\s+null\s+and\s+exists'
    as open_session_guard_is_scoped_to_open_target,
  position('Only one attendance session may remain open at a time.' in source) > 0
    as one_open_session_rule_retained,
  not has_function_privilege(
    'authenticated',
    'public.workforce_recalculate_attendance(uuid)',
    'execute'
  ) as browser_cannot_execute_recalculator,
  not has_function_privilege(
    'anon',
    'public.workforce_recalculate_attendance(uuid)',
    'execute'
  ) as anon_cannot_execute_recalculator
from function_definition;

-- Production regression fixture: Jean's July 13 row is closed while the July
-- 14 row is open. This query is read-only and must return true for both flags.
with jean as (
  select profile.user_id
  from public.profiles profile
  where profile.full_name ilike '%Jean%Vestil%'
  order by profile.created_at
  limit 1
)
select
  exists (
    select 1 from public.attendance attendance_row
    where attendance_row.user_id = jean.user_id
      and attendance_row.work_date = '2026-07-13'
      and attendance_row.clock_out is not null
  ) as historical_row_is_closed,
  exists (
    select 1 from public.attendance attendance_row
    where attendance_row.user_id = jean.user_id
      and attendance_row.work_date = '2026-07-14'
      and attendance_row.clock_out is null
  ) as separate_current_row_is_open
from jean;
