-- Phase 1, Step 12: structured attendance correction workflow.
--
-- Adds a dedicated correction-history table plus a security-definer RPC that
-- allows authorized admins to correct effective attendance values, preserve
-- previous values, recalculate totals, and record a mandatory structured reason.

begin;

create table if not exists public.attendance_corrections (
  id uuid primary key default gen_random_uuid(),
  attendance_id uuid not null references public.attendance(id) on delete cascade,
  employee_user_id uuid not null references public.profiles(user_id) on delete restrict,
  schedule_id uuid references public.work_schedules(id) on delete set null,
  previous_clock_in timestamptz,
  previous_clock_out timestamptz,
  new_clock_in timestamptz,
  new_clock_out timestamptz,
  previous_status text not null,
  new_status text not null,
  previous_calculations jsonb,
  new_calculations jsonb,
  reason_code text not null,
  reason_notes text,
  corrected_by uuid not null references public.profiles(user_id) on delete restrict,
  corrected_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attendance_corrections_reason_code_check check (
    reason_code in (
      'forgot_clock_in',
      'forgot_clock_out',
      'system_issue',
      'connection_issue',
      'incorrect_schedule',
      'approved_overtime',
      'manager_confirmed',
      'other'
    )
  ),
  constraint attendance_corrections_reason_notes_check check (
    reason_code <> 'other' or length(trim(coalesce(reason_notes, ''))) > 0
  )
);

create index if not exists attendance_corrections_attendance_idx
  on public.attendance_corrections (attendance_id, corrected_at desc);
create index if not exists attendance_corrections_employee_idx
  on public.attendance_corrections (employee_user_id, corrected_at desc);

alter table public.attendance_corrections enable row level security;

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
  v_actor_user_id uuid := auth.uid();
  v_attendance public.attendance%rowtype;
  v_previous_calculations jsonb;
  v_new_calculations jsonb;
  v_schedule public.work_schedules%rowtype;
  v_current_profile public.profiles%rowtype;
  v_effective_clock_in timestamptz;
  v_effective_clock_out timestamptz;
  v_calculation record;
  v_work_date date;
  v_timezone text;
  v_available_overtime_minutes integer := 1200;
  v_result public.attendance%rowtype;
