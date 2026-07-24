-- Expose only the missing scheduled-attendance coordinates needed to navigate
-- from payroll readiness to Team Attendance. No pay or rate values are returned.

begin;

create or replace function public.payroll_get_period_missing_attendance(
  p_payroll_period_id uuid
)
returns table (
  employee_user_id uuid,
  work_date date,
  schedule_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_period public.payroll_periods%rowtype;
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
        message = 'You do not have permission to view payroll readiness.';
  end if;

  select period.*
  into v_period
  from public.payroll_periods as period
  where period.id = p_payroll_period_id;

  if not found then
    raise exception
      using errcode = 'P0002', message = 'Payroll period was not found.';
  end if;

  return query
  select
    record.employee_id,
    schedule.shift_date,
    schedule.id
  from public.payroll_records as record
  join public.work_schedules as schedule
    on schedule.user_id = record.employee_id
  where record.payroll_period_id = v_period.id
    and schedule.shift_date between v_period.period_start and v_period.period_end
    and schedule.status in ('published', 'changed', 'completed')
    and schedule.is_rest_day is false
    and schedule.is_holiday is false
    and not exists (
      select 1
      from public.attendance as attendance_row
      where attendance_row.user_id = record.employee_id
        and attendance_row.schedule_id = schedule.id
    )
  order by record.employee_id, schedule.shift_date, schedule.id;
end;
$$;

revoke all on function public.payroll_get_period_missing_attendance(uuid)
  from public, anon;

grant execute on function public.payroll_get_period_missing_attendance(uuid)
  to authenticated, service_role;

comment on function public.payroll_get_period_missing_attendance(uuid) is
  'Returns missing scheduled-attendance dates for an authorized payroll period without exposing pay or rate values.';

commit;
