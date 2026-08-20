-- Allow a same-work-date untimed Open Schedule to be selected during Team
-- Attendance correction. Previous-date candidates remain limited to timed,
-- Rest Day, or Holiday schedules. Existing correction safeguards are preserved.

begin;

create or replace function public.workforce_assign_attendance_schedule(
  p_attendance_id uuid,
  p_schedule_id uuid,
  p_reason_code text,
  p_reason_notes text default null
)
returns public.attendance
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_old public.attendance%rowtype;
  v_new public.attendance%rowtype;
  v_schedule public.work_schedules%rowtype;
  v_reason text := nullif(trim(coalesce(p_reason_notes, '')), '');
begin
  if v_actor is null or not public.workforce_current_user_is_active()
     or not public.workforce_can_correct_attendance(public.workforce_current_profile_id()) then
    raise exception 'You do not have permission to assign attendance schedules.';
  end if;
  if p_attendance_id is null or p_schedule_id is null then
    raise exception 'Attendance and schedule are required.';
  end if;
  if nullif(trim(coalesce(p_reason_code, '')), '') is null then
    raise exception 'A correction reason is required.';
  end if;
  if v_reason is null then
    raise exception 'Remarks are required when assigning a schedule.';
  end if;

  select * into v_old from public.attendance where id = p_attendance_id for update;
  if not found then raise exception 'Attendance record not found.'; end if;
  if v_old.review_status = 'locked' then raise exception 'Locked attendance cannot be changed.'; end if;
  if not public.workforce_can_manage_user(v_old.user_id, 'correct_attendance') then
    raise exception 'You do not have permission to manage this employee.';
  end if;
  if v_old.schedule_id is not distinct from p_schedule_id then
    raise exception 'The selected schedule is already assigned.';
  end if;

  select * into v_schedule
  from public.work_schedules
  where id = p_schedule_id
  for share;
  if not found then raise exception 'The selected schedule was not found.'; end if;
  if v_schedule.user_id <> v_old.user_id then raise exception 'Schedule employee does not match attendance employee.'; end if;
  if v_schedule.shift_date not in (v_old.work_date, v_old.work_date - 1) then
    raise exception 'Schedule work date must match attendance work date or the previous calendar day.';
  end if;
  if v_schedule.is_leave or v_schedule.is_absent then
    raise exception 'Leave and absence schedules cannot be assigned to attendance.';
  end if;
  if v_schedule.status not in ('published', 'changed') then raise exception 'Only published or changed schedules may be assigned.'; end if;
  if not v_schedule.is_rest_day and not v_schedule.is_holiday
     and not (
       v_schedule.shift_date = v_old.work_date
       and v_schedule.shift_start is null
       and v_schedule.shift_end is null
     )
     and (v_schedule.shift_start is null or v_schedule.shift_end is null or v_schedule.shift_end <= v_schedule.shift_start) then
    raise exception 'The selected schedule does not have valid shift times.';
  end if;

  -- Keep the schedule-only correction on the same constraint-safe path as timestamp corrections.
  perform set_config('workforce.correction_recalculation', 'true', true);

  update public.attendance
  set schedule_id = p_schedule_id,
      review_status = case when review_status = 'approved' then 'corrected' else review_status end,
      correction_reason = p_reason_code,
      corrected_by = v_actor,
      corrected_at = now(),
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
      updated_by = v_actor,
      updated_at = now()
  where id = v_old.id
  returning * into v_new;

  v_new := public.workforce_recalculate_attendance(v_new.id);

  if v_new.pre_shift_overtime_minutes is null
     or v_new.regular_minutes is null
     or v_new.post_shift_overtime_minutes is null
     or v_new.rest_day_overtime_minutes is null
     or v_new.holiday_overtime_minutes is null
     or v_new.total_overtime_minutes is null
     or v_new.total_worked_minutes is null
     or v_new.total_overtime_minutes is distinct from
        ((v_new.pre_shift_overtime_minutes + v_new.post_shift_overtime_minutes)
          + v_new.rest_day_overtime_minutes + v_new.holiday_overtime_minutes)
     or v_new.total_overtime_minutes > 1200
     or (v_new.clock_out is not null
         and v_new.total_worked_minutes < v_new.regular_minutes + v_new.total_overtime_minutes) then
    raise exception 'Recalculated attendance totals are inconsistent.';
  end if;

  insert into public.attendance_corrections (
    attendance_id, employee_user_id, schedule_id, previous_schedule_id, new_schedule_id,
    previous_clock_in, previous_clock_out, new_clock_in, new_clock_out,
    previous_billed_clock_in, previous_billed_clock_out,
    new_billed_clock_in, new_billed_clock_out,
    previous_status, new_status, reason_code, reason_notes,
    corrected_by, corrected_at
  ) values (
    v_new.id, v_new.user_id, v_new.schedule_id, v_old.schedule_id, v_new.schedule_id,
    v_old.billed_clock_in, v_old.billed_clock_out, v_new.billed_clock_in, v_new.billed_clock_out,
    v_old.billed_clock_in, v_old.billed_clock_out, v_new.billed_clock_in, v_new.billed_clock_out,
    v_old.attendance_status, v_new.attendance_status, p_reason_code, v_reason,
    v_actor, now()
  );

  insert into public.workforce_audit_logs
    (actor_user_id, action, entity_type, entity_id, before_data, after_data, reason)
  values (
    v_actor, 'attendance_schedule_assigned', 'attendance', v_new.id,
    jsonb_build_object(
      'schedule_id', v_old.schedule_id,
      'original_clock_in', v_old.original_clock_in,
      'original_clock_out', v_old.original_clock_out,
      'billed_clock_in', v_old.billed_clock_in,
      'billed_clock_out', v_old.billed_clock_out,
      'review_status', v_old.review_status
    ),
    jsonb_build_object(
      'schedule_id', v_new.schedule_id,
      'original_clock_in', v_new.original_clock_in,
      'original_clock_out', v_new.original_clock_out,
      'billed_clock_in', v_new.billed_clock_in,
      'billed_clock_out', v_new.billed_clock_out,
      'review_status', v_new.review_status,
      'corrected_by', v_actor
    ),
    coalesce(v_reason, p_reason_code)
  );

  perform set_config('workforce.correction_recalculation', 'false', true);
  return v_new;
