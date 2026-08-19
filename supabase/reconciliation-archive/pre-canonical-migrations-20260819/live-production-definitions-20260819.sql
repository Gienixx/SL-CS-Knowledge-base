-- LIVE PRODUCTION SNAPSHOT
-- signature: workforce_admin_assist_clock_in(uuid,uuid,date,text,timestamp with time zone)
-- md5: 9fa647745cb97606423469d1843605bd
CREATE OR REPLACE FUNCTION public.workforce_admin_assist_clock_in(p_target_user_id uuid, p_schedule_id uuid, p_work_date date, p_reason text, p_clock_in timestamp with time zone)
 RETURNS attendance
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$

-- LIVE PRODUCTION SNAPSHOT
-- signature: workforce_admin_assist_clock_in(uuid,uuid,date,text)
-- md5: eab20bd23704eb60a713c3d69f485748
CREATE OR REPLACE FUNCTION public.workforce_admin_assist_clock_in(p_target_user_id uuid, p_schedule_id uuid, p_work_date date, p_reason text)
 RETURNS attendance
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  return public.workforce_admin_assist_clock_in(
    p_target_user_id,
    p_schedule_id,
    p_work_date,
    p_reason,
    null::timestamptz
  );
end;
$function$

-- LIVE PRODUCTION SNAPSHOT
-- signature: workforce_admin_save_employee(uuid,text,text,text,text,uuid,uuid,text,jsonb,text)
-- md5: 71faf51954cd09e0fc0403ce4740d878
CREATE OR REPLACE FUNCTION public.workforce_admin_save_employee(p_user_id uuid, p_full_name text, p_employee_id text, p_employment_status text, p_access_type text, p_team_id uuid DEFAULT NULL::uuid, p_supervisor_id uuid DEFAULT NULL::uuid, p_timezone text DEFAULT 'Asia/Manila'::text, p_permissions jsonb DEFAULT '{}'::jsonb, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_bridge_access_type text;
  v_result jsonb;
  v_permission_key text;
  v_is_granted boolean;
begin
  if auth.uid() is null
     or not public.workforce_is_admin()
     or not public.workforce_has_permission('manage_employees') then
    raise exception 'You do not have permission to manage employees.' using errcode = '42501';
  end if;

  if p_access_type not in ('admin', 'regular_agent', 'admin_agent') then
    raise exception 'Invalid access type. Use Admin, Regular Agent, or Admin and Agent.';
  end if;

  v_bridge_access_type := case
    when p_access_type = 'regular_agent'
      and coalesce((p_permissions ->> 'edit_articles')::boolean, false)
      then 'agent_editor'
    else p_access_type
  end;

  v_result := public.workforce_admin_save_employee_legacy_access_bridge(
    p_user_id,
    p_full_name,
    p_employee_id,
    p_employment_status,
    v_bridge_access_type,
    p_team_id,
    p_supervisor_id,
    p_timezone,
    p_permissions,
    p_reason
  );

  foreach v_permission_key in array array[
    'manage_announcements',
    'manage_agent_rates',
    'create_payroll',
    'review_payroll',
    'finalize_payroll',
    'view_all_payslips',
    'view_own_payslips',
    'export_payslips',
    'reopen_payroll'
  ] loop
    if v_permission_key = 'manage_announcements'
       and exists (
         select 1 from public.profiles profile
         where profile.user_id = p_user_id
           and profile.is_system_admin is true
       ) then
      v_is_granted := true;
    elsif p_permissions ? v_permission_key then
      v_is_granted := coalesce((p_permissions ->> v_permission_key)::boolean, false);
    else
      select permission.is_granted
      into v_is_granted
      from public.user_permissions permission
      where permission.user_id = p_user_id
        and permission.permission_key = v_permission_key;

      v_is_granted := coalesce(v_is_granted, false);
    end if;

    insert into public.user_permissions (
      user_id, permission_key, is_granted, granted_by, reason
    ) values (
      p_user_id,
      v_permission_key,
      v_is_granted,
      auth.uid(),
      coalesce(
        nullif(trim(coalesce(p_reason, '')), ''),
        'Updated through workforce employee administration'
      )
    )
    on conflict (user_id, permission_key) do update
    set is_granted = excluded.is_granted,
        granted_by = excluded.granted_by,
        reason = excluded.reason,
        updated_at = now();

    v_result := jsonb_set(
      v_result,
      array['permissions', v_permission_key],
      to_jsonb(v_is_granted),
      true
    );
  end loop;

  return jsonb_set(v_result, '{access_type}', to_jsonb(p_access_type), true);
end;
$function$

-- LIVE PRODUCTION SNAPSHOT
-- signature: workforce_clock_in(uuid)
-- md5: c9760ce24977acfc30ac5d4abf1869ef
CREATE OR REPLACE FUNCTION public.workforce_clock_in(p_schedule_id uuid DEFAULT NULL::uuid)
 RETURNS attendance
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_auth_user_id uuid := auth.uid();
  v_profile_user_id uuid;
  v_timezone text;
  v_local_date date;
  v_work_date date;
  v_clock_time timestamptz := now();
  v_has_released_schedule boolean := false;
  v_has_completed_session boolean := false;
  v_schedule public.work_schedules%rowtype;
  v_existing public.attendance%rowtype;
  v_result public.attendance%rowtype;
begin
  if v_auth_user_id is null or not public.workforce_current_user_is_agent() then
    raise exception 'Authentication and an active agent profile are required.';
  end if;

  v_profile_user_id := public.workforce_current_profile_id();
  if v_profile_user_id is null then
    raise exception 'No workforce profile is linked to the current account.';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_profile_user_id::text)::bigint);

  select coalesce(nullif(profile.timezone, ''), 'America/New_York')
    into v_timezone
  from public.profiles profile
  where profile.user_id = v_profile_user_id;

  v_local_date := (v_clock_time at time zone v_timezone)::date;
  v_work_date := v_local_date;

  if exists (
    select 1
    from public.attendance a
    where a.user_id = v_profile_user_id
      and a.clock_in is not null
      and a.clock_out is null
  ) then
    raise exception 'You are already clocked in to another shift.';
  end if;

  if p_schedule_id is null then
    select exists (
      select 1
      from public.attendance a
      where a.user_id = v_profile_user_id
        and a.work_date = v_work_date
        and a.clock_in is not null
        and a.clock_out is not null
    ) into v_has_completed_session;

    select exists (
      select 1
      from public.work_schedules schedule
      where schedule.user_id = v_profile_user_id
        and schedule.status in ('published', 'changed')
        and not schedule.is_leave
        and not schedule.is_absent
        and (
          (
            not (schedule.is_rest_day or schedule.is_holiday)
            and schedule.shift_start is not null
            and schedule.shift_end is not null
            and schedule.shift_date = v_local_date
            and schedule.shift_end > v_clock_time
          )
          or (
            (schedule.is_rest_day or schedule.is_holiday)
            and schedule.shift_date = v_local_date
          )
          or (
            schedule.shift_date = v_local_date - 1
            and schedule.shift_end is not null
            and schedule.shift_end > v_clock_time
            and (
              (schedule.is_rest_day or schedule.is_holiday)
              or (schedule.shift_start is not null and schedule.shift_end is not null)
            )
          )
        )
    ) into v_has_released_schedule;

    if v_has_released_schedule and not v_has_completed_session then
      raise exception 'A released shift or special work date is available. Select it before clocking in.';
    end if;
  else
    select *
      into v_schedule
    from public.work_schedules schedule
    where schedule.id = p_schedule_id
      and schedule.user_id = v_profile_user_id;

    if not found then
      raise exception 'The selected schedule does not belong to the current user.';
    end if;
    if v_schedule.status not in ('published', 'changed') then
      raise exception 'Clock-in is not available for this schedule.';
    end if;
    if v_schedule.is_leave or v_schedule.is_absent then
      raise exception 'Leave and absence schedules cannot be used for timed attendance.';
    end if;
    if not (v_schedule.is_rest_day or v_schedule.is_holiday)
       and (v_schedule.shift_start is null or v_schedule.shift_end is null) then
      raise exception 'The selected schedule does not have valid shift times.';
    end if;
    if v_schedule.shift_date < v_local_date - 1
       or v_schedule.shift_date > v_local_date + 1 then
      raise exception 'The selected schedule is outside the available attendance date range.';
    end if;
    if v_clock_time >= v_schedule.shift_end then
      raise exception 'This shift has already ended and is no longer available for clock-in.';
    end if;
    v_work_date := v_schedule.shift_date;
  end if;

  if p_schedule_id is null then
    select *
      into v_existing
    from public.attendance a
    where a.user_id = v_profile_user_id
      and a.schedule_id is null
      and a.work_date = v_work_date
      and a.clock_in is null
    order by a.created_at asc
    limit 1
    for update;
  else
    select *
      into v_existing
    from public.attendance a
    where a.user_id = v_profile_user_id
      and a.schedule_id = p_schedule_id
    order by a.created_at asc
    limit 1
    for update;
  end if;

  if v_existing.id is not null then
    update public.attendance
    set clock_in = v_clock_time,
        schedule_id = coalesce(p_schedule_id, schedule_id),
        work_date = v_work_date,
        attendance_status = 'present',
        review_status = case when p_schedule_id is null then 'pending' else review_status end,
        created_by = coalesce(created_by, v_auth_user_id),
        updated_by = v_auth_user_id
    where id = v_existing.id
    returning * into v_result;
  else
    insert into public.attendance (
      user_id, schedule_id, work_date, clock_in, attendance_status,
      review_status, created_by, updated_by
    )
    values (
      v_profile_user_id, p_schedule_id, v_work_date, v_clock_time,
      'present', 'pending', v_auth_user_id, v_auth_user_id
    )
    returning * into v_result;
  end if;

  return public.workforce_recalculate_attendance(v_result.id);
