-- Keep agent Attendance Log payable classification behind attendance approval.
-- Existing FIFO allocations remain visible; this only gates inferred regular minutes.

begin;

drop function if exists public.workforce_list_my_attendance_log(date, date);

create function public.workforce_list_my_attendance_log(
  p_start_date date,
  p_end_date date
)
returns table (
  attendance_id uuid,
  schedule_id uuid,
  work_date date,
  clock_in timestamptz,
  clock_out timestamptz,
  attendance_status text,
  review_status text,
  is_late boolean,
  minutes_late integer,
  overtime_minutes integer,
  regular_minutes integer,
  pre_shift_overtime_minutes integer,
  post_shift_overtime_minutes integer,
  rest_day_overtime_minutes integer,
  holiday_overtime_minutes integer,
  total_overtime_minutes integer,
  total_worked_minutes integer,
  undertime_minutes integer,
  correction_reason text,
  corrected_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  schedule_start timestamptz,
  schedule_end timestamptz,
  schedule_timezone text,
  schedule_status text,
  schedule_is_rest_day boolean,
  schedule_is_holiday boolean,
  holiday_name text,
  is_prepaid_schedule boolean,
  prepaid_minutes integer,
  fulfilled_prepaid_minutes integer,
  regular_payable_minutes integer,
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

  if p_start_date is null or p_end_date is null then
    raise exception
      using errcode = '22004', message = 'Start date and end date are required.';
  end if;

  if p_end_date < p_start_date then
    raise exception
      using errcode = '22007', message = 'End date cannot be earlier than start date.';
  end if;

  if p_end_date - p_start_date > 366 then
    raise exception
      using errcode = '22023', message = 'Attendance date ranges cannot exceed 367 calendar days.';
  end if;

  return query
  with actual_rows as (
    select
      attendance_row.id as attendance_id,
      attendance_row.schedule_id,
      attendance_row.work_date,
      attendance_row.clock_in,
      attendance_row.clock_out,
      attendance_row.attendance_status,
      attendance_row.review_status,
      attendance_row.is_late,
      attendance_row.minutes_late,
      attendance_row.overtime_minutes,
      attendance_row.regular_minutes,
      attendance_row.pre_shift_overtime_minutes,
      attendance_row.post_shift_overtime_minutes,
      attendance_row.rest_day_overtime_minutes,
      attendance_row.holiday_overtime_minutes,
      attendance_row.total_overtime_minutes,
      attendance_row.total_worked_minutes,
      attendance_row.undertime_minutes,
      attendance_row.correction_reason,
      attendance_row.corrected_at,
      attendance_row.created_at,
      attendance_row.updated_at,
      schedule.shift_start as schedule_start,
      schedule.shift_end as schedule_end,
      schedule.timezone as schedule_timezone,
      schedule.status as schedule_status,
      coalesce(schedule.is_rest_day, false) as schedule_is_rest_day,
      coalesce(schedule.is_holiday, false) as schedule_is_holiday,
      schedule.holiday_name,
      false as is_prepaid_schedule,
      null::integer as prepaid_minutes,
      coalesce(allocations.fulfilled_minutes, 0)::integer as fulfilled_prepaid_minutes,
      case
        when attendance_row.review_status in ('approved', 'locked') then greatest(
          case
            when attendance_row.attendance_status <> 'present'
              or attendance_row.clock_out is null
              or coalesce(schedule.is_rest_day, false)
              or coalesce(schedule.is_holiday, false)
              or coalesce(attendance_row.rest_day_overtime_minutes, 0) > 0
              or coalesce(attendance_row.holiday_overtime_minutes, 0) > 0
              then 0
            else greatest(coalesce(attendance_row.regular_minutes, 0), 0)
              + greatest(coalesce(attendance_row.pre_shift_overtime_minutes, 0), 0)
              + greatest(coalesce(attendance_row.post_shift_overtime_minutes, 0), 0)
          end - coalesce(allocations.fulfilled_minutes, 0),
          0
        )::integer
        else 0
      end as regular_payable_minutes,
      null::text as prepaid_status
    from public.attendance as attendance_row
    left join public.work_schedules as schedule
      on schedule.id = attendance_row.schedule_id
     and schedule.user_id = attendance_row.user_id
    left join lateral (
      select sum(
        case
          when allocation.allocation_type = 'settlement'
            then allocation.allocated_minutes
          else -allocation.allocated_minutes
        end
      )::integer as fulfilled_minutes
      from public.payroll_attendance_snapshots as attendance_snapshot
      join public.payroll_hour_allocations as allocation
        on allocation.attendance_snapshot_id = attendance_snapshot.id
       and allocation.employee_id = attendance_snapshot.employee_id
      where attendance_snapshot.attendance_id = attendance_row.id
        and attendance_snapshot.employee_id = v_employee_id
    ) as allocations on true
    where attendance_row.user_id = v_employee_id
      and attendance_row.work_date between p_start_date and p_end_date
  ),
  prepaid_rows as (
    select
      null::uuid as attendance_id,
      snapshot.schedule_id,
      snapshot.work_date,
      null::timestamptz as clock_in,
      null::timestamptz as clock_out,
      'prepaid_scheduled'::text as attendance_status,
      null::text as review_status,
      false as is_late,
      0::integer as minutes_late,
      0::integer as overtime_minutes,
      0::integer as regular_minutes,
      0::integer as pre_shift_overtime_minutes,
      0::integer as post_shift_overtime_minutes,
      0::integer as rest_day_overtime_minutes,
      0::integer as holiday_overtime_minutes,
      0::integer as total_overtime_minutes,
      0::integer as total_worked_minutes,
      0::integer as undertime_minutes,
      null::text as correction_reason,
      null::timestamptz as corrected_at,
      prepaid.created_at,
      prepaid.updated_at,
      snapshot.shift_start as schedule_start,
      snapshot.shift_end as schedule_end,
      snapshot.timezone as schedule_timezone,
      snapshot.schedule_status,
      snapshot.is_rest_day as schedule_is_rest_day,
      snapshot.is_holiday as schedule_is_holiday,
      snapshot.holiday_name,
      true as is_prepaid_schedule,
      prepaid.prepaid_minutes,
      prepaid.settled_minutes as fulfilled_prepaid_minutes,
      0::integer as regular_payable_minutes,
      prepaid.status as prepaid_status
    from public.payroll_prepaid_hours as prepaid
    join public.payroll_schedule_snapshots as snapshot
      on snapshot.id = prepaid.source_schedule_snapshot_id
     and snapshot.employee_id = prepaid.employee_id
    where prepaid.employee_id = v_employee_id
      and prepaid.voided_at is null
      and snapshot.work_date between p_start_date and p_end_date
      and not exists (
        select 1
        from public.attendance as attendance_row
        where attendance_row.user_id = v_employee_id
          and attendance_row.schedule_id = snapshot.schedule_id
          and attendance_row.work_date = snapshot.work_date
      )
  )
  select * from actual_rows
  union all
  select * from prepaid_rows
  order by work_date desc, schedule_start desc nulls last, clock_in desc nulls last, created_at desc;
end;
$$;

revoke all on function public.workforce_list_my_attendance_log(date, date)
  from public, anon, authenticated;
grant execute on function public.workforce_list_my_attendance_log(date, date)
  to authenticated, service_role;

comment on function public.workforce_list_my_attendance_log(date, date) is
  'Returns the authenticated employee attendance and approved prepaid schedule rows; regular payable minutes require approved or locked attendance, while FIFO allocations remain source of truth.';

commit;
