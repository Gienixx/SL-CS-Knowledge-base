-- Keep attendance corrections compatible with the canonical structured-total
-- calculator. In particular, unscheduled attendance is RDOT and all structured
-- components must change atomically to satisfy attendance constraints.

begin;

create or replace function public.workforce_correct_attendance(
  p_attendance_id uuid,
  p_new_clock_in timestamptz,
  p_new_clock_out timestamptz,
  p_new_status text,
  p_schedule_id uuid default null,
  p_admin_notes text default null,
  p_reason_code text default null,
  p_reason_notes text default null
)
returns public.attendance
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_user_id uuid := auth.uid();
  v_attendance public.attendance%rowtype;
  v_current_profile public.profiles%rowtype;
  v_schedule public.work_schedules%rowtype;
  v_previous_calculations jsonb;
  v_result public.attendance%rowtype;
begin
  if v_actor_user_id is null then
    raise exception 'Authenticated session is required.';
  end if;

  if p_attendance_id is null then
    raise exception 'Attendance record is required.';
  end if;

  if p_new_status is null
     or p_new_status not in ('present', 'absent', 'on_leave', 'excused') then
    raise exception 'Attendance status is invalid.';
  end if;

  if p_new_clock_in is not null
     and p_new_clock_out is not null
     and p_new_clock_out < p_new_clock_in then
    raise exception 'Clock-out cannot be earlier than clock-in.';
  end if;

  if p_reason_code is null then
    raise exception 'A correction reason is required.';
  end if;

  if p_reason_code not in (
    'forgot_clock_in',
    'forgot_clock_out',
    'system_issue',
    'connection_issue',
    'incorrect_schedule',
    'approved_overtime',
    'manager_confirmed',
    'other'
  ) then
    raise exception 'Reason code is invalid.';
  end if;

  if p_reason_code = 'other'
     and length(trim(coalesce(p_reason_notes, ''))) = 0 then
    raise exception 'Written notes are required when reason is other.';
  end if;

  select profile.*
  into v_current_profile
  from public.profiles profile
  where profile.user_id = v_actor_user_id;

  if not found then
    raise exception 'Active workforce profile not found.';
  end if;

  if not public.workforce_can_correct_attendance(v_current_profile.user_id) then
    raise exception 'You do not have permission to correct attendance.';
  end if;

  select attendance_row.*
  into v_attendance
  from public.attendance attendance_row
  where attendance_row.id = p_attendance_id
  for update;

  if not found then
    raise exception 'Attendance record not found.';
  end if;

  if p_schedule_id is not null then
    select schedule.*
    into v_schedule
    from public.work_schedules schedule
    where schedule.id = p_schedule_id;

    if not found then
      raise exception 'The selected schedule does not exist.';
    end if;

    if v_schedule.user_id <> v_attendance.user_id then
      raise exception 'The schedule does not belong to the same employee.';
    end if;
  end if;

  v_previous_calculations := jsonb_build_object(
    'pre_shift_overtime_minutes', coalesce(v_attendance.pre_shift_overtime_minutes, 0),
    'regular_minutes', coalesce(v_attendance.regular_minutes, 0),
    'post_shift_overtime_minutes', coalesce(v_attendance.post_shift_overtime_minutes, 0),
    'rest_day_overtime_minutes', coalesce(v_attendance.rest_day_overtime_minutes, 0),
    'holiday_overtime_minutes', coalesce(v_attendance.holiday_overtime_minutes, 0),
    'total_overtime_minutes', coalesce(v_attendance.total_overtime_minutes, 0),
    'total_worked_minutes', coalesce(v_attendance.total_worked_minutes, 0),
    'minutes_late', coalesce(v_attendance.minutes_late, 0),
    'undertime_minutes', coalesce(v_attendance.undertime_minutes, 0)
  );

  -- Reset every structured component in the same statement as the timestamp
  -- correction. This is the constraint-safe legacy state; the canonical
  -- recalculator below immediately derives the trusted final values.
  update public.attendance
  set clock_in = p_new_clock_in,
      clock_out = p_new_clock_out,
      attendance_status = p_new_status,
      schedule_id = coalesce(p_schedule_id, schedule_id),
      admin_notes = coalesce(nullif(trim(coalesce(p_admin_notes, '')), ''), admin_notes),
      correction_reason = p_reason_code,
      corrected_by = v_actor_user_id,
      corrected_at = now(),
      review_status = 'corrected',
      reviewed_by = v_actor_user_id,
      reviewed_at = now(),
      is_corrected = true,
      pre_shift_overtime_minutes = null,
      regular_minutes = null,
      post_shift_overtime_minutes = null,
      rest_day_overtime_minutes = 0,
      holiday_overtime_minutes = 0,
      total_overtime_minutes = 0,
      overtime_minutes = 0,
      total_worked_minutes = 0,
      minutes_late = 0,
      is_late = false,
      undertime_minutes = 0,
      updated_by = v_actor_user_id,
      updated_at = now()
  where id = v_attendance.id;

  v_result := public.workforce_recalculate_attendance(v_attendance.id);

  insert into public.attendance_corrections (
    attendance_id,
    employee_user_id,
    schedule_id,
    previous_clock_in,
    previous_clock_out,
    new_clock_in,
    new_clock_out,
    previous_status,
    new_status,
    previous_calculations,
    new_calculations,
    reason_code,
    reason_notes,
    corrected_by,
    corrected_at
  ) values (
    v_result.id,
    v_result.user_id,
    v_result.schedule_id,
    v_attendance.clock_in,
    v_attendance.clock_out,
    v_result.clock_in,
    v_result.clock_out,
    v_attendance.attendance_status,
    v_result.attendance_status,
    v_previous_calculations,
    jsonb_build_object(
      'pre_shift_overtime_minutes', coalesce(v_result.pre_shift_overtime_minutes, 0),
      'regular_minutes', coalesce(v_result.regular_minutes, 0),
      'post_shift_overtime_minutes', coalesce(v_result.post_shift_overtime_minutes, 0),
      'rest_day_overtime_minutes', coalesce(v_result.rest_day_overtime_minutes, 0),
      'holiday_overtime_minutes', coalesce(v_result.holiday_overtime_minutes, 0),
      'total_overtime_minutes', coalesce(v_result.total_overtime_minutes, 0),
      'total_worked_minutes', coalesce(v_result.total_worked_minutes, 0),
      'minutes_late', coalesce(v_result.minutes_late, 0),
      'undertime_minutes', coalesce(v_result.undertime_minutes, 0)
    ),
    p_reason_code,
    p_reason_notes,
    v_actor_user_id,
    now()
  );

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
    'attendance_corrected',
    'attendance',
    v_result.id,
    jsonb_build_object(
      'attendance_id', v_attendance.id,
      'clock_in', v_attendance.clock_in,
      'clock_out', v_attendance.clock_out,
      'status', v_attendance.attendance_status
    ),
    jsonb_build_object(
      'attendance_id', v_result.id,
      'clock_in', v_result.clock_in,
      'clock_out', v_result.clock_out,
      'status', v_result.attendance_status,
      'reason_code', p_reason_code,
      'reason_notes', p_reason_notes,
      'review_status', v_result.review_status,
      'corrected_by', v_actor_user_id
    ),
    'attendance correction recorded'
  );

  return v_result;
end;
$$;

comment on function public.workforce_correct_attendance(uuid, timestamptz, timestamptz, text, uuid, text, text, text) is
  'Corrects attendance, delegates all structured totals to the canonical recalculator, and records an audit history.';

revoke all on function public.workforce_correct_attendance(uuid, timestamptz, timestamptz, text, uuid, text, text, text) from public;
revoke all on function public.workforce_correct_attendance(uuid, timestamptz, timestamptz, text, uuid, text, text, text) from anon;
revoke all on function public.workforce_correct_attendance(uuid, timestamptz, timestamptz, text, uuid, text, text, text) from authenticated;
grant execute on function public.workforce_correct_attendance(uuid, timestamptz, timestamptz, text, uuid, text, text, text) to authenticated;

insert into public.workforce_audit_logs (
  actor_user_id,
  action,
  entity_type,
  after_data,
  reason
) values (
  auth.uid(),
  'attendance_correction_totals_fixed',
  'attendance',
  jsonb_build_object(
    'canonical_recalculation_enabled', true,
    'unscheduled_attendance_remains_rdot', true,
    'structured_components_updated_atomically', true
  ),
  'Kept correction totals compatible with RDOT and holiday overtime constraints'
);

commit;
