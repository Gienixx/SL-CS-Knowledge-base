-- Phase 1, Step 12: authorized attendance correction workflow.
--
-- Adds a security-definer correction transaction, correction-specific schedule
-- lookup, trusted recalculation, review-state updates, and explicit before/after
-- audit logging. Structured correction history remains a Step 13 deliverable.

begin;

-- Attendance mutations must go through trusted RPCs. Self-service clock actions
-- and administrative corrections are already security-definer functions.
drop policy if exists "Authorized users can insert attendance" on public.attendance;
drop policy if exists "Authorized users can update attendance" on public.attendance;
drop policy if exists "Authorized users can delete attendance" on public.attendance;

revoke insert, update, delete on public.attendance from authenticated;
grant select on public.attendance to authenticated;

create or replace function public.workforce_list_attendance_correction_schedules(
  p_attendance_id uuid
)
returns table (
  schedule_id uuid,
  shift_sequence smallint,
  shift_start timestamptz,
  shift_end timestamptz,
  timezone text,
  status text,
  is_current boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_attendance public.attendance%rowtype;
begin
  if p_attendance_id is null then
    raise exception 'Attendance record is required.';
  end if;

  select attendance_row.*
  into v_attendance
  from public.attendance attendance_row
  where attendance_row.id = p_attendance_id;

  if not found then
    raise exception 'Attendance record not found.';
  end if;

  if not public.workforce_can_correct_attendance(v_attendance.user_id) then
    raise exception 'You do not have permission to correct this attendance record.' using errcode = '42501';
  end if;

  return query
  select
    schedule.id,
    schedule.shift_sequence,
    schedule.shift_start,
    schedule.shift_end,
    schedule.timezone,
    schedule.status,
    schedule.id = v_attendance.schedule_id
  from public.work_schedules schedule
  where schedule.user_id = v_attendance.user_id
    and schedule.shift_date = v_attendance.work_date
    and schedule.is_rest_day is false
    and schedule.shift_start is not null
    and schedule.shift_end is not null
    and (
      schedule.status in ('published', 'changed', 'completed')
      or schedule.id = v_attendance.schedule_id
    )
  order by schedule.shift_start, schedule.shift_sequence;
end;
$$;

comment on function public.workforce_list_attendance_correction_schedules(uuid) is
  'Returns correction-eligible schedules for the attendance employee and preserved work date.';

create or replace function public.workforce_correct_attendance(
  p_attendance_id uuid,
  p_clock_in_local timestamp without time zone,
  p_clock_out_local timestamp without time zone,
  p_attendance_status text,
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
  v_actor_profile_id uuid := public.workforce_current_profile_id();
  v_target_user_id uuid;
  v_attendance public.attendance%rowtype;
  v_schedule public.work_schedules%rowtype;
  v_employee_timezone text;
  v_clock_in timestamptz;
  v_clock_out timestamptz;
  v_reason_code text := nullif(trim(coalesce(p_reason_code, '')), '');
  v_reason_notes text := nullif(trim(coalesce(p_reason_notes, '')), '');
  v_admin_notes text := nullif(trim(coalesce(p_admin_notes, '')), '');
  v_before jsonb;
  v_after jsonb;
  v_review_status text;
  v_result public.attendance%rowtype;
begin
  if auth.uid() is null or v_actor_profile_id is null then
    raise exception 'Authentication and an active workforce profile are required.' using errcode = '42501';
  end if;

  if p_attendance_id is null then
    raise exception 'Attendance record is required.';
  end if;

  select attendance_row.user_id
  into v_target_user_id
  from public.attendance attendance_row
  where attendance_row.id = p_attendance_id;

  if not found then
    raise exception 'Attendance record not found.';
  end if;

  if not public.workforce_can_correct_attendance(v_target_user_id) then
    raise exception 'You do not have permission to correct this attendance record.' using errcode = '42501';
  end if;

  if v_reason_code not in (
    'forgot_clock_in',
    'forgot_clock_out',
    'system_issue',
    'connection_issue',
    'incorrect_schedule',
    'approved_overtime',
    'manager_confirmed',
    'other'
  ) then
    raise exception 'A valid correction reason is required.';
  end if;

  if v_reason_code = 'other' and v_reason_notes is null then
    raise exception 'Written notes are required when the correction reason is Other.';
  end if;

  if p_attendance_status not in ('present', 'absent', 'on_leave', 'excused') then
    raise exception 'A valid attendance status is required.';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_target_user_id::text)::bigint);

  select attendance_row.*
  into v_attendance
  from public.attendance attendance_row
  where attendance_row.id = p_attendance_id
  for update;

  if v_attendance.review_status = 'locked' then
    raise exception 'Locked attendance cannot be corrected.';
  end if;

  select coalesce(nullif(profile.timezone, ''), 'America/New_York')
  into v_employee_timezone
  from public.profiles profile
  where profile.user_id = v_attendance.user_id;

  if v_employee_timezone is null then
    raise exception 'The employee profile timezone is unavailable.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_timezone_names timezone_row
    where timezone_row.name = v_employee_timezone
  ) then
    raise exception 'The employee profile does not contain a valid IANA timezone.';
  end if;

  v_clock_in := case
    when p_clock_in_local is null then null
    else p_clock_in_local at time zone v_employee_timezone
  end;

  v_clock_out := case
    when p_clock_out_local is null then null
    else p_clock_out_local at time zone v_employee_timezone
  end;

  if p_attendance_status = 'present' then
    if v_clock_in is null then
      raise exception 'Present attendance requires an effective clock-in.';
    end if;

    if v_clock_out is not null and v_clock_out < v_clock_in then
      raise exception 'Clock-out cannot be earlier than clock-in.';
    end if;
  elsif v_clock_in is not null or v_clock_out is not null then
    raise exception 'Absent, on-leave, and excused attendance must not contain clock timestamps.';
  end if;

  if p_schedule_id is not null then
    select schedule.*
    into v_schedule
    from public.work_schedules schedule
    where schedule.id = p_schedule_id
    for share;

    if not found then
      raise exception 'Selected schedule was not found.';
    end if;

    if v_schedule.user_id <> v_attendance.user_id then
      raise exception 'Selected schedule belongs to another employee.';
    end if;

    if v_schedule.shift_date <> v_attendance.work_date then
      raise exception 'Selected schedule must preserve the attendance work date.';
    end if;

    if v_schedule.is_rest_day
       or v_schedule.shift_start is null
       or v_schedule.shift_end is null
       or v_schedule.status not in ('published', 'changed', 'completed') then
      raise exception 'Selected schedule is not eligible for attendance correction.';
    end if;

    if exists (
      select 1
      from public.attendance other_attendance
      where other_attendance.user_id = v_attendance.user_id
        and other_attendance.schedule_id = p_schedule_id
        and other_attendance.id <> v_attendance.id
    ) then
      raise exception 'Another attendance record is already linked to the selected schedule.';
    end if;
  elsif exists (
    select 1
    from public.attendance other_attendance
    where other_attendance.user_id = v_attendance.user_id
      and other_attendance.work_date = v_attendance.work_date
      and other_attendance.schedule_id is null
      and other_attendance.id <> v_attendance.id
  ) then
    raise exception 'Another unscheduled attendance record already exists for this work date.';
  end if;

  if v_clock_in is not null and exists (
    select 1
    from public.attendance other_attendance
    where other_attendance.user_id = v_attendance.user_id
      and other_attendance.id <> v_attendance.id
      and other_attendance.clock_in is not null
      and coalesce(v_clock_out, 'infinity'::timestamptz) > other_attendance.clock_in
      and coalesce(other_attendance.clock_out, 'infinity'::timestamptz) > v_clock_in
  ) then
    raise exception 'Corrected attendance cannot overlap another attendance session.';
  end if;

  v_before := to_jsonb(v_attendance);
  v_review_status := case
    when public.workforce_can_approve_attendance(v_attendance.user_id)
      and (
        p_attendance_status <> 'present'
        or (v_clock_in is not null and v_clock_out is not null)
      ) then 'approved'
    else 'corrected'
  end;

  update public.attendance
  set schedule_id = p_schedule_id,
      clock_in = v_clock_in,
      clock_out = v_clock_out,
      attendance_status = p_attendance_status,
      pre_shift_overtime_minutes = case when p_attendance_status = 'present' then null else 0 end,
      regular_minutes = case when p_attendance_status = 'present' then null else 0 end,
      post_shift_overtime_minutes = case when p_attendance_status = 'present' then null else 0 end,
      total_overtime_minutes = 0,
      overtime_minutes = 0,
      total_worked_minutes = 0,
      is_late = false,
      minutes_late = 0,
      undertime_minutes = 0,
      correction_reason = v_reason_code,
      admin_notes = v_admin_notes,
      corrected_by = v_actor_profile_id,
      corrected_at = now(),
      review_status = v_review_status,
      reviewed_by = v_actor_profile_id,
      reviewed_at = now(),
      updated_by = v_actor_profile_id
  where id = v_attendance.id;

  -- Recalculate all scheduled shifts on the work date so overtime allocation
  -- remains capped and deterministic after a schedule or timestamp correction.
  perform public.workforce_recalculate_attendance_work_date(
    v_attendance.user_id,
    v_attendance.work_date
  );

  if p_attendance_status = 'present' and p_schedule_id is null then
    perform public.workforce_recalculate_attendance(v_attendance.id);
  elsif p_attendance_status <> 'present' then
    update public.attendance
    set pre_shift_overtime_minutes = 0,
        regular_minutes = 0,
        post_shift_overtime_minutes = 0,
        total_overtime_minutes = 0,
        overtime_minutes = 0,
        total_worked_minutes = 0,
        is_late = false,
        minutes_late = 0,
        undertime_minutes = 0
    where id = v_attendance.id;
  end if;

  select attendance_row.*
  into v_result
  from public.attendance attendance_row
  where attendance_row.id = v_attendance.id;

  v_after := to_jsonb(v_result);

  insert into public.workforce_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    before_data,
    after_data,
    reason
  ) values (
    v_actor_profile_id,
    'attendance_corrected',
    'attendance',
    v_attendance.id,
    v_before,
    v_after || jsonb_build_object(
      'reason_code', v_reason_code,
      'reason_notes', v_reason_notes,
      'auto_approved', v_review_status = 'approved'
    ),
    concat_ws(': ', v_reason_code, v_reason_notes)
  );

  return v_result;