end;
$function$

-- LIVE PRODUCTION SNAPSHOT
-- signature: workforce_correct_attendance(uuid,timestamp with time zone,timestamp with time zone,text,uuid,text,text,text)
-- md5: bb933cdee68fc0c1d6eed401577191d1
CREATE OR REPLACE FUNCTION public.workforce_correct_attendance(p_attendance_id uuid, p_new_clock_in timestamp with time zone, p_new_clock_out timestamp with time zone, p_new_status text, p_schedule_id uuid DEFAULT NULL::uuid, p_admin_notes text DEFAULT NULL::text, p_reason_code text DEFAULT NULL::text, p_reason_notes text DEFAULT NULL::text)
 RETURNS attendance
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_old public.attendance%rowtype;
  v_new public.attendance%rowtype;
  v_schedule public.work_schedules%rowtype;
  v_reason text := nullif(trim(coalesce(p_reason_notes, '')), '');
begin
  if v_actor is null then raise exception 'Authenticated session is required.'; end if;
  if not public.workforce_current_user_is_active()
     or not public.workforce_can_correct_attendance(public.workforce_current_profile_id()) then
    raise exception 'You do not have permission to correct attendance.';
  end if;
  if p_attendance_id is null then raise exception 'Attendance record is required.'; end if;
  if p_new_status not in ('present', 'absent', 'on_leave', 'excused') then raise exception 'Attendance status is invalid.'; end if;
  if p_new_clock_out is not null and (p_new_clock_in is null or p_new_clock_out < p_new_clock_in) then raise exception 'Billed clock-out cannot be earlier than billed clock-in.'; end if;
  if nullif(trim(coalesce(p_reason_code, '')), '') is null then raise exception 'A correction reason is required.'; end if;
  if p_reason_code = 'other' and v_reason is null then raise exception 'Written notes are required when reason is other.'; end if;

  select * into v_old from public.attendance where id = p_attendance_id for update;
  if not found then raise exception 'Attendance record not found.'; end if;
  if v_old.review_status = 'locked' then raise exception 'Locked attendance cannot be changed.'; end if;
  if not (
    public.workforce_is_admin()
    and (
      public.workforce_has_permission('correct_attendance')
      or exists (
        select 1 from public.profiles profile
        where public.workforce_is_current_identity(profile.user_id)
          and profile.is_system_admin is true
      )
    )
  ) then raise exception 'You do not have permission to manage this employee.'; end if;

  if p_schedule_id is not null and p_schedule_id is distinct from v_old.schedule_id then
    select * into v_schedule
    from public.work_schedules
    where id = p_schedule_id
    for share;
    if not found then raise exception 'The selected schedule was not found.'; end if;
    if v_schedule.user_id <> v_old.user_id then raise exception 'Schedule employee does not match attendance employee.'; end if;
    if v_schedule.shift_date not in (v_old.work_date, v_old.work_date - 1) then
      raise exception 'Schedule work date must match attendance work date or the previous calendar day.';
    end if;
    if v_schedule.is_leave or v_schedule.is_absent then
      raise exception 'Leave and absence schedules cannot be assigned to attendance.';
    end if;
    if v_schedule.status not in ('published', 'changed') then raise exception 'Only published or changed schedules may be assigned.'; end if;
    if not v_schedule.is_rest_day and not v_schedule.is_holiday
       and (v_schedule.shift_start is null or v_schedule.shift_end is null or v_schedule.shift_end <= v_schedule.shift_start) then
      raise exception 'The selected schedule does not have valid shift times.';
    end if;
  end if;

  update public.attendance
  set billed_clock_in = p_new_clock_in,
      billed_clock_out = p_new_clock_out,
      attendance_status = p_new_status,
      review_status = 'corrected',
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

  v_new := public.workforce_recalculate_attendance(v_new.id);

  insert into public.attendance_corrections (
    attendance_id, employee_user_id, schedule_id, previous_schedule_id, new_schedule_id,
    previous_clock_in, previous_clock_out, new_clock_in, new_clock_out,
    previous_billed_clock_in, previous_billed_clock_out,
    new_billed_clock_in, new_billed_clock_out,
    previous_status, new_status, reason_code, reason_notes,
    corrected_by, corrected_at
  ) values (
    v_new.id, v_new.user_id, v_new.schedule_id, v_old.schedule_id, v_new.schedule_id,
    v_old.billed_clock_in, v_old.billed_clock_out, v_new.billed_clock_in, v_new.billed_clock_out,
    v_old.billed_clock_in, v_old.billed_clock_out, v_new.billed_clock_in, v_new.billed_clock_out,
    v_old.attendance_status, v_new.attendance_status, p_reason_code, v_reason,
    v_actor, now()
  );

  insert into public.workforce_audit_logs
    (actor_user_id, action, entity_type, entity_id, before_data, after_data, reason)
  values (
    v_actor, 'attendance_billed_time_corrected', 'attendance', v_new.id,
    jsonb_build_object(
      'schedule_id', v_old.schedule_id,
      'original_clock_in', v_old.original_clock_in,
      'original_clock_out', v_old.original_clock_out,
      'billed_clock_in', v_old.billed_clock_in,
      'billed_clock_out', v_old.billed_clock_out,
      'review_status', v_old.review_status,
      'attendance_version', v_old.attendance_version
    ),
    jsonb_build_object(
      'schedule_id', v_new.schedule_id,
      'original_clock_in', v_new.original_clock_in,
      'original_clock_out', v_new.original_clock_out,
      'billed_clock_in', v_new.billed_clock_in,
      'billed_clock_out', v_new.billed_clock_out,
      'review_status', v_new.review_status,
      'attendance_version', v_new.attendance_version,
      'corrected_by', v_actor
    ),
    coalesce(v_reason, p_reason_code)
  );
  return v_new;
