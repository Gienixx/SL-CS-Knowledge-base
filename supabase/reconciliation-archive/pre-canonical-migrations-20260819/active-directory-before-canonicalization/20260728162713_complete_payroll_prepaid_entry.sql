-- Complete Phase 2 Step 5 with a permission-aware payroll entry point for
-- creating or updating a real source schedule and approving its exact version.

begin;

create function public.payroll_save_and_approve_prepaid_schedule(
  p_payroll_period_id uuid,
  p_employee_id uuid,
  p_work_date date,
  p_prepaid_login time without time zone,
  p_prepaid_logout time without time zone,
  p_timezone text,
  p_approval_reason text,
  p_allow_schedule_change boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := public.workforce_current_profile_id();
  v_period public.payroll_periods%rowtype;
  v_record public.payroll_records%rowtype;
  v_profile public.profiles%rowtype;
  v_schedule public.work_schedules%rowtype;
  v_before_schedule public.work_schedules%rowtype;
  v_reason text := nullif(trim(p_approval_reason), '');
  v_timezone text := nullif(trim(p_timezone), '');
  v_local_start timestamp without time zone;
  v_local_end timestamp without time zone;
  v_shift_start timestamptz;
  v_shift_end timestamptz;
  v_schedule_count integer := 0;
  v_schedule_action text := 'existing';
  v_schedule_changed boolean := false;
  v_current_snapshot_id uuid;
  v_snapshot_id uuid;
  v_prepaid_hour_id uuid;
begin
  if auth.uid() is null
     or v_actor_user_id is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_has_permission('create_payroll') then
    raise exception
      using
        errcode = '42501',
        message = 'You do not have permission to add payroll prepaid schedules.';
  end if;

  if p_payroll_period_id is null
     or p_employee_id is null
     or p_work_date is null then
    raise exception
      using
        errcode = '22023',
        message = 'Payroll period, employee, and work date are required.';
  end if;

  if p_prepaid_login is null or p_prepaid_logout is null then
    raise exception
      using
        errcode = '22023',
        message = 'Prepaid login and logout times are required.';
  end if;

  if v_timezone is null or length(v_timezone) > 100 then
    raise exception
      using
        errcode = '22023',
        message = 'A valid schedule timezone is required.';
  end if;

  if v_reason is null then
    raise exception
      using
        errcode = '22023',
        message = 'A prepaid schedule approval reason is required.';
  end if;

  if length(v_reason) > 500 then
    raise exception
      using
        errcode = '22023',
        message = 'The approval reason cannot exceed 500 characters.';
  end if;

  begin
    perform pg_catalog.now() at time zone v_timezone;
  exception
    when invalid_parameter_value then
      raise exception
        using
          errcode = '22023',
          message = 'The selected schedule timezone is not valid.';
  end;

  v_local_start := p_work_date::timestamp + p_prepaid_login;
  v_local_end :=
    p_work_date::timestamp
    + p_prepaid_logout
    + case
        when p_prepaid_logout <= p_prepaid_login then interval '1 day'
        else interval '0 days'
      end;
  v_shift_start := v_local_start at time zone v_timezone;
  v_shift_end := v_local_end at time zone v_timezone;

  if v_shift_end <= v_shift_start
     or v_shift_end - v_shift_start > interval '24 hours' then
    raise exception
      using
        errcode = '22023',
        message = 'Prepaid times must create a positive shift of no more than 24 hours.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.payroll_prepaid_entry:'
      || p_payroll_period_id::text
      || ':'
      || p_employee_id::text
      || ':'
      || p_work_date::text,
      0
    )
  );

  select period.*
  into v_period
  from public.payroll_periods as period
  where period.id = p_payroll_period_id
  for update;

  if not found then
    raise exception
      using errcode = 'P0002', message = 'Payroll period was not found.';
  end if;

  if v_period.status not in ('draft', 'reopened') then
    raise exception
      using
        errcode = '55000',
        message = 'Prepaid schedules can only be added to draft or reopened payroll periods.';
  end if;

  if p_work_date <= v_period.payment_date
     or p_work_date > v_period.period_end then
    raise exception
      using
        errcode = '22023',
        message = 'The prepaid work date must be after payment and on or before the payroll cutoff.';
  end if;

  select record.*
  into v_record
  from public.payroll_records as record
  where record.payroll_period_id = v_period.id
    and record.employee_id = p_employee_id
    and record.status <> 'void'
  for update;

  if not found then
    raise exception
      using
        errcode = '22023',
        message = 'The selected employee is not loaded in this payroll period.';
  end if;

  select profile.*
  into v_profile
  from public.profiles as profile
  where profile.user_id = p_employee_id;

  if not found
     or v_profile.is_agent is not true
     or v_profile.employment_status not in ('active', 'on_leave') then
    raise exception
      using
        errcode = '22023',
        message = 'Prepaid schedules require an active or on-leave agent.';
  end if;

  if exists (
    select 1
    from public.attendance as attendance_row
    where attendance_row.user_id = p_employee_id
      and attendance_row.work_date = p_work_date
  ) then
    raise exception
      using
        errcode = '22023',
        message = 'Attendance already exists for this employee and date. Import approved attendance instead.';
  end if;

  perform 1
  from public.work_schedules as schedule
  where schedule.user_id = p_employee_id
    and schedule.shift_date = p_work_date
  order by schedule.id
  for update;

  select count(*)::integer
  into v_schedule_count
  from public.work_schedules as schedule
  where schedule.user_id = p_employee_id
    and schedule.shift_date = p_work_date;

  if v_schedule_count > 1 then
    raise exception
      using
        errcode = '22023',
        message = 'Multiple schedules exist for this employee and date. Resolve them in Team Attendance before prepaid approval.';
  end if;

  if v_schedule_count = 0 then
    if not public.workforce_can_manage_user(
      p_employee_id,
      'manage_schedules'
    ) then
      raise exception
        using
          errcode = '42501',
          message = 'A schedule manager must create the source schedule before payroll can approve it.';
    end if;

    insert into public.work_schedules (
      user_id,
      team_id,
      shift_date,
      shift_sequence,
      shift_start,
      shift_end,
      timezone,
      status,
      is_rest_day,
      is_holiday,
      holiday_name,
      notes,
      created_by,
      updated_by
    )
    values (
      p_employee_id,
      v_profile.team_id,
      p_work_date,
      1,
      v_shift_start,
      v_shift_end,
      v_timezone,
      'published',
      false,
      false,
      null,
      'Created from payroll prepaid schedule entry.',
      v_actor_user_id,
      v_actor_user_id
    )
    returning * into v_schedule;

    v_schedule_action := 'created';
  else
    select schedule.*
    into v_schedule
    from public.work_schedules as schedule
    where schedule.user_id = p_employee_id
      and schedule.shift_date = p_work_date;

    if v_schedule.is_rest_day then
      raise exception
        using
          errcode = '22023',
          message = 'Rest days do not create prepaid-hour debt.';
    end if;

    if v_schedule.is_holiday then
      raise exception
        using
          errcode = '22023',
          message = 'Guaranteed special days do not create prepaid-hour debt.';
    end if;

    if v_schedule.status in ('cancelled', 'completed') then
      raise exception
        using
          errcode = '22023',
          message = 'Cancelled or completed schedules cannot be used as payroll pre-plots.';
    end if;

    v_schedule_changed :=
      v_schedule.shift_start is distinct from v_shift_start
      or v_schedule.shift_end is distinct from v_shift_end
      or v_schedule.timezone is distinct from v_timezone
      or v_schedule.status = 'scheduled';

    if v_schedule_changed then
      if not coalesce(p_allow_schedule_change, false) then
        raise exception
          using
            errcode = '22023',
            message = 'The prepaid values differ from the source schedule. Confirm the schedule update before approval.';
      end if;

      if not public.workforce_can_manage_user(
        p_employee_id,
        'manage_schedules'
      ) then
        raise exception
          using
            errcode = '42501',
            message = 'A schedule manager must publish or change the source schedule before payroll can approve it.';
      end if;

      v_before_schedule := v_schedule;

      update public.work_schedules
      set
        shift_start = v_shift_start,
        shift_end = v_shift_end,
        timezone = v_timezone,
        status = case
          when v_schedule.status = 'scheduled' then 'published'
          else 'changed'
        end,
        updated_by = v_actor_user_id,
        updated_at = pg_catalog.now()
      where id = v_schedule.id
      returning * into v_schedule;

      v_schedule_action := case
        when v_before_schedule.status = 'scheduled' then 'published'
        else 'updated'
      end;
    elsif v_schedule.status not in ('published', 'changed') then
      raise exception
        using
          errcode = '22023',
          message = 'Only published or changed schedules may be approved as payroll pre-plots.';
    end if;
  end if;

  select snapshot.id
  into v_current_snapshot_id
  from public.payroll_schedule_snapshots as snapshot
  where snapshot.payroll_record_id = v_record.id
    and snapshot.employee_id = p_employee_id
    and snapshot.schedule_id = v_schedule.id
    and snapshot.schedule_version = v_schedule.schedule_version
  order by snapshot.approved_at desc
  limit 1;

  if v_current_snapshot_id is not null then
    return jsonb_build_object(
      'payroll_period_id', v_period.id,
      'payroll_record_id', v_record.id,
      'employee_id', p_employee_id,
      'schedule_id', v_schedule.id,
      'schedule_version', v_schedule.schedule_version,
      'schedule_snapshot_id', v_current_snapshot_id,
      'schedule_action', 'existing',
      'approved_schedule_count', 0,
      'already_current_count', 1
    );
  end if;

  if exists (
    select 1
    from public.payroll_schedule_snapshots as snapshot
    where snapshot.payroll_record_id = v_record.id
      and snapshot.employee_id = p_employee_id
      and snapshot.work_date = p_work_date
      and snapshot.schedule_id <> v_schedule.id
  ) then
    raise exception
      using
        errcode = '22023',
        message = 'Another prepaid schedule is already approved for this employee and date.';
  end if;

  insert into public.payroll_schedule_snapshots (
    payroll_record_id,
    schedule_id,
    employee_id,
    work_date,
    shift_start,
    shift_end,
    timezone,
    schedule_status,
    is_rest_day,
    is_holiday,
    holiday_name,
    schedule_version,
    schedule_updated_at,
    approved_by,
    approved_at,
    approval_reason,
    source_type,
    source_metadata
  )
  values (
    v_record.id,
    v_schedule.id,
    p_employee_id,
    p_work_date,
    v_schedule.shift_start,
    v_schedule.shift_end,
    v_schedule.timezone,
    v_schedule.status,
    v_schedule.is_rest_day,
    v_schedule.is_holiday,
    v_schedule.holiday_name,
    v_schedule.schedule_version,
    v_schedule.updated_at,
    v_actor_user_id,
    pg_catalog.now(),
    v_reason,
    'website_schedule',
    jsonb_build_object(
      'entry_mode', 'payroll_prepaid_form',
      'schedule_action', v_schedule_action
    )
  )
  returning id into v_snapshot_id;

  select prepaid.id
  into v_prepaid_hour_id
  from public.payroll_prepaid_hours as prepaid
  where prepaid.source_schedule_snapshot_id = v_snapshot_id;

  if v_schedule_action <> 'existing' then
    insert into public.payroll_audit_logs (
      actor_user_id,
      action,
      entity_type,
      entity_id,
      payroll_period_id,
      payroll_record_id,
      before_data,
      after_data,
      reason,
      metadata
    )
    values (
      v_actor_user_id,
      'payroll_prepaid_source_schedule_' || v_schedule_action,
      'work_schedule',
      v_schedule.id,
      v_period.id,
      v_record.id,
      case
        when v_schedule_action = 'created' then null
        else to_jsonb(v_before_schedule)
      end,
      to_jsonb(v_schedule),
      v_reason,
      jsonb_build_object(
        'source', 'payroll_prepaid_form',
        'required_permission', 'manage_schedules'
      )
    );
  end if;

  insert into public.payroll_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    payroll_period_id,
    payroll_record_id,
    after_data,
    reason,
    metadata
  )
  values (
    v_actor_user_id,
    'payroll_preplots_approved',
    'payroll_schedule_snapshot',
    v_snapshot_id,
    v_period.id,
    v_record.id,
    jsonb_build_object(
      'schedule_snapshot_id', v_snapshot_id,
      'prepaid_hour_id', v_prepaid_hour_id,
      'schedule_id', v_schedule.id,
      'schedule_version', v_schedule.schedule_version
    ),
    v_reason,
    jsonb_build_object(
      'approved_schedule_count', 1,
      'already_current_count', 0,
      'source', 'payroll_prepaid_form',
      'schedule_action', v_schedule_action
    )
  );

  return jsonb_build_object(
    'payroll_period_id', v_period.id,
    'payroll_record_id', v_record.id,
    'employee_id', p_employee_id,
    'schedule_id', v_schedule.id,
    'schedule_version', v_schedule.schedule_version,
    'schedule_snapshot_id', v_snapshot_id,
    'prepaid_hour_id', v_prepaid_hour_id,
    'schedule_action', v_schedule_action,
    'approved_schedule_count', 1,
    'already_current_count', 0
  );
end;
$$;

revoke all on function public.payroll_save_and_approve_prepaid_schedule(
  uuid,
  uuid,
  date,
  time without time zone,
  time without time zone,
  text,
  text,
  boolean
) from public, anon;

grant execute on function public.payroll_save_and_approve_prepaid_schedule(
  uuid,
  uuid,
  date,
  time without time zone,
  time without time zone,
  text,
  text,
  boolean
) to authenticated, service_role;

comment on function public.payroll_save_and_approve_prepaid_schedule(
  uuid,
  uuid,
  date,
  time without time zone,
  time without time zone,
  text,
  text,
  boolean
) is
  'Creates or permission-checks a real source schedule, then snapshots its exact version as approved prepaid hours without creating attendance.';

commit;
