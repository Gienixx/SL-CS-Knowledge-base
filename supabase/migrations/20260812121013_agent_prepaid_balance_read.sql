-- Read-only, employee-scoped prepaid balances for the Attendance page.
-- The authenticated workforce identity determines the employee; no employee
-- identifier is accepted from the browser.

begin;

create or replace function public.workforce_list_my_prepaid_balances()
returns table (
  work_date date,
  prepaid_clock_in timestamptz,
  prepaid_clock_out timestamptz,
  timezone text,
  prepaid_minutes integer,
  settled_minutes integer,
  remaining_minutes integer,
  prepaid_status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_employee_id uuid := public.workforce_current_profile_id();
begin
  if auth.uid() is null
     or v_employee_id is null
     or not public.workforce_current_user_is_active() then
    raise exception
      using errcode = '42501',
        message = 'Authentication and an active workforce profile are required.';
  end if;

  return query
  select
    snapshot.work_date,
    snapshot.shift_start,
    snapshot.shift_end,
    snapshot.timezone,
    prepaid.prepaid_minutes,
    prepaid.settled_minutes,
    prepaid.remaining_minutes,
    prepaid.status
  from public.payroll_prepaid_hours as prepaid
  join public.payroll_schedule_snapshots as snapshot
    on snapshot.id = prepaid.source_schedule_snapshot_id
   and snapshot.employee_id = prepaid.employee_id
  where prepaid.employee_id = v_employee_id
    and prepaid.voided_at is null
    and prepaid.remaining_minutes > 0
  order by snapshot.work_date, snapshot.shift_start, prepaid.created_at;
end;
$$;

revoke all on function public.workforce_list_my_prepaid_balances()
  from public, anon, authenticated;
grant execute on function public.workforce_list_my_prepaid_balances()
  to authenticated, service_role;

comment on function public.workforce_list_my_prepaid_balances() is
  'Returns only the authenticated employee''s open or partially settled prepaid balances for operational self-service.';

commit;
