-- Phase 1 Step 15 deployment verification.
-- Scope requested for the first payroll-readiness audit: July 1-15, 2026.

select
  count(*) as total_records,
  count(*) filter (where is_payroll_ready) as payroll_ready_records,
  count(*) filter (where not is_payroll_ready) as blocked_records
from public.workforce_attendance_payroll_readiness
where work_date between date '2026-07-01' and date '2026-07-15';

select
  user_id,
  work_date,
  payroll_readiness_blockers
from public.workforce_attendance_payroll_readiness
where work_date between date '2026-07-01' and date '2026-07-15'
  and not is_payroll_ready
order by work_date, user_id;

select
  coalesce(bool_and(
    is_payroll_ready = (cardinality(payroll_readiness_blockers) = 0)
  ), true) as readiness_matches_blockers
from public.workforce_attendance_payroll_readiness;

select
  c.reloptions @> array['security_invoker=true']::text[]
    and not has_table_privilege('anon', c.oid, 'select')
    and has_table_privilege('authenticated', c.oid, 'select')
    and not has_table_privilege('authenticated', c.oid, 'insert')
    and not has_table_privilege('authenticated', c.oid, 'update')
    and not has_table_privilege('authenticated', c.oid, 'delete')
    as readiness_view_acl_is_safe
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'workforce_attendance_payroll_readiness';
