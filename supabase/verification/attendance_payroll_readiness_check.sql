-- Phase 1 Step 15: payroll-readiness migration and live-schema verification.

do $$
begin
  if to_regclass('public.workforce_attendance_payroll_readiness') is null then
    raise exception 'Payroll-readiness view is missing.';
  end if;

  if not exists (
    select 1
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'workforce_attendance_payroll_readiness'
      and 'security_invoker=true' = any(coalesce(relation.reloptions, array[]::text[]))
  ) then
    raise exception 'Payroll-readiness view must preserve attendance RLS with security_invoker=true.';
  end if;

  if has_table_privilege('anon', 'public.workforce_attendance_payroll_readiness', 'SELECT') then
    raise exception 'Anonymous users can read the payroll-readiness view.';
  end if;

  if not has_table_privilege('authenticated', 'public.workforce_attendance_payroll_readiness', 'SELECT') then
    raise exception 'Authenticated users cannot read their RLS-visible payroll-readiness records.';
  end if;

  if exists (
    select 1
    from public.workforce_attendance_payroll_readiness
    where is_payroll_ready
      and (
        clock_in is null
        or clock_out is null
        or clock_out < clock_in
        or schedule_id is null
        or pre_shift_overtime_minutes is null
        or regular_minutes is null
        or post_shift_overtime_minutes is null
        or total_overtime_minutes < 0
        or total_overtime_minutes > 1200
        or total_worked_minutes < 0
        or attendance_status not in ('present', 'absent', 'on_leave', 'excused')
        or review_status not in ('approved', 'locked')
      )
  ) then
    raise exception 'A payroll-ready record violates the readiness contract.';
  end if;
end;
$$;

-- Aggregate overtime is a per-employee, per-work-date requirement.
-- Must return zero rows.
select user_id, work_date, sum(total_overtime_minutes) as total_overtime_minutes
from public.workforce_attendance_payroll_readiness
where is_payroll_ready
group by user_id, work_date
having sum(total_overtime_minutes) > 1200;
