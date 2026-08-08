-- Fix the already-deployed billed correction entry point without changing
-- payroll calculations or the existing permission model.

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
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_old public.attendance%rowtype;
  v_new public.attendance%rowtype;
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
  if not public.workforce_can_manage_user(v_old.user_id, 'correct_attendance') then raise exception 'You do not have permission to manage this employee.'; end if;

  update public.attendance
  set billed_clock_in = p_new_clock_in,
      billed_clock_out = p_new_clock_out,
      attendance_status = p_new_status,
      review_status = case when review_status = 'pending' then 'corrected' else review_status end,
      schedule_id = coalesce(p_schedule_id, schedule_id),
      admin_notes = coalesce(nullif(trim(coalesce(p_admin_notes, '')), ''), admin_notes),
      correction_reason = p_reason_code,
      corrected_by = v_actor,
      corrected_at = now(),
      is_corrected = true,
      updated_by = v_actor,
      updated_at = now()
  where id = v_old.id
  returning * into v_new;

  v_new := public.workforce_recalculate_attendance(v_new.id);

  insert into public.attendance_corrections (
    attendance_id, employee_user_id, schedule_id,
    previous_clock_in, previous_clock_out, new_clock_in, new_clock_out,
    previous_billed_clock_in, previous_billed_clock_out,
    new_billed_clock_in, new_billed_clock_out,
    previous_status, new_status, reason_code, reason_notes,
    corrected_by, corrected_at
  ) values (
    v_new.id, v_new.user_id, v_new.schedule_id,
    v_old.billed_clock_in, v_old.billed_clock_out,
    v_new.billed_clock_in, v_new.billed_clock_out,
    v_old.billed_clock_in, v_old.billed_clock_out,
    v_new.billed_clock_in, v_new.billed_clock_out,
    v_old.attendance_status, v_new.attendance_status, p_reason_code, v_reason,
    v_actor, now()
  );

  insert into public.workforce_audit_logs
    (actor_user_id, action, entity_type, entity_id, before_data, after_data, reason)
  values (
    v_actor, 'attendance_billed_time_corrected', 'attendance', v_new.id,
    jsonb_build_object('original_clock_in', v_old.original_clock_in, 'original_clock_out', v_old.original_clock_out,
      'billed_clock_in', v_old.billed_clock_in, 'billed_clock_out', v_old.billed_clock_out, 'review_status', v_old.review_status),
    jsonb_build_object('original_clock_in', v_new.original_clock_in, 'original_clock_out', v_new.original_clock_out,
      'billed_clock_in', v_new.billed_clock_in, 'billed_clock_out', v_new.billed_clock_out, 'review_status', v_new.review_status),
    coalesce(v_reason, p_reason_code)
  );
  return v_new;
end;
$$;

revoke all on function public.workforce_correct_attendance(uuid, timestamptz, timestamptz, text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.workforce_correct_attendance(uuid, timestamptz, timestamptz, text, uuid, text, text, text) to authenticated;

commit;