end;
$function$

-- LIVE PRODUCTION SNAPSHOT
-- signature: workforce_flag_current_open_attendance_over_duration()
-- md5: 026df74883fa2722f6556bb5ec809d5c
CREATE OR REPLACE FUNCTION public.workforce_flag_current_open_attendance_over_duration()
 RETURNS attendance
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_profile_user_id uuid := public.workforce_current_profile_id();
  v_result public.attendance%rowtype;
  v_now timestamptz := statement_timestamp();
begin
  if auth.uid() is null or not public.workforce_current_user_is_agent() then
    raise exception using errcode = '42501', message = 'Authentication and an active agent profile are required.';
  end if;
  if v_profile_user_id is null then
    raise exception using errcode = '42501', message = 'No workforce profile is linked to the current account.';
  end if;

  update public.attendance
  set manager_review_reason = 'open_session_over_20_hours'
  where public.workforce_is_current_identity(user_id)
    and clock_in is not null
    and clock_out is null
    and manager_review_reason is null
    and voided_at is null
    and clock_in < v_now - interval '20 hours'
  returning * into v_result;

  if v_result.id is null then
    select attendance_row.* into v_result
    from public.attendance attendance_row
    where public.workforce_is_current_identity(attendance_row.user_id)
      and attendance_row.clock_in is not null
      and attendance_row.clock_out is null
    order by attendance_row.clock_in desc
    limit 1;
  end if;

  if v_result.id is null then
    raise exception using errcode = 'P0002', message = 'No open attendance record was found.';
  end if;
  return v_result;
