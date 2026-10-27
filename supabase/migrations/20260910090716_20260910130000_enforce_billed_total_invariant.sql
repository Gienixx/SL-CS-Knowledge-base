-- Enforce the canonical billed-duration invariant at the attendance write boundary.
-- A later metadata/classification update must not resurrect raw captured duration.

begin;

create or replace function public.workforce_prepare_attendance_storage()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_legacy_overtime_changed boolean := false;
  v_total_overtime_changed boolean := false;
  v_correction_recalculation boolean := coalesce(current_setting('workforce.correction_recalculation', true), '') = 'true';
  v_review_metadata_update boolean := coalesce(current_setting('workforce.review_metadata_update', true), '') = 'true';
  v_effective_clock_in timestamptz;
  v_effective_clock_out timestamptz;
begin
  if tg_op = 'INSERT' then
    if new.original_clock_in is null and new.clock_in is not null then new.original_clock_in := new.clock_in; end if;
    if new.original_clock_out is null and new.clock_out is not null then new.original_clock_out := new.clock_out; end if;
    if coalesce(new.overtime_minutes, 0) <> new.total_overtime_minutes then
      if new.total_overtime_minutes = 0 then new.total_overtime_minutes := coalesce(new.overtime_minutes, 0);
      elsif coalesce(new.overtime_minutes, 0) = 0 then new.overtime_minutes := new.total_overtime_minutes;
      else raise exception 'overtime_minutes and total_overtime_minutes must match.'; end if;
    end if;
  else
    if old.original_clock_in is not null then
      if new.original_clock_in is distinct from old.original_clock_in then raise exception 'original_clock_in is immutable after capture.'; end if;
    elsif old.clock_in is null and new.clock_in is not null then new.original_clock_in := new.clock_in;
    elsif new.original_clock_in is not null then raise exception 'original_clock_in cannot be supplied after the initial clock-in.'; end if;
    if old.original_clock_out is not null then
      if new.original_clock_out is distinct from old.original_clock_out then raise exception 'original_clock_out is immutable after capture.'; end if;
    elsif old.clock_out is null and new.clock_out is not null then new.original_clock_out := new.clock_out;
    elsif new.original_clock_out is not null then raise exception 'original_clock_out cannot be supplied after the initial clock-out.'; end if;
    v_legacy_overtime_changed := new.overtime_minutes is distinct from old.overtime_minutes;
    v_total_overtime_changed := new.total_overtime_minutes is distinct from old.total_overtime_minutes;
    if v_legacy_overtime_changed and v_total_overtime_changed then
      if coalesce(new.overtime_minutes, 0) <> new.total_overtime_minutes then raise exception 'overtime_minutes and total_overtime_minutes must match.'; end if;
    elsif v_legacy_overtime_changed then new.total_overtime_minutes := coalesce(new.overtime_minutes, 0);
    elsif v_total_overtime_changed then new.overtime_minutes := new.total_overtime_minutes; end if;
  end if;

  if not v_correction_recalculation and not v_review_metadata_update then
    -- billed_* is authoritative only as a complete pair. Never combine one
    -- billed endpoint with one captured endpoint accidentally.
    if new.billed_clock_in is not null and new.billed_clock_out is not null then
      v_effective_clock_in := new.billed_clock_in;
      v_effective_clock_out := new.billed_clock_out;
    else
      v_effective_clock_in := new.clock_in;
      v_effective_clock_out := new.clock_out;
    end if;
    if v_effective_clock_in is not null and v_effective_clock_out is not null then
      if v_effective_clock_out < v_effective_clock_in then raise exception 'Billed clock-out cannot be earlier than billed clock-in.'; end if;
      new.total_worked_minutes := floor(extract(epoch from (v_effective_clock_out - v_effective_clock_in)) / 60)::integer;
    else new.total_worked_minutes := 0; end if;
  end if;

  new.is_corrected :=
    (new.original_clock_in is not null and new.clock_in is distinct from new.original_clock_in)
    or (new.original_clock_out is not null and new.clock_out is distinct from new.original_clock_out)
    or new.corrected_by is not null or new.corrected_at is not null
    or nullif(trim(coalesce(new.correction_reason, '')), '') is not null;
  return new;
end;
$$;

comment on function public.workforce_prepare_attendance_storage() is
  'Maintains attendance storage invariants and derives total_worked_minutes from billed timestamps when present.';

commit;

;
