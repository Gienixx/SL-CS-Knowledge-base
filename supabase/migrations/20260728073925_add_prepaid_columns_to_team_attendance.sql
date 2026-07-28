-- Phase 2, Step 8: expose calculated prepaid-hour reconciliation values to
-- authorized Team Attendance users without exposing payroll rates or amounts.

begin;

create or replace function public.workforce_list_team_attendance_prepaid(
  p_start_date date,
  p_end_date date
)
returns table (
  attendance_id uuid,
  prepaid_clock_in timestamptz,
  prepaid_clock_out timestamptz,
  prepaid_minutes integer,
  actual_eligible_minutes integer,
  applied_prepaid_minutes integer,
  remaining_prepaid_minutes integer,
  prepaid_status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null
     or public.workforce_current_profile_id() is null
     or not public.workforce_current_user_is_active() then
    raise exception
      using
        errcode = '42501',
        message = 'Authentication and an active workforce profile are required.';
  end if;

  if not public.workforce_has_permission('view_team_attendance') then
    raise exception
      using
        errcode = '42501',
        message = 'You do not have permission to view team attendance.';
  end if;

  if p_start_date is null or p_end_date is null then
    raise exception
      using
        errcode = '22004',
        message = 'Start date and end date are required.';
  end if;

  if p_end_date < p_start_date then
    raise exception
      using
        errcode = '22007',
        message = 'End date cannot be earlier than start date.';
  end if;

  if p_end_date - p_start_date > 366 then
    raise exception
      using
        errcode = '22023',
        message = 'Team attendance date ranges cannot exceed 367 calendar days.';
  end if;

  return query
  select
    attendance_row.id,
    source_prepaid.shift_start,
    source_prepaid.shift_end,
    source_prepaid.prepaid_minutes,
    case
      when attendance_row.attendance_status <> 'present'
        or attendance_row.clock_out is null
        or coalesce(schedule.is_rest_day, false)
        or coalesce(schedule.is_holiday, false)
        or coalesce(attendance_row.rest_day_overtime_minutes, 0) > 0
        or coalesce(attendance_row.holiday_overtime_minutes, 0) > 0
        then 0
      else
        greatest(coalesce(attendance_row.regular_minutes, 0), 0)
        + greatest(
            coalesce(attendance_row.pre_shift_overtime_minutes, 0),
            0
          )
        + greatest(
            coalesce(attendance_row.post_shift_overtime_minutes, 0),
            0
          )
    end::integer,
    coalesce(applied_prepaid.applied_minutes, 0)::integer,
    source_prepaid.remaining_minutes,
    source_prepaid.status
  from public.attendance as attendance_row
  left join public.work_schedules as schedule
    on schedule.id = attendance_row.schedule_id
   and schedule.user_id = attendance_row.user_id
  left join lateral (
    select
      snapshot.shift_start,
      snapshot.shift_end,
      prepaid.prepaid_minutes,
      prepaid.remaining_minutes,
      prepaid.status
    from public.payroll_schedule_snapshots as snapshot
    join public.payroll_prepaid_hours as prepaid
      on prepaid.source_schedule_snapshot_id = snapshot.id
     and prepaid.employee_id = snapshot.employee_id
    where snapshot.employee_id = attendance_row.user_id
      and snapshot.schedule_id = attendance_row.schedule_id
      and snapshot.work_date = attendance_row.work_date
    order by
      snapshot.approved_at desc,
      prepaid.created_at desc,
      prepaid.id desc
    limit 1
  ) as source_prepaid on true
  left join lateral (
    select
      sum(
        case
          when allocation.allocation_type = 'settlement'
            then allocation.allocated_minutes
          else -allocation.allocated_minutes
        end
      )::integer as applied_minutes
    from public.payroll_attendance_snapshots as attendance_snapshot
    join public.payroll_hour_allocations as allocation
      on allocation.attendance_snapshot_id = attendance_snapshot.id
     and allocation.employee_id = attendance_snapshot.employee_id
    where attendance_snapshot.attendance_id = attendance_row.id
      and attendance_snapshot.employee_id = attendance_row.user_id
  ) as applied_prepaid on true
  where attendance_row.work_date between p_start_date and p_end_date
    and public.workforce_can_manage_user(
      attendance_row.user_id,
      'view_team_attendance'
    )
  order by
    attendance_row.work_date desc,
    attendance_row.clock_in desc nulls last,
    attendance_row.created_at desc;
end;
$$;

revoke all on function public.workforce_list_team_attendance_prepaid(date, date)
  from public, anon, authenticated;
grant execute on function public.workforce_list_team_attendance_prepaid(date, date)
  to authenticated, service_role;

comment on function public.workforce_list_team_attendance_prepaid(date, date) is
  'Returns non-monetary prepaid schedule, eligible-minute, allocation, remaining-balance, and settlement-status values for permission-scoped Team Attendance rows.';

commit;
