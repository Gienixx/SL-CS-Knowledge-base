-- Step 1: separate immutable capture timestamps from payroll-approved values.
-- Billed timestamps are edited only through the existing audited correction RPC.

begin;

alter table public.attendance
  add column if not exists billed_clock_in timestamptz,
  add column if not exists billed_clock_out timestamptz;

alter table public.attendance disable trigger zz_attendance_locked_immutable;

update public.attendance
set billed_clock_in = clock_in,
    billed_clock_out = clock_out
where billed_clock_in is null and clock_in is not null
   or billed_clock_out is null and clock_out is not null;

alter table public.attendance enable trigger zz_attendance_locked_immutable;

alter table public.attendance
  add constraint attendance_billed_clock_order_check
  check (billed_clock_out is null or (billed_clock_in is not null and billed_clock_out >= billed_clock_in));

comment on column public.attendance.billed_clock_in is
  'Manager-adjustable payroll timestamp; original_clock_in is immutable.';
comment on column public.attendance.billed_clock_out is
  'Manager-adjustable payroll timestamp; original_clock_out is immutable.';

alter table public.attendance_corrections
  add column if not exists previous_billed_clock_in timestamptz,
  add column if not exists previous_billed_clock_out timestamptz,
  add column if not exists new_billed_clock_in timestamptz,
  add column if not exists new_billed_clock_out timestamptz;

-- Keep the existing correction entry point and permission model, but make its
-- timestamp arguments apply to billed values. Approval/review metadata is
-- deliberately preserved; approval means the billed values are approved.
alter function public.workforce_correct_attendance(uuid, timestamptz, timestamptz, text, uuid, text, text, text)
  rename to workforce_correct_attendance_legacy;

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
  v_reason text := nullif(trim(coalesce(p_reason_notes, '')), '');
begin
  if v_actor is null then raise exception 'Authenticated session is required.'; end if;
  if not public.workforce_current_user_is_active()
     or not public.workforce_can_correct_attendance(public.workforce_current_profile_id()) then
    raise exception 'You do not have permission to correct attendance.';
  end if;
  if p_attendance_id is null then raise exception 'Attendance record is required.'; end if;
  if p_new_status not in ('present', 'absent', 'on_leave', 'excused') then
    raise exception 'Attendance status is invalid.';
  end if;
  if p_new_clock_out is not null and (p_new_clock_in is null or p_new_clock_out < p_new_clock_in) then
    raise exception 'Billed clock-out cannot be earlier than billed clock-in.';
  end if;
  if nullif(trim(coalesce(p_reason_code, '')), '') is null then
    raise exception 'A correction reason is required.';
  end if;
  if p_reason_code = 'other' and v_reason is null then
    raise exception 'Written notes are required when reason is other.';
  end if;

  select * into v_old from public.attendance where id = p_attendance_id for update;
  if not found then raise exception 'Attendance record not found.'; end if;
  if v_old.review_status = 'locked' then raise exception 'Locked attendance cannot be changed.'; end if;
  if not public.workforce_can_manage_user(v_old.user_id, 'correct_attendance') then
    raise exception 'You do not have permission to manage this employee.';
  end if;

  update public.attendance
  set billed_clock_in = p_new_clock_in,
      billed_clock_out = p_new_clock_out,
      attendance_status = p_new_status,
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

  insert into public.attendance_corrections (
    attendance_id, employee_user_id, schedule_id,
    previous_clock_in, previous_clock_out, new_clock_in, new_clock_out,
    previous_billed_clock_in, previous_billed_clock_out,
    new_billed_clock_in, new_billed_clock_out,
    previous_status, new_status, reason_code, reason_notes,
    corrected_by, corrected_at
  ) values (
    v_new.id, v_new.user_id, v_new.schedule_id,
    v_old.original_clock_in, v_old.original_clock_out,
    v_new.original_clock_in, v_new.original_clock_out,
    v_old.billed_clock_in, v_old.billed_clock_out,
    v_new.billed_clock_in, v_new.billed_clock_out,
    v_old.attendance_status, v_new.attendance_status, p_reason_code, v_reason,
    v_actor, now()
  );

  insert into public.workforce_audit_logs
    (actor_user_id, action, entity_type, entity_id, before_data, after_data, reason)
  values (
    v_actor, 'attendance_billed_time_corrected', 'attendance', v_new.id,
    jsonb_build_object('original_clock_in', v_old.original_clock_in,
      'original_clock_out', v_old.original_clock_out,
      'billed_clock_in', v_old.billed_clock_in,
      'billed_clock_out', v_old.billed_clock_out,
      'review_status', v_old.review_status),
    jsonb_build_object('original_clock_in', v_new.original_clock_in,
      'original_clock_out', v_new.original_clock_out,
      'billed_clock_in', v_new.billed_clock_in,
      'billed_clock_out', v_new.billed_clock_out,
      'review_status', v_new.review_status),
    coalesce(v_reason, p_reason_code)
  );
  return v_new;
end;
$$;

revoke all on function public.workforce_correct_attendance(uuid, timestamptz, timestamptz, text, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.workforce_correct_attendance(uuid, timestamptz, timestamptz, text, uuid, text, text, text)
  to authenticated;

-- The existing approval gate must validate the payroll values, not captures.
create or replace function public.workforce_review_attendance(
  p_attendance_id uuid, p_review_status text, p_review_notes text default null
)
returns public.attendance
language plpgsql security definer set search_path = ''
as $$
declare v_actor uuid := public.workforce_current_profile_id(); v_row public.attendance%rowtype;
begin
  if v_actor is null then raise exception 'Authenticated workforce profile is required.'; end if;
  if p_review_status not in ('approved', 'locked') then raise exception 'Review status must be approved or locked.'; end if;
  select * into v_row from public.attendance where id = p_attendance_id for update;
  if not found then raise exception 'Attendance record not found.'; end if;
  if not public.workforce_can_approve_attendance(v_row.user_id) then raise exception 'You do not have permission to approve this attendance record.'; end if;
  if v_row.review_status = 'locked' then
    if p_review_status = 'locked' then return v_row; end if;
    raise exception 'Locked attendance cannot be changed.';
  end if;
  if p_review_status = 'approved' then
    if v_row.review_status = 'approved' then return v_row; end if;
    if v_row.review_status not in ('pending', 'corrected') then raise exception 'Only pending or corrected attendance can be approved.'; end if;
    if v_row.attendance_status = 'present' and (v_row.billed_clock_in is null or v_row.billed_clock_out is null) then raise exception 'Completed billed clock-in and billed clock-out values are required before approval.'; end if;
  elsif v_row.review_status <> 'approved' then raise exception 'Attendance must be approved before it can be locked.';
  end if;
  update public.attendance set review_status = p_review_status, reviewed_by = v_actor, reviewed_at = now(), updated_by = v_actor, updated_at = now() where id = v_row.id returning * into v_row;
  return v_row;
end;
$$;

commit;
