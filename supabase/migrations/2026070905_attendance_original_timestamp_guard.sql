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
  v_is_correction boolean := false;
begin
  v_is_correction :=
    new.corrected_by is not null
    or new.corrected_at is not null
    or nullif(trim(coalesce(new.correction_reason, '')), '') is not null;

  if tg_op = 'INSERT' then
    if new.original_clock_in is null
       and new.clock_in is not null
       and not v_is_correction then
      new.original_clock_in := new.clock_in;
    end if;

    if new.original_clock_out is null
       and new.clock_out is not null
       and not v_is_correction then
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
       and not v_is_correction then
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
       and not v_is_correction then
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
    or v_is_correction;

  return new;
end;
$$;

comment on function public.workforce_prepare_attendance_storage() is
  'Captures immutable original timestamps for self-service clock actions while preserving null originals when administrators supply missing values through corrections.';

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
    'original_timestamps_remain_immutable', true
  ),
  'Updated original timestamp handling for the Step 12 correction workflow'
);

commit;
