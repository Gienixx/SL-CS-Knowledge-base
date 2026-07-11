-- Phase 1, Step 8: extend attendance with payroll-sensitive storage fields.
--
-- This migration is additive. It preserves clock_in, clock_out, overtime_minutes,
-- and the current attendance RPC contracts while introducing immutable original
-- timestamps, structured minute fields, and review metadata for later correction
-- and payroll workflows.

begin;

alter table public.attendance
  add column if not exists original_clock_in timestamptz,
  add column if not exists original_clock_out timestamptz,
  add column if not exists pre_shift_overtime_minutes integer,
  add column if not exists regular_minutes integer,
  add column if not exists post_shift_overtime_minutes integer,
  add column if not exists total_overtime_minutes integer not null default 0,
  add column if not exists total_worked_minutes integer not null default 0,
  add column if not exists is_corrected boolean not null default false,
  add column if not exists review_status text not null default 'pending',
  add column if not exists reviewed_by uuid,
  add column if not exists reviewed_at timestamptz;

comment on column public.attendance.original_clock_in is
  'First recorded clock-in. Immutable after capture; effective clock_in may be corrected later.';
comment on column public.attendance.original_clock_out is
  'First recorded clock-out. Immutable after capture; effective clock_out may be corrected later.';
comment on column public.attendance.pre_shift_overtime_minutes is
  'Credited worked minutes before the assigned shift start. Null means structured recalculation is still pending.';
comment on column public.attendance.regular_minutes is
  'Worked minutes overlapping the assigned scheduled shift. Null means structured recalculation is still pending.';
comment on column public.attendance.post_shift_overtime_minutes is
  'Credited worked minutes after the assigned shift end. Null means structured recalculation is still pending.';
comment on column public.attendance.total_overtime_minutes is
  'Credited pre-shift plus post-shift overtime. Kept compatible with legacy overtime_minutes.';
comment on column public.attendance.total_worked_minutes is
  'Elapsed effective clock-in to effective clock-out in whole minutes; zero while the session is open.';
comment on column public.attendance.is_corrected is
  'True when effective timestamps differ from captured originals or correction metadata exists.';
comment on column public.attendance.review_status is
  'Attendance review state: pending, approved, corrected, rejected, or locked.';
comment on column public.attendance.reviewed_by is
  'Workforce user that performed the latest attendance review.';
comment on column public.attendance.reviewed_at is
  'Timestamp of the latest attendance review.';

-- Existing aggregate overtime remains authoritative until Step 9 introduces the
-- trusted structured calculation function. Do not fabricate historical pre/post
-- splits where the source record did not preserve them.
update public.attendance attendance_row
set original_clock_in = case
      when attendance_row.original_clock_in is not null then attendance_row.original_clock_in
      when attendance_row.corrected_by is not null
        or attendance_row.corrected_at is not null
        or nullif(trim(coalesce(attendance_row.correction_reason, '')), '') is not null
        then null
      else attendance_row.clock_in
    end,
    original_clock_out = case
      when attendance_row.original_clock_out is not null then attendance_row.original_clock_out
      when attendance_row.corrected_by is not null
        or attendance_row.corrected_at is not null
        or nullif(trim(coalesce(attendance_row.correction_reason, '')), '') is not null
        then null
      else attendance_row.clock_out
    end,
    total_overtime_minutes = greatest(coalesce(attendance_row.overtime_minutes, 0), 0),
    total_worked_minutes = case
      when attendance_row.clock_in is not null
        and attendance_row.clock_out is not null
        and attendance_row.clock_out >= attendance_row.clock_in
        then floor(extract(epoch from (attendance_row.clock_out - attendance_row.clock_in)) / 60)::integer
      else 0
    end,
    is_corrected = attendance_row.is_corrected
      or attendance_row.corrected_by is not null
      or attendance_row.corrected_at is not null
      or nullif(trim(coalesce(attendance_row.correction_reason, '')), '') is not null;

create or replace function public.workforce_prepare_attendance_storage()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_legacy_overtime_changed boolean := false;
  v_total_overtime_changed boolean := false;
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
    or new.corrected_by is not null
    or new.corrected_at is not null
    or nullif(trim(coalesce(new.correction_reason, '')), '') is not null;

  return new;
end;
$$;

drop trigger if exists attendance_prepare_storage on public.attendance;
create trigger attendance_prepare_storage
before insert or update on public.attendance
for each row execute function public.workforce_prepare_attendance_storage();

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'attendance_structured_minutes_nonnegative'
      and conrelid = 'public.attendance'::regclass
  ) then
    alter table public.attendance
      add constraint attendance_structured_minutes_nonnegative check (
        (pre_shift_overtime_minutes is null or pre_shift_overtime_minutes >= 0)
        and (regular_minutes is null or regular_minutes >= 0)
        and (post_shift_overtime_minutes is null or post_shift_overtime_minutes >= 0)
        and total_overtime_minutes >= 0
        and total_worked_minutes >= 0
      ) not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'attendance_review_status_check'
      and conrelid = 'public.attendance'::regclass
  ) then
    alter table public.attendance
      add constraint attendance_review_status_check check (
        review_status in ('pending', 'approved', 'corrected', 'rejected', 'locked')
      ) not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'attendance_review_metadata_pair_check'
      and conrelid = 'public.attendance'::regclass
  ) then
    alter table public.attendance
      add constraint attendance_review_metadata_pair_check check (
        (reviewed_by is null and reviewed_at is null)
        or (reviewed_by is not null and reviewed_at is not null)
      ) not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'attendance_original_clock_order_check'
      and conrelid = 'public.attendance'::regclass
  ) then
    alter table public.attendance
      add constraint attendance_original_clock_order_check check (
        original_clock_out is null
        or (original_clock_in is not null and original_clock_out >= original_clock_in)
      ) not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'attendance_total_overtime_legacy_match'
      and conrelid = 'public.attendance'::regclass
  ) then
    alter table public.attendance
      add constraint attendance_total_overtime_legacy_match check (
        total_overtime_minutes = overtime_minutes
      ) not valid;
  end if;
end
$$;

alter table public.attendance
  validate constraint attendance_structured_minutes_nonnegative;
alter table public.attendance
  validate constraint attendance_review_status_check;
alter table public.attendance
  validate constraint attendance_review_metadata_pair_check;
alter table public.attendance
  validate constraint attendance_original_clock_order_check;
alter table public.attendance
  validate constraint attendance_total_overtime_legacy_match;

create index if not exists attendance_review_status_date_idx
  on public.attendance (review_status, work_date desc);

create index if not exists attendance_corrected_date_idx
  on public.attendance (work_date desc, is_corrected)
  where is_corrected is true;

create index if not exists attendance_reviewed_by_at_idx
  on public.attendance (reviewed_by, reviewed_at desc)
  where reviewed_by is not null;

insert into public.workforce_audit_logs (
  actor_user_id,
  action,
  entity_type,
  after_data,
  reason
) values (
  auth.uid(),
  'attendance_review_storage_added',
  'attendance',
  jsonb_build_object(
    'original_timestamps_immutable', true,
    'structured_minute_columns_added', true,
    'legacy_overtime_compatibility_preserved', true,
    'review_statuses', jsonb_build_array('pending', 'approved', 'corrected', 'rejected', 'locked'),
    'historical_structured_recalculation_pending_step_9', true
  ),
  'Added Phase 1 Step 8 attendance storage and review fields'
);

commit;
