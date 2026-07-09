-- Phase 1, Step 12: preserve missing original timestamps during corrections.
--
-- Self-service clock-in and clock-out still capture immutable originals. An
-- administrative correction that supplies a previously missing timestamp must
-- leave the original value null so the system does not rewrite history.

begin;

create or replace function public.workforce_prepare_attendance_storage()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_legacy_overtime_changed boolean := false;
  v_total_overtime_changed boolean := false;
  v_is_correction_action boolean := false;
  v_has_correction_metadata boolean := false;
  v_correction_reason text := nullif(trim(coalesce(new.correction_reason, '')), '');
begin
  v_has_correction_metadata :=
    new.corrected_by is not null
    or new.corrected_at is not null
    or v_correction_reason is not null;

  v_is_correction_action := case
    when tg_op = 'INSERT' then v_has_correction_metadata
    else
      new.corrected_by is distinct from old.corrected_by
      or new.corrected_at is distinct from old.corrected_at
      or new.correction_reason is distinct from old.correction_reason
      or new.admin_notes is distinct from old.admin_notes
  end;

  if v_is_correction_action and (
    v_correction_reason is null
    or v_correction_reason not in (
      'forgot_clock_in',
      'forgot_clock_out',
      'system_issue',
      'connection_issue',
      'incorrect_schedule',
      'approved_overtime',
      'manager_confirmed',
      'other'
    )
  ) then
    raise exception 'A valid correction reason is required.';
  end if;

  if tg_op = 'INSERT' then
    if new.original_clock_in is null
       and new.clock_in is not null
       and not v_is_correction_action then
      new.original_clock_in := new.clock_in;
    end if;

    if new.original_clock_out is null
       and new.clock_out is not null
       and not v_is_correction_action then
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
    elsif new.original_clock_in is not null then
      raise exception 'original_clock_in cannot be supplied after the initial clock-in.';
    elsif old.clock_in is null
       and new.clock_in is not null
       and not v_is_correction_action then
      new.original_clock_in := new.clock_in;
    end if;

    if old.original_clock_out is not null then
      if new.original_clock_out is distinct from old.original_clock_out then
        raise exception 'original_clock_out is immutable after capture.';
      end if;
    elsif new.original_clock_out is not null then
      raise exception 'original_clock_out cannot be supplied after the initial clock-out.';
    elsif old.clock_out is null
       and new.clock_out is not null
       and not v_is_correction_action then
      new.original_clock_out := new.clock_out;
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

  new.is_corrected :=
    (
      new.original_clock_in is not null
      and new.clock_in is distinct from new.original_clock_in
    )
    or (
      new.original_clock_out is not null
      and new.clock_out is distinct from new.original_clock_out
    )
    or v_has_correction_metadata;

  return new;
end;
$$;

comment on function public.workforce_prepare_attendance_storage() is
  'Captures immutable original timestamps for genuine clock actions, preserves null originals during correction actions, validates correction reason codes, and retains correction status on later updates.';

insert into public.workforce_audit_logs (
  actor_user_id,
  action,
  entity_type,
  after_data,
  reason
) values (
  auth.uid(),
  'attendance_original_timestamp_guard_updated',
  'attendance',
  jsonb_build_object(
    'self_service_original_capture_preserved', true,
    'corrections_do_not_rewrite_missing_originals', true,
    'later_self_service_clock_out_capture_preserved', true,
    'corrected_status_persists', true,
    'correction_reason_codes_enforced', true,
    'original_timestamps_remain_immutable', true
  ),
  'Updated original timestamp and correction reason handling for the Step 12 correction workflow'
);

commit;
