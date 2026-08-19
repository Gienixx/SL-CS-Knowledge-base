-- Allow schedule administrators to create rare manual attendance records while
-- keeping authorization, validation, trusted calculations, and audit metadata
-- inside PostgreSQL.

begin;

create or replace function public.workforce_create_manual_attendance(
  p_user_id uuid,
  p_work_date date,
  p_clock_in timestamptz,
  p_clock_out timestamptz,
  p_schedule_id uuid default null,
  p_attendance_status text default 'present',
  p_reason text default null,
  p_admin_notes text default null
)
returns public.attendance
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := auth.uid();
  v_schedule public.work_schedules%rowtype;
  v_inserted public.attendance%rowtype;
  v_result public.attendance%rowtype;
begin
  if v_actor_user_id is null then
    raise exception 'Authenticated session is required.';
  end if;

  if not public.workforce_current_user_is_active()
     or not public.workforce_is_admin()
     or not public.workforce_has_permission('manage_schedules') then
    raise exception 'You do not have permission to add attendance records.';
  end if;

  if p_user_id is null or p_work_date is null then
    raise exception 'Employee and work date are required.';
  end if;

  if not public.workforce_can_manage_user(p_user_id, 'manage_schedules') then
    raise exception 'You do not have permission to manage this employee.';
  end if;

  if p_clock_in is null or p_clock_out is null then
    raise exception 'Clock-in and clock-out are required for manual attendance.';
  end if;

  if p_clock_out < p_clock_in then
    raise exception 'Clock-out cannot be earlier than clock-in.';
  end if;

  if p_attendance_status not in ('present', 'absent', 'on_leave', 'excused') then
    raise exception 'Attendance status is invalid.';
  end if;

  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'A reason of at least 3 characters is required.';
  end if;

  if p_schedule_id is not null then
    select schedule.*
    into v_schedule
    from public.work_schedules schedule
    where schedule.id = p_schedule_id;

    if not found then
      raise exception 'The selected schedule does not exist.';
    end if;

    if v_schedule.user_id <> p_user_id then
      raise exception 'The selected schedule does not belong to this employee.';
    end if;

    if v_schedule.shift_date <> p_work_date then
      raise exception 'Work date must match the selected schedule.';
    end if;

    if v_schedule.status not in ('published', 'changed') then
      raise exception 'Only published or changed schedules can be linked to attendance.';
    end if;
  elsif exists (
    select 1
    from public.work_schedules schedule
    where schedule.user_id = p_user_id
      and schedule.shift_date = p_work_date
      and schedule.status in ('published', 'changed')
  ) then
    raise exception 'Select the employee''s released schedule for this work date.';
  end if;

  insert into public.attendance (
    user_id,
    schedule_id,
    work_date,
    clock_in,
    clock_out,
    attendance_status,
    correction_reason,
    admin_notes,
    corrected_by,
    corrected_at,
    review_status,
    reviewed_by,
    reviewed_at,
    is_corrected,
    created_by,
    updated_by
  ) values (
    p_user_id,
    p_schedule_id,
    p_work_date,
    p_clock_in,
    p_clock_out,
    p_attendance_status,
    trim(p_reason),
    nullif(trim(coalesce(p_admin_notes, '')), ''),
    v_actor_user_id,
    now(),
    'corrected',
    v_actor_user_id,
    now(),
    true,
    v_actor_user_id,
    v_actor_user_id
  )
  returning * into v_inserted;

  select *
  into v_result
  from public.workforce_recalculate_attendance(v_inserted.id);

  insert into public.workforce_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    after_data,
    reason
  ) values (
    v_actor_user_id,
    'manual_attendance_created',
    'attendance',
    v_result.id,
    jsonb_build_object(
      'employee_user_id', v_result.user_id,
      'schedule_id', v_result.schedule_id,
      'work_date', v_result.work_date,
      'clock_in', v_result.clock_in,
      'clock_out', v_result.clock_out,
      'attendance_status', v_result.attendance_status
    ),
    trim(p_reason)
  );

  return v_result;
end;
$$;

comment on function public.workforce_create_manual_attendance(uuid, date, timestamptz, timestamptz, uuid, text, text, text) is
  'Creates and recalculates an audited manual attendance record for an employee; restricted to active schedule administrators.';

revoke all on function public.workforce_create_manual_attendance(uuid, date, timestamptz, timestamptz, uuid, text, text, text) from public;
revoke all on function public.workforce_create_manual_attendance(uuid, date, timestamptz, timestamptz, uuid, text, text, text) from anon;
revoke all on function public.workforce_create_manual_attendance(uuid, date, timestamptz, timestamptz, uuid, text, text, text) from authenticated;
grant execute on function public.workforce_create_manual_attendance(uuid, date, timestamptz, timestamptz, uuid, text, text, text) to authenticated;

commit;