begin
  if v_actor_user_id is null then
    raise exception 'Authenticated session is required.';
  end if;

  if p_attendance_id is null then
    raise exception 'Attendance record is required.';
  end if;

  if p_new_status is null then
    raise exception 'Attendance status is required.';
  end if;

  if p_new_status not in ('present', 'absent', 'on_leave', 'excused') then
    raise exception 'Attendance status is invalid.';
  end if;

  if p_new_clock_in is not null and p_new_clock_out is not null and p_new_clock_out < p_new_clock_in then
    raise exception 'Clock-out cannot be earlier than clock-in.';
  end if;

  if p_reason_code is null then
    raise exception 'A correction reason is required.';
  end if;

  if p_reason_code not in (
    'forgot_clock_in',
    'forgot_clock_out',
    'system_issue',
    'connection_issue',
    'incorrect_schedule',
    'approved_overtime',
    'manager_confirmed',
    'other'
  ) then
    raise exception 'Reason code is invalid.';
  end if;

  if p_reason_code = 'other' and length(trim(coalesce(p_reason_notes, ''))) = 0 then
    raise exception 'Written notes are required when reason is other.';
  end if;

  select profile.*
  into v_current_profile
  from public.profiles profile
  where profile.user_id = v_actor_user_id;

  if not found then
    raise exception 'Active workforce profile not found.';
  end if;

  if not public.workforce_can_correct_attendance(v_current_profile.user_id) then
    raise exception 'You do not have permission to correct attendance.';
  end if;

  select attendance_row.*
  into v_attendance
  from public.attendance attendance_row
  where attendance_row.id = p_attendance_id
  for update;

  if not found then
    raise exception 'Attendance record not found.';
  end if;

  if p_schedule_id is not null then
    select schedule.*
    into v_schedule
    from public.work_schedules schedule
    where schedule.id = p_schedule_id;

    if not found then
      raise exception 'The selected schedule does not exist.';
    end if;

    if v_schedule.user_id <> v_attendance.user_id then
      raise exception 'The schedule does not belong to the same employee.';
    end if;
  end if;

  v_work_date := coalesce(v_attendance.work_date, current_date);
  v_timezone := coalesce(v_current_profile.timezone, 'America/New_York');

  select jsonb_build_object(
    'pre_shift_overtime_minutes', coalesce(v_attendance.pre_shift_overtime_minutes, 0),
    'regular_minutes', coalesce(v_attendance.regular_minutes, 0),
    'post_shift_overtime_minutes', coalesce(v_attendance.post_shift_overtime_minutes, 0),
    'total_overtime_minutes', coalesce(v_attendance.total_overtime_minutes, 0),
    'total_worked_minutes', coalesce(v_attendance.total_worked_minutes, 0),
    'minutes_late', coalesce(v_attendance.minutes_late, 0),
    'undertime_minutes', coalesce(v_attendance.undertime_minutes, 0)
  )
  into v_previous_calculations;

  v_effective_clock_in := p_new_clock_in;
  v_effective_clock_out := p_new_clock_out;

  if v_attendance.schedule_id is not null then
    select *
    into v_calculation
    from public.workforce_calculate_attendance(
      v_schedule.shift_start,
      v_schedule.shift_end,
      v_effective_clock_in,
      v_effective_clock_out,
      v_attendance.work_date,
      v_timezone,
      v_available_overtime_minutes
    );

    v_new_calculations := jsonb_build_object(
      'pre_shift_overtime_minutes', coalesce(v_calculation.pre_shift_overtime_minutes, 0),
      'regular_minutes', coalesce(v_calculation.regular_minutes, 0),
      'post_shift_overtime_minutes', coalesce(v_calculation.post_shift_overtime_minutes, 0),
      'total_overtime_minutes', coalesce(v_calculation.total_overtime_minutes, 0),
      'total_worked_minutes', coalesce(v_calculation.total_worked_minutes, 0),
      'minutes_late', coalesce(v_calculation.minutes_late, 0),
      'undertime_minutes', coalesce(v_calculation.undertime_minutes, 0)
    );
  else
    v_new_calculations := jsonb_build_object(
      'pre_shift_overtime_minutes', null,
      'regular_minutes', null,
      'post_shift_overtime_minutes', null,
      'total_overtime_minutes', 0,
      'total_worked_minutes', coalesce(floor(extract(epoch from (v_effective_clock_out - v_effective_clock_in)) / 60)::integer, 0),
      'minutes_late', 0,
      'undertime_minutes', 0
    );
  end if;

  update public.attendance
  set
    clock_in = p_new_clock_in,
    clock_out = p_new_clock_out,
    attendance_status = p_new_status,
    schedule_id = coalesce(p_schedule_id, schedule_id),
    admin_notes = coalesce(nullif(trim(coalesce(p_admin_notes, '')),''), admin_notes),
    correction_reason = p_reason_code,
    corrected_by = v_actor_user_id,
    corrected_at = now(),
    review_status = 'corrected',
    reviewed_by = v_actor_user_id,
    reviewed_at = now(),
    is_corrected = true,
    pre_shift_overtime_minutes = coalesce((v_new_calculations ->> 'pre_shift_overtime_minutes')::integer, null),
    regular_minutes = coalesce((v_new_calculations ->> 'regular_minutes')::integer, null),
    post_shift_overtime_minutes = coalesce((v_new_calculations ->> 'post_shift_overtime_minutes')::integer, null),
    total_overtime_minutes = coalesce((v_new_calculations ->> 'total_overtime_minutes')::integer, 0),
    total_worked_minutes = coalesce((v_new_calculations ->> 'total_worked_minutes')::integer, 0),
    minutes_late = coalesce((v_new_calculations ->> 'minutes_late')::integer, 0),
    undertime_minutes = coalesce((v_new_calculations ->> 'undertime_minutes')::integer, 0),
    updated_by = v_actor_user_id,
    updated_at = now()
  where id = v_attendance.id
  returning * into v_result;

  insert into public.attendance_corrections (
    attendance_id,
    employee_user_id,
    schedule_id,
    previous_clock_in,
    previous_clock_out,
    new_clock_in,
    new_clock_out,
    previous_status,
    new_status,
    previous_calculations,
    new_calculations,
    reason_code,
    reason_notes,
    corrected_by,
    corrected_at
  )
  values (
    v_result.id,
    v_result.user_id,
    v_result.schedule_id,
    v_attendance.clock_in,
    v_attendance.clock_out,
    v_result.clock_in,
    v_result.clock_out,
    v_attendance.attendance_status,
    v_result.attendance_status,
    v_previous_calculations,
    jsonb_build_object(
      'pre_shift_overtime_minutes', coalesce(v_result.pre_shift_overtime_minutes, 0),
      'regular_minutes', coalesce(v_result.regular_minutes, 0),
      'post_shift_overtime_minutes', coalesce(v_result.post_shift_overtime_minutes, 0),
      'total_overtime_minutes', coalesce(v_result.total_overtime_minutes, 0),
      'total_worked_minutes', coalesce(v_result.total_worked_minutes, 0),
      'minutes_late', coalesce(v_result.minutes_late, 0),
      'undertime_minutes', coalesce(v_result.undertime_minutes, 0)
    ),
    p_reason_code,
    p_reason_notes,
    v_actor_user_id,
    now()
  );

  insert into public.workforce_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    before_data,
    after_data,
    reason
  )
  values (
    v_actor_user_id,
    'attendance_corrected',
    'attendance',
    v_result.id,
    jsonb_build_object(
      'attendance_id', v_attendance.id,
      'clock_in', v_attendance.clock_in,
      'clock_out', v_attendance.clock_out,
      'status', v_attendance.attendance_status
    ),
    jsonb_build_object(
      'attendance_id', v_result.id,
      'clock_in', v_result.clock_in,
      'clock_out', v_result.clock_out,
      'status', v_result.attendance_status,
      'reason_code', p_reason_code,
      'reason_notes', p_reason_notes,
      'review_status', v_result.review_status,
      'corrected_by', v_actor_user_id
    ),
    'attendance correction recorded'
  );

  return v_result;
