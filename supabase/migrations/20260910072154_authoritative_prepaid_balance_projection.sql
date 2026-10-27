-- Make the Attendance prepaid balance read authoritative for economic
-- fulfillment.  Source settled_minutes is a cached ledger field; valid
-- settlement allocations are the source of truth for what was fulfilled.
begin;

drop function public.workforce_list_my_prepaid_balances();
create function public.workforce_list_my_prepaid_balances()
returns table (
  prepaid_hour_id uuid,
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
    raise exception using errcode = '42501',
      message = 'Authentication and an active workforce profile are required.';
  end if;

  return query
  select
    prepaid.id,
    coalesce(prepaid.effective_work_date, snapshot.work_date),
    coalesce(prepaid.effective_shift_start, snapshot.shift_start),
    coalesce(prepaid.effective_shift_end, snapshot.shift_end),
    coalesce(prepaid.effective_timezone, snapshot.timezone),
    prepaid.prepaid_minutes,
    fulfillment.fulfilled_minutes,
    greatest(prepaid.prepaid_minutes - fulfillment.fulfilled_minutes, 0)::integer,
    case
      when fulfillment.fulfilled_minutes = 0 then 'open'
      when fulfillment.fulfilled_minutes >= prepaid.prepaid_minutes then 'settled'
      else 'partially_settled'
    end
  from public.payroll_prepaid_hours as prepaid
  join public.payroll_schedule_snapshots as snapshot
    on snapshot.id = prepaid.source_schedule_snapshot_id
   and snapshot.employee_id = prepaid.employee_id
  cross join lateral (
    select coalesce(sum(allocation.allocated_minutes), 0)::integer
      as fulfilled_minutes
    from public.payroll_hour_allocations as allocation
    where allocation.prepaid_hour_id = prepaid.id
      and allocation.employee_id = prepaid.employee_id
      and allocation.allocation_type = 'settlement'
      and not exists (
        select 1
        from public.payroll_hour_allocations as reversal
        where reversal.allocation_type = 'reversal'
          and reversal.reverses_allocation_id = allocation.id
      )
  ) as fulfillment
  where prepaid.employee_id = v_employee_id
    and prepaid.voided_at is null
  order by coalesce(prepaid.effective_work_date, snapshot.work_date),
    coalesce(prepaid.effective_shift_start, snapshot.shift_start),
    prepaid.created_at;
end;
$$;

revoke all on function public.workforce_list_my_prepaid_balances()
  from public, anon, authenticated;
grant execute on function public.workforce_list_my_prepaid_balances()
  to authenticated, service_role;

comment on function public.workforce_list_my_prepaid_balances() is
  'Returns all non-void prepaid balances with fulfillment derived from valid settlement allocations; fully settled rows remain explicit with zero remaining minutes.';

commit;

;
