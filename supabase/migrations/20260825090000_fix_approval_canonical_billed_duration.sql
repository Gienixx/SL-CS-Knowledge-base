-- Keep Team Attendance approval aligned with canonical billed attendance values.
-- Approval is a metadata transition; it must not recalculate total_worked_minutes
-- from immutable/raw timestamps as a side effect of that transition.

begin;

-- Approval and locking only change review metadata. Keep the existing raw
-- duration recalculation for ordinary attendance edits, but explicitly mark
-- the metadata-only path so corrected billed totals are preserved.
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
  v_review_metadata_update boolean :=
    coalesce(current_setting('workforce.review_metadata_update', true), '') = 'true';
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

  if not v_correction_recalculation and not v_review_metadata_update then
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
  v_effective_clock_in timestamptz;
  v_effective_clock_out timestamptz;
  v_canonical_billed_minutes integer;
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
      if v_attendance.payroll_approved_at is null then
        perform set_config('workforce.review_metadata_update', 'true', true);
        update public.attendance
        set payroll_approved_at = coalesce(v_attendance.reviewed_at, now()),
            updated_by = v_actor_user_id,
            updated_at = now()
        where id = v_attendance.id
        returning * into v_attendance;
        perform set_config('workforce.review_metadata_update', 'false', true);
      end if;
      return v_attendance;
    end if;

    if v_attendance.review_status not in ('pending', 'corrected') then
      raise exception 'Only pending or corrected attendance can be approved.';
    end if;

    v_effective_clock_in := coalesce(v_attendance.billed_clock_in, v_attendance.clock_in);
    v_effective_clock_out := coalesce(v_attendance.billed_clock_out, v_attendance.clock_out);

    if v_attendance.attendance_status = 'present'
       and (v_effective_clock_in is null or v_effective_clock_out is null) then
      raise exception 'Completed billed clock-in and billed clock-out values are required before approval.';
    end if;

    if v_effective_clock_out is not null then
      if v_effective_clock_in is null or v_effective_clock_out < v_effective_clock_in then
        raise exception 'Canonical billed clock-out cannot be earlier than billed clock-in.';
      end if;

      if v_attendance.pre_shift_overtime_minutes is null
         or v_attendance.regular_minutes is null
         or v_attendance.post_shift_overtime_minutes is null then
        raise exception 'Attendance calculations must be complete before approval.';
      end if;

      v_canonical_billed_minutes := floor(
        extract(epoch from (v_effective_clock_out - v_effective_clock_in)) / 60
      )::integer;

      if v_attendance.total_worked_minutes is distinct from v_canonical_billed_minutes
         or coalesce(v_attendance.regular_minutes, 0)
              + coalesce(v_attendance.total_overtime_minutes, 0)
            is distinct from v_canonical_billed_minutes
         or v_attendance.total_overtime_minutes is distinct from (
              v_attendance.pre_shift_overtime_minutes
              + v_attendance.post_shift_overtime_minutes
              + v_attendance.rest_day_overtime_minutes
              + v_attendance.holiday_overtime_minutes
            ) then
        raise exception 'Attendance calculations must match canonical billed duration before approval.';
      end if;
    end if;
  elsif v_attendance.review_status <> 'approved' then
    raise exception 'Attendance must be approved before it can be locked.';
  end if;

  -- This is still a normal attendance UPDATE. The local setting only prevents
  -- the metadata-only approval/lock update from replacing canonical billed
  -- total_worked_minutes with the raw clock duration. Lock protection,
  -- constraints, audit triggers, and RLS remain active.
  perform set_config('workforce.review_metadata_update', 'true', true);
  update public.attendance
  set review_status = p_review_status,
      payroll_approved_at = case
        when p_review_status = 'approved'
          then coalesce(v_attendance.payroll_approved_at, now())
        else v_attendance.payroll_approved_at
      end,
      reviewed_by = v_actor_user_id,
      reviewed_at = now(),
      updated_by = v_actor_user_id,
      updated_at = now()
  where id = v_attendance.id
  returning * into v_result;
  perform set_config('workforce.review_metadata_update', 'false', true);

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
      'payroll_approved_at', v_attendance.payroll_approved_at,
      'reviewed_by', v_attendance.reviewed_by,
      'reviewed_at', v_attendance.reviewed_at
    ),
    jsonb_build_object(
      'attendance_id', v_result.id,
      'employee_user_id', v_result.user_id,
      'work_date', v_result.work_date,
      'review_status', v_result.review_status,
      'payroll_approved_at', v_result.payroll_approved_at,
      'reviewed_by', v_result.reviewed_by,
      'reviewed_at', v_result.reviewed_at
    ),
    coalesce(v_review_notes, concat('Attendance ', p_review_status, ' through Team Attendance'))
  );

  return v_result;
end;
$$;

comment on function public.workforce_review_attendance(uuid, text, text) is
  'Approves or locks attendance after validating canonical billed duration and preserving existing lock protections.';

revoke all on function public.workforce_review_attendance(uuid, text, text) from public, anon;
grant execute on function public.workforce_review_attendance(uuid, text, text) to authenticated;

commit;