end;
$$;

comment on function public.workforce_correct_attendance(
  uuid, timestamp without time zone, timestamp without time zone, text, uuid, text, text, text
) is
  'Corrects effective attendance values through an authorized, audited transaction and recalculates the employee work date.';

revoke all on function public.workforce_list_attendance_correction_schedules(uuid) from public;
revoke all on function public.workforce_list_attendance_correction_schedules(uuid) from anon;
revoke all on function public.workforce_list_attendance_correction_schedules(uuid) from authenticated;
grant execute on function public.workforce_list_attendance_correction_schedules(uuid) to authenticated;

revoke all on function public.workforce_correct_attendance(
  uuid, timestamp without time zone, timestamp without time zone, text, uuid, text, text, text
) from public;
revoke all on function public.workforce_correct_attendance(
  uuid, timestamp without time zone, timestamp without time zone, text, uuid, text, text, text
) from anon;
revoke all on function public.workforce_correct_attendance(
  uuid, timestamp without time zone, timestamp without time zone, text, uuid, text, text, text
) from authenticated;
grant execute on function public.workforce_correct_attendance(
  uuid, timestamp without time zone, timestamp without time zone, text, uuid, text, text, text
) to authenticated;

insert into public.workforce_audit_logs (
  actor_user_id,
  action,
  entity_type,
  after_data,
  reason
) values (
  auth.uid(),
  'attendance_correction_workflow_added',
  'attendance',
  jsonb_build_object(
    'direct_table_mutations_revoked', true,
    'mandatory_reason_codes', true,
    'other_requires_notes', true,
    'previous_values_preserved_in_audit_log', true,
    'structured_history_deferred_to_step_13', true,
    'trusted_recalculation', true,
    'aggregate_overtime_cap_enforced', true,
    'auto_approval_requires_approve_attendance', true
  ),
  'Added Phase 1 Step 12 attendance correction workflow'
);

commit;
