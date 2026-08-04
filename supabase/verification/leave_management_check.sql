-- Leave request approval, security, and schedule-link verification.

do $$
begin
  if to_regprocedure('public.workforce_submit_leave_request(text,date,date,text)') is null then
    raise exception 'Leave submission RPC is missing.';
  end if;

  if to_regprocedure('public.workforce_review_leave_request(uuid,text,text)') is null then
    raise exception 'Leave review RPC is missing.';
  end if;

  if has_function_privilege('anon', 'public.workforce_submit_leave_request(text,date,date,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.workforce_review_leave_request(uuid,text,text)', 'EXECUTE') then
    raise exception 'Anonymous users can execute a leave workflow RPC.';
  end if;

  if not has_function_privilege('authenticated', 'public.workforce_submit_leave_request(text,date,date,text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.workforce_review_leave_request(uuid,text,text)', 'EXECUTE') then
    raise exception 'Authenticated users cannot execute the leave workflow RPCs.';
  end if;

  if has_table_privilege('authenticated', 'public.leave_requests', 'INSERT')
     or has_table_privilege('authenticated', 'public.leave_requests', 'UPDATE')
     or has_table_privilege('authenticated', 'public.leave_requests', 'DELETE') then
    raise exception 'Authenticated users can bypass the leave workflow with direct table changes.';
  end if;

  if exists (
    select 1
    from public.leave_requests request
    where request.status = 'rejected'
      and nullif(trim(request.review_notes), '') is null
  ) then
    raise exception 'A denied leave request is missing its administrator reason.';
  end if;

  if exists (
    select 1
    from public.work_schedules schedule
    where schedule.leave_request_id is not null
      and (
        not schedule.is_leave
        or schedule.is_absent
        or schedule.shift_start is not null
        or schedule.shift_end is not null
      )
  ) then
    raise exception 'A request-linked leave schedule has invalid working-shift values.';
  end if;

  if exists (
    select 1
    from public.leave_requests request
    where request.status = 'approved'
      and exists (
        select 1
        from generate_series(request.start_date, request.end_date, interval '1 day') requested_date
        where not exists (
          select 1
          from public.work_schedules schedule
          where schedule.user_id = request.user_id
            and schedule.shift_date = requested_date::date
            and schedule.leave_request_id = request.id
            and schedule.is_leave
        )
      )
  ) then
    raise exception 'Approved leave is missing a linked leave schedule for one or more dates.';
  end if;
end;
$$;

select
  request.id,
  request.user_id,
  request.start_date,
  request.end_date,
  request.status,
  count(schedule.id) filter (
    where schedule.leave_request_id = request.id and schedule.is_leave
  ) as linked_leave_schedules
from public.leave_requests request
left join public.work_schedules schedule
  on schedule.leave_request_id = request.id
group by request.id, request.user_id, request.start_date, request.end_date, request.status
order by request.created_at desc;
