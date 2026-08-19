-- Phase 2 Step 8 correction: the monotonic schedule version is the
-- authoritative change detector. Imported snapshots intentionally preserve
-- approved source values that may differ from current display fields.

begin;

alter function public.payroll_get_period_exceptions(uuid)
  rename to payroll_get_period_exceptions_complete_base;

revoke all on function public.payroll_get_period_exceptions_complete_base(uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_get_period_exceptions_complete_base(uuid)
  to service_role;

create function public.payroll_get_period_exceptions(
  p_payroll_period_id uuid
)
returns table (
  exception_key text,
  exception_code text,
  exception_label text,
  severity text,
  is_blocking boolean,
  employee_user_id uuid,
  employee_name text,
  employee_number text,
  work_date date,
  attendance_id uuid,
  schedule_id uuid,
  payroll_record_id uuid,
  message text,
  details jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null
     or public.workforce_current_profile_id() is null
     or not public.workforce_current_user_is_active()
     or not (
       public.workforce_has_permission('create_payroll')
       or public.workforce_has_permission('review_payroll')
       or public.workforce_has_permission('finalize_payroll')
       or public.workforce_has_permission('reopen_payroll')
     ) then
    raise exception
      using
        errcode = '42501',
        message = 'You do not have permission to review payroll exceptions.';
  end if;

  return query
  select issue.*
  from public.payroll_get_period_exceptions_complete_base(
    p_payroll_period_id
  ) as issue
  where issue.exception_code <> 'schedule_changed_after_preplot_approval'
     or (
       issue.details ->> 'approved_schedule_version'
     )::bigint is distinct from (
       issue.details ->> 'current_schedule_version'
     )::bigint;
end;
$$;

revoke all on function public.payroll_get_period_exceptions(uuid)
  from public, anon;
grant execute on function public.payroll_get_period_exceptions(uuid)
  to authenticated, service_role;

comment on function public.payroll_get_period_exceptions(uuid) is
  'Returns permission-scoped payroll exceptions. Schedule changes are determined by the monotonic source version; rate and salary values are excluded.';

commit;
