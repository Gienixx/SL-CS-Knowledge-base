-- Allow an authorized attendance manager to link an existing unscheduled
-- attendance record to a valid schedule through the audited correction path.

begin;

alter table public.attendance_corrections
  add column if not exists previous_schedule_id uuid references public.work_schedules(id) on delete set null;

create or replace function public.workforce_assign_attendance_schedule(
  p_attendance_id uuid,
  p_schedule_id uuid,
  p_reason_code text,
  p_reason_notes text default null
)
returns public.attendance
language plpgsql security definer set search_path = public, pg_temp
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
  if v_schedule.shift_date <> v_old.work_date then raise exception 'Schedule work date must match attendance work date.'; end if;
  if v_schedule.status not in ('published', 'changed') then raise exception 'Only published or changed schedules may be assigned.'; end if;
  if not v_schedule.is_rest_day and not v_schedule.is_holiday
     and (v_schedule.shift_start is null or v_schedule.shift_end is null or v_schedule.shift_end <= v_schedule.shift_start) then
    raise exception 'The selected schedule does not have valid shift times.';
  end if;

  update public.attendance
  set schedule_id = p_schedule_id,
      review_status = case when review_status = 'approved' then 'corrected' else review_status end,
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
    attendance_id, employee_user_id, schedule_id, previous_schedule_id,
    previous_clock_in, previous_clock_out, new_clock_in, new_clock_out,
    previous_billed_clock_in, previous_billed_clock_out,
    new_billed_clock_in, new_billed_clock_out,
    previous_status, new_status, reason_code, reason_notes,
    corrected_by, corrected_at
  ) values (
    v_new.id, v_new.user_id, v_new.schedule_id, v_old.schedule_id,
    v_old.billed_clock_in, v_old.billed_clock_out, v_new.billed_clock_in, v_new.billed_clock_out,
    v_old.billed_clock_in, v_old.billed_clock_out, v_new.billed_clock_in, v_new.billed_clock_out,
    v_old.attendance_status, v_new.attendance_status, p_reason_code, v_reason, v_actor, now()
  );

  insert into public.workforce_audit_logs
    (actor_user_id, action, entity_type, entity_id, before_data, after_data, reason)
  values (
    v_actor, 'attendance_schedule_assigned', 'attendance', v_new.id,
    jsonb_build_object('schedule_id', v_old.schedule_id, 'review_status', v_old.review_status),
    jsonb_build_object('schedule_id', v_new.schedule_id, 'review_status', v_new.review_status),
    coalesce(v_reason, p_reason_code)
  );
  return v_new;
end;
$$;

revoke all on function public.workforce_assign_attendance_schedule(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.workforce_assign_attendance_schedule(uuid, uuid, text, text) to authenticated;

commit;
