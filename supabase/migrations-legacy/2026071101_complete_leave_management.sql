-- Complete Phase 1 leave management by synchronizing approved leave with attendance.

begin;

create or replace function public.workforce_review_leave_request(
  p_request_id uuid,
  p_status text,
  p_review_notes text default null
)
returns public.leave_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_user_id uuid := auth.uid();
  v_request public.leave_requests%rowtype;
  v_result public.leave_requests%rowtype;
  v_conflicting_attendance_count integer := 0;
  v_attendance_count integer := 0;
begin
  if v_actor_user_id is null then
    raise exception 'Authenticated session is required.';
  end if;

  if p_status not in ('approved', 'rejected') then
    raise exception 'Review status must be approved or rejected.';
  end if;

  select *
  into v_request
  from public.leave_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception 'Leave request not found.';
  end if;

  if not public.workforce_can_manage_user(v_request.user_id, 'approve_leave') then
    raise exception 'You do not have permission to review this leave request.';
  end if;

  if v_request.status <> 'pending' then
    raise exception 'Only pending leave requests can be reviewed.';
  end if;

  if p_status = 'approved' then
    -- Never replace actual clock activity with leave. The reviewer must resolve the
    -- attendance conflict before the leave request can be approved.
    select count(*)
    into v_conflicting_attendance_count
    from public.attendance attendance_row
    where attendance_row.user_id = v_request.user_id
      and attendance_row.work_date between v_request.start_date and v_request.end_date
      and (
        attendance_row.clock_in is not null
        or attendance_row.clock_out is not null
        or attendance_row.total_worked_minutes > 0
      );

    if v_conflicting_attendance_count > 0 then
      raise exception 'Leave overlaps recorded attendance. Resolve the attendance record before approving leave.';
    end if;

    -- Create one payroll-visible leave attendance row for every released working
    -- shift. Rest days and holidays are intentionally excluded from leave usage.
    insert into public.attendance (
      user_id,
      schedule_id,
      work_date,
      attendance_status,
      review_status,
      reviewed_by,
      reviewed_at,
      admin_notes,
      created_by,
      updated_by
    )
    select
      schedule.user_id,
      schedule.id,
      schedule.shift_date,
      'on_leave',
      'approved',
      v_actor_user_id,
      now(),
      concat('Approved ', v_request.leave_type, ' leave request ', v_request.id::text),
      v_actor_user_id,
      v_actor_user_id
    from public.work_schedules schedule
    where schedule.user_id = v_request.user_id
      and schedule.shift_date between v_request.start_date and v_request.end_date
      and schedule.status in ('published', 'changed')
      and not schedule.is_rest_day
      and not schedule.is_holiday
    on conflict (user_id, schedule_id) where schedule_id is not null
    do update set
      attendance_status = 'on_leave',
      review_status = 'approved',
      reviewed_by = excluded.reviewed_by,
      reviewed_at = excluded.reviewed_at,
      admin_notes = excluded.admin_notes,
      is_late = false,
      minutes_late = 0,
      undertime_minutes = 0,
      updated_by = excluded.updated_by,
      updated_at = now()
    where attendance.clock_in is null
      and attendance.clock_out is null
      and attendance.total_worked_minutes = 0;

    get diagnostics v_attendance_count = row_count;
  end if;

  update public.leave_requests
  set status = p_status,
      review_notes = nullif(trim(coalesce(p_review_notes, '')), ''),
      reviewed_by = v_actor_user_id,
      reviewed_at = now(),
      updated_at = now()
  where id = p_request_id
  returning * into v_result;

  insert into public.workforce_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    before_data,
    after_data
  ) values (
    v_actor_user_id,
    'leave_request_reviewed',
    'leave_request',
    v_request.id,
    jsonb_build_object('status', v_request.status),
    jsonb_build_object(
      'status', v_result.status,
      'review_notes', v_result.review_notes,
      'attendance_records_marked_on_leave', v_attendance_count
    )
  );

  return v_result;
end;
$$;

revoke all on function public.workforce_review_leave_request(uuid, text, text) from public;
revoke all on function public.workforce_review_leave_request(uuid, text, text) from anon;
revoke all on function public.workforce_review_leave_request(uuid, text, text) from authenticated;
grant execute on function public.workforce_review_leave_request(uuid, text, text) to authenticated;

comment on function public.workforce_review_leave_request(uuid, text, text) is
  'Reviews pending leave and transactionally marks released working shifts as approved on-leave attendance without overwriting clock activity.';

-- Submission remains a direct, owner-scoped insert. All state changes must use
-- the cancellation or review RPC so attendance synchronization cannot be skipped.
revoke update, delete on public.leave_requests from authenticated;
grant select, insert on public.leave_requests to authenticated;

insert into public.workforce_audit_logs (
  actor_user_id,
  action,
  entity_type,
  after_data
)
values (
  null,
  'leave_management_completed',
  'system',
  jsonb_build_object(
    'approved_leave_marks_attendance', true,
    'released_working_shifts_only', true,
    'clock_activity_is_never_overwritten', true
  )
);

commit;