end;
$$;

comment on function public.workforce_correct_attendance(uuid, timestamptz, timestamptz, text, uuid, text, text, text) is
  'Corrects effective attendance timestamps and status, preserves prior values, recalculates totals, and records structured correction history.';

revoke all on function public.workforce_correct_attendance(uuid, timestamptz, timestamptz, text, uuid, text, text, text) from public;
revoke all on function public.workforce_correct_attendance(uuid, timestamptz, timestamptz, text, uuid, text, text, text) from anon;
revoke all on function public.workforce_correct_attendance(uuid, timestamptz, timestamptz, text, uuid, text, text, text) from authenticated;
grant execute on function public.workforce_correct_attendance(uuid, timestamptz, timestamptz, text, uuid, text, text, text) to authenticated;

alter table public.attendance_corrections enable row level security;

drop policy if exists "Admins can view attendance correction history" on public.attendance_corrections;
create policy "Admins can view attendance correction history"
  on public.attendance_corrections
  for select
  using (
    public.workforce_current_user_is_active()
    and public.workforce_is_admin()
  );

drop policy if exists "Admins can insert attendance correction history" on public.attendance_corrections;
create policy "Admins can insert attendance correction history"
  on public.attendance_corrections
  for insert
  with check (
    public.workforce_current_user_is_active()
    and public.workforce_is_admin()
  );

drop policy if exists "Admins can update attendance correction history" on public.attendance_corrections;
create policy "Admins can update attendance correction history"
  on public.attendance_corrections
  for update
  using (
    public.workforce_current_user_is_active()
    and public.workforce_is_admin()
  );

drop policy if exists "Admins can delete attendance correction history" on public.attendance_corrections;
create policy "Admins can delete attendance correction history"
  on public.attendance_corrections
  for delete
  using (
    public.workforce_current_user_is_active()
    and public.workforce_is_admin()
  );

insert into public.workforce_audit_logs (
  actor_user_id,
  action,
  entity_type,
  entity_id,
  before_data,
  after_data,
  reason
)
values (
  auth.uid(),
  'attendance_correction_workflow_migration_applied',
  'attendance',
  null,
  null,
  jsonb_build_object(
    'migration', '2026070904_attendance_correction_workflow.sql',
    'summary', 'Added attendance_corrections table and workforce_correct_attendance RPC.'
  ),
  'migration applied'
);

commit;
