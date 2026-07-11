-- Phase 1 Step 14 deployment and data verification.

do $$
begin
  if to_regprocedure('public.workforce_review_leave_request(uuid,text,text)') is null then
    raise exception 'Leave review RPC is missing.';
  end if;

  if has_function_privilege('anon', 'public.workforce_review_leave_request(uuid,text,text)', 'EXECUTE') then
    raise exception 'Anonymous users can execute the leave review RPC.';
  end if;

  if not has_function_privilege('authenticated', 'public.workforce_review_leave_request(uuid,text,text)', 'EXECUTE') then
    raise exception 'Authenticated users cannot execute the leave review RPC.';
  end if;

  if has_table_privilege('authenticated', 'public.leave_requests', 'UPDATE')
     or has_table_privilege('authenticated', 'public.leave_requests', 'DELETE') then
    raise exception 'Authenticated users can bypass the leave workflow with direct table changes.';
  end if;

  if exists (
    select 1
    from public.attendance attendance_row
    join public.work_schedules schedule on schedule.id = attendance_row.schedule_id
    where attendance_row.attendance_status = 'on_leave'
      and (attendance_row.clock_in is not null or attendance_row.clock_out is not null)
  ) then
    raise exception 'An on-leave attendance record contains clock activity.';
  end if;

  if exists (
    select 1
    from public.attendance attendance_row
    join public.work_schedules schedule on schedule.id = attendance_row.schedule_id
    join public.leave_requests request
      on request.user_id = attendance_row.user_id
     and schedule.shift_date between request.start_date and request.end_date
    where request.status = 'approved'
      and schedule.status in ('published', 'changed')
      and not schedule.is_rest_day
      and not schedule.is_holiday
      and attendance_row.attendance_status <> 'on_leave'
      and attendance_row.clock_in is null
      and attendance_row.clock_out is null
  ) then
    raise exception 'Approved leave has an eligible attendance row that is not marked on leave.';
  end if;
end;
$$;

select
  request.id,
  request.user_id,
  request.start_date,
  request.end_date,
  count(attendance_row.id) filter (where attendance_row.attendance_status = 'on_leave') as on_leave_records
from public.leave_requests request
left join public.attendance attendance_row
  on attendance_row.user_id = request.user_id
 and attendance_row.work_date between request.start_date and request.end_date
where request.status = 'approved'
group by request.id, request.user_id, request.start_date, request.end_date
order by request.start_date desc;
