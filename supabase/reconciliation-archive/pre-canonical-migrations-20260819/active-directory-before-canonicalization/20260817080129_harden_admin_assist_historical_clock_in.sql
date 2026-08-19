-- Harden the existing Admin Assist clock-in contract before allowing ended
-- schedules to be selected in the manager-facing Attendance view.
-- The signature, authorization model, current-time clock-in semantics, and
-- audit action remain compatible with the existing RPC.

begin;

create or replace function public.workforce_admin_assist_clock_in(
  p_target_user_id uuid,
  p_schedule_id uuid,
  p_work_date date,
  p_reason text
)
returns public.attendance
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_schedule public.work_schedules%rowtype;
  v_existing public.attendance%rowtype;
  v_result public.attendance%rowtype;
begin
  if not public.workforce_is_authorized_attendance_admin('correct_attendance') then
    raise exception 'Admin attendance permission is required.';
  end if;
  if p_target_user_id is null or p_work_date is null then
    raise exception 'Target employee and work date are required.';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then
    raise exception 'A reason is required for Admin Assist.';
  end if;

  perform 1
  from public.profiles
  where user_id = p_target_user_id
    and is_agent is true
    and employment_status in ('active', 'on_leave');
  if not found then
    raise exception 'Target employee was not found.';
  end if;

  if p_schedule_id is not null then
    select * into v_schedule
    from public.work_schedules
    where id = p_schedule_id
      and user_id = p_target_user_id
    for share;

    if not found
       or v_schedule.shift_date <> p_work_date
       or v_schedule.status not in ('published', 'changed') then
      raise exception 'Selected schedule does not belong to the target employee.';
    end if;
    if v_schedule.is_leave or v_schedule.is_absent then
      raise exception 'Leave and absence schedules cannot be used for attendance.';
    end if;

    -- The schedule-level unique index intentionally preserves voided rows for
    -- audit history, so any existing row for this schedule is not reusable as
    -- a second normal assisted clock-in.
    select * into v_existing
    from public.attendance
    where user_id = p_target_user_id
      and schedule_id = p_schedule_id
    order by created_at desc
    limit 1
    for update;
    if found then
      raise exception 'Attendance already exists for the selected schedule.';
    end if;
  end if;

  -- Do not create attendance inside a finalized payroll period. A later
  -- approval/recalculation path must not mutate finalized payroll coverage.
  if exists (
    select 1
    from public.payroll_periods period
    where p_work_date between period.period_start and period.period_end
      and period.status = 'finalized'
  ) or exists (
    select 1
    from public.payroll_records record
    join public.payroll_periods period on period.id = record.payroll_period_id
    where record.employee_id = p_target_user_id
      and p_work_date between period.period_start and period.period_end
      and record.status = 'finalized'
  ) then
    raise exception 'Attendance cannot be added inside finalized payroll.';
  end if;

  select * into v_existing
  from public.attendance
  where user_id = p_target_user_id
    and clock_in is not null
    and clock_out is null
  order by clock_in desc
  limit 1
  for update;
  if found then
    raise exception 'The target employee already has an open attendance session.';
  end if;

  insert into public.attendance (
    user_id,
    schedule_id,
    work_date,
    clock_in,
    attendance_status,
    review_status,
    created_by,
    updated_by
  ) values (
    p_target_user_id,
    p_schedule_id,
    p_work_date,
    now(),
    'present',
    'pending',
    v_actor,
    v_actor
  )
  returning * into v_result;

  v_result := public.workforce_recalculate_attendance(v_result.id);

  insert into public.workforce_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    after_data,
    reason,
    metadata
  ) values (
    v_actor,
    'admin_assisted_clock_in',
    'attendance',
    v_result.id,
    jsonb_build_object(
      'target_employee_id', p_target_user_id,
      'action', 'clock-in',
      'timestamp', v_result.clock_in,
      'schedule_id', p_schedule_id,
      'work_date', p_work_date,
      'audit_source', 'admin_assisted_clock_in'
    ),
    trim(p_reason),
    jsonb_build_object(
      'audit_source', 'admin_assisted_clock_in',
      'target_employee_id', p_target_user_id,
      'schedule_id', p_schedule_id,
      'work_date', p_work_date
    )
  );

  return v_result;
end;
$$;

revoke all on function public.workforce_admin_assist_clock_in(uuid, uuid, date, text)
  from public, anon, authenticated;
grant execute on function public.workforce_admin_assist_clock_in(uuid, uuid, date, text)
  to authenticated;

comment on function public.workforce_admin_assist_clock_in(uuid, uuid, date, text) is
  'Audited Admin Assist clock-in for a target employee and explicit work date; permits historical schedules while preserving duplicate, leave, open-session, and finalized-payroll safeguards.';

commit;