end;
$function$

-- LIVE PRODUCTION SNAPSHOT
-- signature: workforce_flag_open_attendance_over_duration()
-- md5: 437c954711177f1ff45c9d0114fcc74a
CREATE OR REPLACE FUNCTION public.workforce_flag_open_attendance_over_duration()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_now timestamptz := statement_timestamp();
  v_flagged_count integer := 0;
begin
  if auth.uid() is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_is_admin()
     or not public.workforce_has_permission('view_team_attendance') then
    raise exception using errcode = '42501', message = 'Administrator Team Attendance access is required.';
  end if;

  update public.attendance
  set manager_review_reason = 'open_session_over_20_hours'
  where clock_in is not null
    and clock_out is null
    and manager_review_reason is null
    and voided_at is null
    and clock_in < v_now - interval '20 hours';

  get diagnostics v_flagged_count = row_count;
  return v_flagged_count;
end;
$function$

-- LIVE PRODUCTION SNAPSHOT
-- signature: workforce_is_authorized_attendance_admin(text)
-- md5: 9c28bb4a5c9e1bc33d532ba36f17092f
CREATE OR REPLACE FUNCTION public.workforce_is_authorized_attendance_admin(p_permission_key text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p_permission_key in ('correct_attendance', 'approve_attendance')
    and public.workforce_current_user_is_active()
    and public.workforce_is_admin()
    and (
      public.workforce_has_permission(p_permission_key)
      or exists (
        select 1
        from public.profiles profile
        where public.workforce_is_current_identity(profile.user_id)
          and profile.is_system_admin is true
      )
    );
$function$

-- LIVE PRODUCTION SNAPSHOT
-- signature: workforce_list_team_attendance_prepaid(date,date)
-- md5: a44a029e25641c485efcb8df6c1d54de
CREATE OR REPLACE FUNCTION public.workforce_list_team_attendance_prepaid(p_start_date date, p_end_date date)
 RETURNS TABLE(attendance_id uuid, prepaid_clock_in timestamp with time zone, prepaid_clock_out timestamp with time zone, prepaid_minutes integer, actual_eligible_minutes integer, applied_prepaid_minutes integer, remaining_prepaid_minutes integer, prepaid_status text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if auth.uid() is null
     or public.workforce_current_profile_id() is null
     or not public.workforce_current_user_is_active() then
    raise exception
      using
        errcode = '42501',
        message = 'Authentication and an active workforce profile are required.';
  end if;

  if not public.workforce_has_permission('view_team_attendance') then
    raise exception
      using
        errcode = '42501',
        message = 'You do not have permission to view team attendance.';
  end if;

  if p_start_date is null or p_end_date is null then
    raise exception
      using
        errcode = '22004',
        message = 'Start date and end date are required.';
  end if;

  if p_end_date < p_start_date then
    raise exception
      using
        errcode = '22007',
        message = 'End date cannot be earlier than start date.';
  end if;

  if p_end_date - p_start_date > 366 then
    raise exception
      using
        errcode = '22023',
        message = 'Team attendance date ranges cannot exceed 367 calendar days.';
  end if;

  return query
  select
    attendance_row.id,
    source_prepaid.shift_start,
    source_prepaid.shift_end,
    source_prepaid.prepaid_minutes,
    case
      when attendance_row.attendance_status <> 'present'
        or attendance_row.clock_out is null
        or coalesce(schedule.is_rest_day, false)
        or coalesce(schedule.is_holiday, false)
        or coalesce(attendance_row.rest_day_overtime_minutes, 0) > 0
        or coalesce(attendance_row.holiday_overtime_minutes, 0) > 0
        then 0
      else
        greatest(coalesce(attendance_row.regular_minutes, 0), 0)
        + greatest(
            coalesce(attendance_row.pre_shift_overtime_minutes, 0),
            0
          )
        + greatest(
            coalesce(attendance_row.post_shift_overtime_minutes, 0),
            0
          )
    end::integer,
    coalesce(applied_prepaid.applied_minutes, 0)::integer,
    source_prepaid.remaining_minutes,
    source_prepaid.status
  from public.attendance as attendance_row
  left join public.work_schedules as schedule
    on schedule.id = attendance_row.schedule_id
   and schedule.user_id = attendance_row.user_id
  left join lateral (
    select
      snapshot.shift_start,
      snapshot.shift_end,
      prepaid.prepaid_minutes,
      prepaid.remaining_minutes,
      prepaid.status
    from public.payroll_schedule_snapshots as snapshot
    join public.payroll_prepaid_hours as prepaid
      on prepaid.source_schedule_snapshot_id = snapshot.id
     and prepaid.employee_id = snapshot.employee_id
    where snapshot.employee_id = attendance_row.user_id
      and snapshot.schedule_id = attendance_row.schedule_id
      and snapshot.work_date = attendance_row.work_date
    order by
      snapshot.approved_at desc,
      prepaid.created_at desc,
      prepaid.id desc
    limit 1
  ) as source_prepaid on true
  left join lateral (
    select
      sum(
        case
          when allocation.allocation_type = 'settlement'
            then allocation.allocated_minutes
          else -allocation.allocated_minutes
        end
      )::integer as applied_minutes
    from public.payroll_attendance_snapshots as attendance_snapshot
    join public.payroll_hour_allocations as allocation
      on allocation.attendance_snapshot_id = attendance_snapshot.id
     and allocation.employee_id = attendance_snapshot.employee_id
    where attendance_snapshot.attendance_id = attendance_row.id
      and attendance_snapshot.employee_id = attendance_row.user_id
  ) as applied_prepaid on true
  where attendance_row.work_date between p_start_date and p_end_date
    and public.workforce_can_manage_user(
      attendance_row.user_id,
      'view_team_attendance'
    )
  order by
    attendance_row.work_date desc,
    attendance_row.clock_in desc nulls last,
    attendance_row.created_at desc;
end;
$function$

-- LIVE PRODUCTION SNAPSHOT
-- signature: workforce_list_team_attendance(date,date)
-- md5: dfd396549ccdfc5c05d45c76599a90fd
CREATE OR REPLACE FUNCTION public.workforce_list_team_attendance(p_start_date date, p_end_date date)
 RETURNS TABLE(attendance_id uuid, employee_user_id uuid, employee_name text, employee_email text, employee_id text, employee_timezone text, team_id uuid, team_name text, work_date date, schedule_id uuid, shift_sequence smallint, scheduled_start timestamp with time zone, scheduled_end timestamp with time zone, schedule_timezone text, schedule_status text, clock_in timestamp with time zone, clock_out timestamp with time zone, original_clock_in timestamp with time zone, original_clock_out timestamp with time zone, billed_clock_in timestamp with time zone, billed_clock_out timestamp with time zone, regular_minutes integer, pre_shift_overtime_minutes integer, post_shift_overtime_minutes integer, total_overtime_minutes integer, total_worked_minutes integer, minutes_late integer, undertime_minutes integer, attendance_status text, is_corrected boolean, review_status text, corrected_by uuid, corrected_by_name text, corrected_at timestamp with time zone, correction_reason text, admin_notes text, is_open boolean, is_missing_clock_out boolean, manager_review_reason text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_current_profile public.profiles%rowtype;
  v_is_admin boolean := false;
  v_now timestamptz := statement_timestamp();
begin
  if auth.uid() is null or public.workforce_current_profile_id() is null
     or not public.workforce_current_user_is_active() then
    raise exception using errcode = '42501', message = 'Authentication and an active workforce profile are required.';
  end if;
  select profile.* into v_current_profile from public.profiles profile
  where profile.user_id = public.workforce_current_profile_id();
  if not found then raise exception using errcode = '42501', message = 'An active workforce profile is required.'; end if;
  v_is_admin := public.workforce_is_admin();
  if v_is_admin and not public.workforce_has_permission('view_team_attendance') then
    raise exception using errcode = '42501', message = 'You do not have permission to view team attendance.';
  end if;
  if not v_is_admin and v_current_profile.is_agent is not true then
    raise exception using errcode = '42501', message = 'Team attendance is available only to administrators and active agents.';
  end if;
  if p_start_date is null or p_end_date is null then raise exception using errcode = '22004', message = 'Start date and end date are required.'; end if;
  if p_end_date < p_start_date then raise exception using errcode = '22007', message = 'End date cannot be earlier than start date.'; end if;
  if p_end_date - p_start_date > 366 then raise exception using errcode = '22023', message = 'Team attendance date ranges cannot exceed 367 calendar days.'; end if;

  return query
  select attendance_row.id, attendance_row.user_id, employee.full_name,
    case when v_is_admin then employee.email else null end,
    case when v_is_admin then employee.employee_id else null end,
    employee.timezone, employee.team_id, employee_team.name,
    attendance_row.work_date, attendance_row.schedule_id, schedule.shift_sequence,
    schedule.shift_start, schedule.shift_end, schedule.timezone, schedule.status,
    attendance_row.clock_in, attendance_row.clock_out,
    case when v_is_admin then attendance_row.original_clock_in else null end,
    case when v_is_admin then attendance_row.original_clock_out else null end,
    case when v_is_admin then attendance_row.billed_clock_in else null end,
    case when v_is_admin then attendance_row.billed_clock_out else null end,
    case when v_is_admin then attendance_row.regular_minutes else null end,
    case when v_is_admin then attendance_row.pre_shift_overtime_minutes else null end,
    case when v_is_admin then attendance_row.post_shift_overtime_minutes else null end,
    case when v_is_admin then attendance_row.total_overtime_minutes else null end,
    case when v_is_admin then attendance_row.total_worked_minutes else null end,
    case when v_is_admin then attendance_row.minutes_late else null end,
    case when v_is_admin then attendance_row.undertime_minutes else null end,
    attendance_row.attendance_status,
    case when v_is_admin then attendance_row.is_corrected else false end,
    case when v_is_admin then attendance_row.review_status else 'pending' end,
    case when v_is_admin then attendance_row.corrected_by else null end,
    case when not v_is_admin or attendance_row.corrected_by is null then null
      when corrector.full_name is not null then corrector.full_name else 'Former workforce user' end,
    case when v_is_admin then attendance_row.corrected_at else null end,
    case when v_is_admin then attendance_row.correction_reason else null end,
    case when v_is_admin then attendance_row.admin_notes else null end,
    attendance_row.clock_in is not null and attendance_row.clock_out is null,
    attendance_row.clock_in is not null and attendance_row.clock_out is null
      and ((schedule.shift_end is not null and schedule.shift_end < v_now)
        or attendance_row.work_date < (v_now at time zone coalesce(nullif(employee.timezone, ''), 'America/New_York'))::date),
    case when v_is_admin then attendance_row.manager_review_reason else null end
  from public.attendance attendance_row
  join public.profiles employee on employee.user_id = attendance_row.user_id
  left join public.teams employee_team on employee_team.id = employee.team_id
  left join public.work_schedules schedule on schedule.id = attendance_row.schedule_id
  left join public.profiles corrector on corrector.user_id = attendance_row.corrected_by
  where attendance_row.work_date between p_start_date and p_end_date
    and attendance_row.voided_at is null
  order by attendance_row.work_date desc, schedule.shift_start desc nulls last,
    attendance_row.clock_in desc nulls last, attendance_row.created_at desc;
end;
$function$

-- LIVE PRODUCTION SNAPSHOT
-- signature: workforce_service_create_invitation(uuid,uuid,text,text,text,jsonb,uuid,uuid)
-- md5: f8eccdb1d87343084b5c6242d53a618c
CREATE OR REPLACE FUNCTION public.workforce_service_create_invitation(p_actor_auth_user_id uuid, p_auth_user_id uuid, p_full_name text, p_email text, p_access_type text, p_permissions jsonb DEFAULT '{}'::jsonb, p_team_id uuid DEFAULT NULL::uuid, p_supervisor_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_result jsonb;
  v_actor_profile_id uuid;
  v_permission_key text;
  v_is_granted boolean;
begin
  v_result := public.workforce_service_create_invitation_legacy_payroll_bridge(
    p_actor_auth_user_id,
    p_auth_user_id,
    p_full_name,
    p_email,
    p_access_type,
    p_permissions,
    p_team_id,
    p_supervisor_id
  );

  select identity_link.profile_user_id
  into v_actor_profile_id
  from public.workforce_identity_links identity_link
  join public.profiles profile on profile.user_id = identity_link.profile_user_id
  where identity_link.auth_user_id = p_actor_auth_user_id
    and identity_link.is_active is true
    and profile.employment_status in ('active', 'on_leave')
    and profile.onboarding_status = 'active'
  order by (identity_link.profile_user_id = p_actor_auth_user_id) desc
  limit 1;

  foreach v_permission_key in array array[
    'manage_agent_rates',
    'create_payroll',
    'review_payroll',
    'finalize_payroll',
    'view_all_payslips',
    'view_own_payslips',
    'export_payslips',
    'reopen_payroll'
  ] loop
    v_is_granted := coalesce((p_permissions ->> v_permission_key)::boolean, false);

    insert into public.user_permissions (
      user_id, permission_key, is_granted, granted_by, reason
    ) values (
      p_auth_user_id,
      v_permission_key,
      v_is_granted,
      v_actor_profile_id,
      'Initial grant from unified invitation service'
    )
    on conflict (user_id, permission_key) do update
    set is_granted = excluded.is_granted,
        granted_by = excluded.granted_by,
        reason = excluded.reason,
        updated_at = now();
  end loop;

  return v_result;
end;
$function$
