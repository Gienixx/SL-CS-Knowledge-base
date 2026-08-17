-- Keep the structured totals constraint authoritative while allowing billed
-- corrections to be recalculated from billed timestamps rather than captured
-- timestamps. The setting is transaction-local and is only enabled by the
-- correction RPC below; ordinary attendance writes retain existing behavior.

begin;

create or replace function public.workforce_prepare_attendance_storage()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_legacy_overtime_changed boolean := false;
  v_total_overtime_changed boolean := false;
  v_correction_recalculation boolean :=
    coalesce(current_setting('workforce.correction_recalculation', true), '') = 'true';
begin
  if tg_op = 'INSERT' then
    if new.original_clock_in is null and new.clock_in is not null then
      new.original_clock_in := new.clock_in;
    end if;

    if new.original_clock_out is null and new.clock_out is not null then
      new.original_clock_out := new.clock_out;
    end if;

    if coalesce(new.overtime_minutes, 0) <> new.total_overtime_minutes then
      if new.total_overtime_minutes = 0 then
        new.total_overtime_minutes := coalesce(new.overtime_minutes, 0);
      elsif coalesce(new.overtime_minutes, 0) = 0 then
        new.overtime_minutes := new.total_overtime_minutes;
      else
        raise exception 'overtime_minutes and total_overtime_minutes must match.';
      end if;
    end if;
  else
    if old.original_clock_in is not null then
      if new.original_clock_in is distinct from old.original_clock_in then
        raise exception 'original_clock_in is immutable after capture.';
      end if;
    elsif old.clock_in is null and new.clock_in is not null then
      new.original_clock_in := new.clock_in;
    elsif new.original_clock_in is not null then
      raise exception 'original_clock_in cannot be supplied after the initial clock-in.';
    end if;

    if old.original_clock_out is not null then
      if new.original_clock_out is distinct from old.original_clock_out then
        raise exception 'original_clock_out is immutable after capture.';
      end if;
    elsif old.clock_out is null and new.clock_out is not null then
      new.original_clock_out := new.clock_out;
    elsif new.original_clock_out is not null then
      raise exception 'original_clock_out cannot be supplied after the initial clock-out.';
    end if;

    v_legacy_overtime_changed := new.overtime_minutes is distinct from old.overtime_minutes;
    v_total_overtime_changed := new.total_overtime_minutes is distinct from old.total_overtime_minutes;

    if v_legacy_overtime_changed and v_total_overtime_changed then
      if coalesce(new.overtime_minutes, 0) <> new.total_overtime_minutes then
        raise exception 'overtime_minutes and total_overtime_minutes must match.';
      end if;
    elsif v_legacy_overtime_changed then
      new.total_overtime_minutes := coalesce(new.overtime_minutes, 0);
    elsif v_total_overtime_changed then
      new.overtime_minutes := new.total_overtime_minutes;
    end if;
  end if;

  if not v_correction_recalculation then
    if new.clock_in is not null and new.clock_out is not null then
      if new.clock_out < new.clock_in then
        raise exception 'Clock-out cannot be earlier than clock-in.';
      end if;

      new.total_worked_minutes := floor(
        extract(epoch from (new.clock_out - new.clock_in)) / 60
      )::integer;
    else
      new.total_worked_minutes := 0;
    end if;
  end if;

  new.is_corrected :=
    (
      new.original_clock_in is not null
      and new.clock_in is distinct from new.original_clock_in
    )
    or (
      new.original_clock_out is not null
      and new.clock_out is distinct from new.original_clock_out
    )
    or new.corrected_by is not null
    or new.corrected_at is not null
    or nullif(trim(coalesce(new.correction_reason, '')), '') is not null;

  return new;
end;
$$;

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
language plpgsql security definer
set search_path = public, pg_temp
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
  if not (
    public.workforce_is_admin()
    and (
      public.workforce_has_permission('correct_attendance')
      or exists (
        select 1
        from public.profiles profile
        where public.workforce_is_current_identity(profile.user_id)
          and profile.is_system_admin is true
      )
    )
  ) then raise exception 'You do not have permission to manage this employee.'; end if;

  perform set_config('workforce.correction_recalculation', 'true', true);

  -- Enter the explicit pending-calculation state in the same statement as
  -- the billed correction. This is the only state accepted by the first
  -- branch of attendance_structured_totals_check while recalculation runs.
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

  if v_new.total_worked_minutes < v_new.regular_minutes + v_new.total_overtime_minutes then
    raise exception 'Recalculated attendance totals are inconsistent.';
  end if;

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
      'billed_clock_in', v_old.billed_clock_in, 'billed_clock_out', v_old.billed_clock_out, 'review_status', v_old.review_status,
      'attendance_version', v_old.attendance_version),
    jsonb_build_object('original_clock_in', v_new.original_clock_in, 'original_clock_out', v_new.original_clock_out,
      'billed_clock_in', v_new.billed_clock_in, 'billed_clock_out', v_new.billed_clock_out, 'review_status', v_new.review_status,
      'attendance_version', v_new.attendance_version),
    coalesce(v_reason, p_reason_code)
  );
  perform set_config('workforce.correction_recalculation', 'false', true);
  return v_new;
end;
$$;

revoke all on function public.workforce_correct_attendance(uuid, timestamptz, timestamptz, text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.workforce_correct_attendance(uuid, timestamptz, timestamptz, text, uuid, text, text, text) to authenticated;

commit;
