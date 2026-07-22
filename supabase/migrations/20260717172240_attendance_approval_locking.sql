-- Add the missing attendance review workflow. Approval is a payroll gate;
-- locking is an irreversible finalization step enforced for all write paths.

begin;

create or replace function public.workforce_review_attendance(
  p_attendance_id uuid,
  p_review_status text,
  p_review_notes text default null
)
returns public.attendance
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid;
  v_attendance public.attendance%rowtype;
  v_result public.attendance%rowtype;
  v_review_notes text := nullif(trim(coalesce(p_review_notes, '')), '');
begin
  v_actor_user_id := public.workforce_current_profile_id();

  if v_actor_user_id is null then
    raise exception 'Authenticated workforce profile is required.';
  end if;

  if p_attendance_id is null then
    raise exception 'Attendance record is required.';
  end if;

  if p_review_status not in ('approved', 'locked') then
    raise exception 'Review status must be approved or locked.';
  end if;

  select attendance_row.*
  into v_attendance
  from public.attendance attendance_row
  where attendance_row.id = p_attendance_id
  for update;

  if not found then
    raise exception 'Attendance record not found.';
  end if;

  if not public.workforce_can_approve_attendance(v_attendance.user_id) then
    raise exception 'You do not have permission to approve this attendance record.';
  end if;

  if v_attendance.review_status = 'locked' then
    if p_review_status = 'locked' then
      return v_attendance;
    end if;
    raise exception 'Locked attendance cannot be changed.';
  end if;

  if p_review_status = 'approved' then
    if v_attendance.review_status = 'approved' then
      return v_attendance;
    end if;

    if v_attendance.review_status not in ('pending', 'corrected') then
      raise exception 'Only pending or corrected attendance can be approved.';
    end if;

    if v_attendance.attendance_status = 'present'
       and (v_attendance.clock_in is null or v_attendance.clock_out is null) then
      raise exception 'Completed clock-in and clock-out values are required before approval.';
    end if;

    if v_attendance.clock_out is not null
       and (
         v_attendance.pre_shift_overtime_minutes is null
         or v_attendance.regular_minutes is null
         or v_attendance.post_shift_overtime_minutes is null
       ) then
      raise exception 'Attendance calculations must be complete before approval.';
    end if;
  elsif v_attendance.review_status <> 'approved' then
    raise exception 'Attendance must be approved before it can be locked.';
  end if;

  update public.attendance
  set review_status = p_review_status,
      reviewed_by = v_actor_user_id,
      reviewed_at = now(),
      updated_by = v_actor_user_id,
      updated_at = now()
  where id = v_attendance.id
  returning * into v_result;

  insert into public.workforce_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    before_data,
    after_data,
    reason
  ) values (
    v_actor_user_id,
    case p_review_status
      when 'approved' then 'attendance_approved'
      else 'attendance_locked'
    end,
    'attendance',
    v_result.id,
    jsonb_build_object(
      'attendance_id', v_attendance.id,
      'employee_user_id', v_attendance.user_id,
      'work_date', v_attendance.work_date,
      'review_status', v_attendance.review_status,
      'reviewed_by', v_attendance.reviewed_by,
      'reviewed_at', v_attendance.reviewed_at
    ),
    jsonb_build_object(
      'attendance_id', v_result.id,
      'employee_user_id', v_result.user_id,
      'work_date', v_result.work_date,
      'review_status', v_result.review_status,
      'reviewed_by', v_result.reviewed_by,
      'reviewed_at', v_result.reviewed_at
    ),
    coalesce(v_review_notes, concat('Attendance ', p_review_status, ' through Team Attendance'))
  );

  return v_result;
end;
$$;

comment on function public.workforce_review_attendance(uuid, text, text) is
  'Approves complete attendance and irreversibly locks approved attendance after explicit permission and scope checks.';

revoke all on function public.workforce_review_attendance(uuid, text, text) from public, anon;
grant execute on function public.workforce_review_attendance(uuid, text, text) to authenticated;

create or replace function public.workforce_protect_locked_attendance()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.review_status = 'locked' then
    raise exception 'Locked attendance cannot be changed or deleted.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

comment on function public.workforce_protect_locked_attendance() is
  'Rejects every update or delete against finalized locked attendance.';

revoke all on function public.workforce_protect_locked_attendance() from public, anon, authenticated;

drop trigger if exists zz_attendance_locked_immutable on public.attendance;
create trigger zz_attendance_locked_immutable
before update or delete on public.attendance
for each row execute function public.workforce_protect_locked_attendance();

insert into public.workforce_audit_logs (
  action,
  entity_type,
  after_data,
  reason
) values (
  'attendance_approval_locking_deployed',
  'attendance',
  jsonb_build_object(
    'review_rpc', 'workforce_review_attendance',
    'allowed_transitions', jsonb_build_array('pending_to_approved', 'corrected_to_approved', 'approved_to_locked'),
    'locked_attendance_immutable', true
  ),
  'Added audited attendance approval and irreversible locking workflow'
);

commit;