exception when others then
  perform set_config('workforce.correction_recalculation', 'false', true);
  raise;
end;
$$;

revoke all on function public.workforce_assign_attendance_schedule(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.workforce_assign_attendance_schedule(uuid, uuid, text, text) to authenticated, service_role;

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
  v_actor uuid := auth.uid();
  v_old public.attendance%rowtype;
  v_new public.attendance%rowtype;
  v_schedule public.work_schedules%rowtype;
  v_reason text := nullif(trim(coalesce(p_reason_notes, '')), '');
begin
  if v_actor is null then raise exception 'Authenticated session is required.'; end if;
  if not public.workforce_current_user_is_active()
     or not public.workforce_can_correct_attendance(public.workforce_current_profile_id()) then
    raise exception 'You do not have permission to correct attendance.';
  end if;
  if p_attendance_id is null then raise exception 'Attendance record is required.'; end if;
  if p_new_status not in ('present', 'absent', 'on_leave', 'excused') then raise exception 'Attendance status is invalid.'; end if;
  if p_new_clock_out is not null and (p_new_clock_in is null or p_new_clock_out < p_new_clock_in) then raise exception 'Billed clock-out cannot be earlier than billed clock-in.'; end if;
  if nullif(trim(coalesce(p_reason_code, '')), '') is null then raise exception 'A correction reason is required.'; end if;
  if p_reason_code = 'other' and v_reason is null then raise exception 'Written notes are required when reason is other.'; end if;

  select * into v_old from public.attendance where id = p_attendance_id for update;
  if not found then raise exception 'Attendance record not found.'; end if;
  if v_old.review_status = 'locked' then raise exception 'Locked attendance cannot be changed.'; end if;
  if not (
    public.workforce_is_admin()
    and (
      public.workforce_has_permission('correct_attendance')
      or exists (
        select 1 from public.profiles profile
        where public.workforce_is_current_identity(profile.user_id)
          and profile.is_system_admin is true
      )
    )
  ) then raise exception 'You do not have permission to manage this employee.'; end if;

  if p_schedule_id is not null and p_schedule_id is distinct from v_old.schedule_id then
    select * into v_schedule
    from public.work_schedules
    where id = p_schedule_id
    for share;
    if not found then raise exception 'The selected schedule was not found.'; end if;
    if v_schedule.user_id <> v_old.user_id then raise exception 'Schedule employee does not match attendance employee.'; end if;
    if v_schedule.shift_date not in (v_old.work_date, v_old.work_date - 1) then
      raise exception 'Schedule work date must match attendance work date or the previous calendar day.';
    end if;
    if v_schedule.is_leave or v_schedule.is_absent then
      raise exception 'Leave and absence schedules cannot be assigned to attendance.';
    end if;
    if v_schedule.status not in ('published', 'changed') then raise exception 'Only published or changed schedules may be assigned.'; end if;
    if not v_schedule.is_rest_day and not v_schedule.is_holiday
       and not (
         v_schedule.shift_date = v_old.work_date
         and v_schedule.shift_start is null
         and v_schedule.shift_end is null
       )
       and (v_schedule.shift_start is null or v_schedule.shift_end is null or v_schedule.shift_end <= v_schedule.shift_start) then
      raise exception 'The selected schedule does not have valid shift times.';
    end if;
  end if;

  -- The trigger's structured-totals check accepts this pending state while
  -- workforce_recalculate_attendance computes the final values.
  perform set_config('workforce.correction_recalculation', 'true', true);

  update public.attendance
  set billed_clock_in = p_new_clock_in,
      billed_clock_out = p_new_clock_out,
      attendance_status = p_new_status,
      review_status = 'corrected',
      schedule_id = coalesce(p_schedule_id, schedule_id),
      admin_notes = coalesce(nullif(trim(coalesce(p_admin_notes, '')), ''), admin_notes),
      correction_reason = p_reason_code,
      corrected_by = v_actor,
      corrected_at = now(),
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
      updated_by = v_actor,
      updated_at = now()
  where id = v_old.id
  returning * into v_new;

  v_new := public.workforce_recalculate_attendance(v_new.id);

  if v_new.pre_shift_overtime_minutes is null
     or v_new.regular_minutes is null
     or v_new.post_shift_overtime_minutes is null
     or v_new.rest_day_overtime_minutes is null
     or v_new.holiday_overtime_minutes is null
     or v_new.total_overtime_minutes is null
     or v_new.total_worked_minutes is null
     or v_new.total_overtime_minutes is distinct from
        ((v_new.pre_shift_overtime_minutes + v_new.post_shift_overtime_minutes)
          + v_new.rest_day_overtime_minutes + v_new.holiday_overtime_minutes)
     or v_new.total_overtime_minutes > 1200
     or (v_new.clock_out is not null
         and v_new.total_worked_minutes < v_new.regular_minutes + v_new.total_overtime_minutes) then
    raise exception 'Recalculated attendance totals are inconsistent.';
  end if;

  insert into public.attendance_corrections (
    attendance_id, employee_user_id, schedule_id, previous_schedule_id, new_schedule_id,
    previous_clock_in, previous_clock_out, new_clock_in, new_clock_out,
    previous_billed_clock_in, previous_billed_clock_out,
    new_billed_clock_in, new_billed_clock_out,
    previous_status, new_status, reason_code, reason_notes,
    corrected_by, corrected_at
  ) values (
    v_new.id, v_new.user_id, v_new.schedule_id, v_old.schedule_id, v_new.schedule_id,
    v_old.billed_clock_in, v_old.billed_clock_out, v_new.billed_clock_in, v_new.billed_clock_out,
    v_old.billed_clock_in, v_old.billed_clock_out,
    v_new.billed_clock_in, v_new.billed_clock_out,
    v_old.attendance_status, v_new.attendance_status, p_reason_code, v_reason,
    v_actor, now()
  );

  insert into public.workforce_audit_logs
    (actor_user_id, action, entity_type, entity_id, before_data, after_data, reason)
  values (
    v_actor, 'attendance_billed_time_corrected', 'attendance', v_new.id,
    jsonb_build_object(
      'schedule_id', v_old.schedule_id,
      'original_clock_in', v_old.original_clock_in,
      'original_clock_out', v_old.original_clock_out,
      'billed_clock_in', v_old.billed_clock_in,
      'billed_clock_out', v_old.billed_clock_out,
      'review_status', v_old.review_status,
      'attendance_version', v_old.attendance_version
    ),
    jsonb_build_object(
      'schedule_id', v_new.schedule_id,
      'original_clock_in', v_new.original_clock_in,
      'original_clock_out', v_new.original_clock_out,
      'billed_clock_in', v_new.billed_clock_in,
      'billed_clock_out', v_new.billed_clock_out,
      'review_status', v_new.review_status,
      'attendance_version', v_new.attendance_version,
      'corrected_by', v_actor
    ),
    coalesce(v_reason, p_reason_code)
  );

  perform set_config('workforce.correction_recalculation', 'false', true);
  return v_new;
exception when others then
  perform set_config('workforce.correction_recalculation', 'false', true);
  raise;
end;
$$;

revoke all on function public.workforce_correct_attendance(uuid, timestamptz, timestamptz, text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.workforce_correct_attendance(uuid, timestamptz, timestamptz, text, uuid, text, text, text) to authenticated;

commit;
