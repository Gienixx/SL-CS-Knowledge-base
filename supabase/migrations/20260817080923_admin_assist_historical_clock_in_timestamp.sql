-- Add an explicit historical clock-in timestamp for Manager Agent Assist.
-- The existing four-argument RPC remains available and delegates to the
-- five-argument implementation with a null timestamp, preserving now()-based
-- current/non-historical Assist behavior.

begin;

create or replace function public.workforce_admin_assist_clock_in(
  p_target_user_id uuid,
  p_schedule_id uuid,
  p_work_date date,
  p_reason text,
  p_clock_in timestamptz
)
returns public.attendance
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_timezone text;
  v_local_date date;
  v_clock_in_local_date date;
  v_schedule_start_local_date date;
  v_schedule_end_local_date date;
  v_allowed_overnight_date date;
  v_clock_in timestamptz := coalesce(p_clock_in, now());
  v_is_historical boolean := false;
  v_schedule public.work_schedules%rowtype;
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

  select coalesce(nullif(profile.timezone, ''), 'America/New_York')
    into v_timezone
  from public.profiles profile
  where profile.user_id = p_target_user_id
    and profile.is_agent is true
    and profile.employment_status in ('active', 'on_leave');
  if not found then
    raise exception 'Target employee was not found.';
  end if;

  v_local_date := (statement_timestamp() at time zone v_timezone)::date;

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

    if v_schedule.shift_start is not null and v_schedule.shift_end is not null then
      v_schedule_start_local_date := (v_schedule.shift_start at time zone v_timezone)::date;
      v_schedule_end_local_date := (v_schedule.shift_end at time zone v_timezone)::date;
      if v_schedule_start_local_date = p_work_date - 1
         and v_schedule_end_local_date >= p_work_date then
        v_allowed_overnight_date := v_schedule_start_local_date;
      end if;
    end if;

    -- A timestamp is required once the selected schedule has ended. An
    -- active overnight prior-day schedule remains on the existing now() path.
    v_is_historical :=
      v_schedule.shift_end is not null
      and v_schedule.shift_end <= statement_timestamp();
    if v_schedule.shift_end is null and p_work_date < v_local_date then
      v_is_historical := true;
    end if;
  elsif p_work_date < v_local_date then
    v_is_historical := true;
  end if;

  if v_is_historical and p_clock_in is null then
    raise exception 'A historical Clock In timestamp is required for an ended schedule.';
  end if;
  if not v_is_historical and p_clock_in is not null then
    raise exception 'An explicit Clock In timestamp is only allowed for historical Assist.';
  end if;
  if p_clock_in is not null and p_clock_in > statement_timestamp() then
    raise exception 'Historical Clock In cannot be in the future.';
  end if;

  if p_clock_in is not null then
    v_clock_in_local_date := (v_clock_in at time zone v_timezone)::date;
    if p_schedule_id is null then
      if v_clock_in_local_date <> p_work_date then
        raise exception 'Historical Clock In must use the target work date.';
      end if;
    elsif v_clock_in_local_date <> p_work_date
       and (v_allowed_overnight_date is null or v_clock_in_local_date <> v_allowed_overnight_date) then
      raise exception 'Historical Clock In must use the target work date or its legitimate overnight start date.';
    end if;
  end if;

  if p_schedule_id is not null then
    -- The schedule-level unique index preserves voided rows for audit history;
    -- therefore a schedule with any attendance row is not reusable as a
    -- second normal assisted Clock In.
    perform 1
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

  perform 1
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
    v_clock_in,
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
      'audit_source', 'admin_assisted_clock_in',
      'timestamp_source', case when p_clock_in is null then 'server_now' else 'manager_supplied_historical' end
    ),
    trim(p_reason),
    jsonb_build_object(
      'audit_source', 'admin_assisted_clock_in',
      'target_employee_id', p_target_user_id,
      'schedule_id', p_schedule_id,
      'work_date', p_work_date,
      'timestamp_source', case when p_clock_in is null then 'server_now' else 'manager_supplied_historical' end
    )
  );

  return v_result;
end;
$$;

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
begin
  return public.workforce_admin_assist_clock_in(
    p_target_user_id,
    p_schedule_id,
    p_work_date,
    p_reason,
    null::timestamptz
  );
end;
$$;

alter function public.workforce_admin_assist_clock_in(uuid, uuid, date, text, timestamptz)
  owner to postgres;
alter function public.workforce_admin_assist_clock_in(uuid, uuid, date, text)
  owner to postgres;

revoke all on function public.workforce_admin_assist_clock_in(uuid, uuid, date, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.workforce_admin_assist_clock_in(uuid, uuid, date, text)
  from public, anon, authenticated;
grant execute on function public.workforce_admin_assist_clock_in(uuid, uuid, date, text, timestamptz)
  to authenticated;
grant execute on function public.workforce_admin_assist_clock_in(uuid, uuid, date, text)
  to authenticated;

comment on function public.workforce_admin_assist_clock_in(uuid, uuid, date, text, timestamptz) is
  'Audited Manager Agent Assist clock-in with an optional explicit historical timestamp; historical timestamps are date-validated in the target employee timezone.';
comment on function public.workforce_admin_assist_clock_in(uuid, uuid, date, text) is
  'Backward-compatible Manager Agent Assist clock-in using server now() for current/non-historical attendance.';

commit;
