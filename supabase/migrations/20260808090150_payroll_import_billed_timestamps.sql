create or replace function public.payroll_import_attendance(
  p_payroll_period_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := public.workforce_current_profile_id();
  v_period public.payroll_periods%rowtype;
  v_employee_record_count bigint := 0;
  v_total_ready_count bigint := 0;
  v_new_snapshot_count bigint := 0;
  v_current_snapshot_count bigint := 0;
  v_incomplete_attendance_count bigint := 0;
  v_missing_attendance_count bigint := 0;
  v_records_with_snapshots bigint := 0;
begin
  if auth.uid() is null
     or v_actor_user_id is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_has_permission('create_payroll') then
    raise exception
      using
        errcode = '42501',
        message = 'You do not have permission to import payroll attendance.';
  end if;

  if p_payroll_period_id is null then
    raise exception
      using errcode = '22023', message = 'Payroll period is required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.payroll_import_attendance:' || p_payroll_period_id::text,
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
        message = 'Attendance can only be imported into draft or reopened payroll periods.';
  end if;

  select count(*)
  into v_employee_record_count
  from public.payroll_records as record
  where record.payroll_period_id = v_period.id
    and record.status not in ('finalized', 'void');

  select
    count(*) filter (where readiness.is_payroll_ready),
    count(*) filter (where not readiness.is_payroll_ready)
  into
    v_total_ready_count,
    v_incomplete_attendance_count
  from public.payroll_records as record
  join public.workforce_attendance_payroll_readiness as readiness
    on readiness.user_id = record.employee_id
   and readiness.work_date between v_period.period_start and v_period.period_end
  where record.payroll_period_id = v_period.id
    and record.status not in ('finalized', 'void');

  select count(*)
  into v_missing_attendance_count
  from public.payroll_records as record
  join public.work_schedules as schedule
    on schedule.user_id = record.employee_id
   and schedule.shift_date between v_period.period_start and v_period.period_end
   and schedule.status in ('published', 'changed', 'completed')
   and schedule.is_rest_day is false
   and schedule.is_holiday is false
  where record.payroll_period_id = v_period.id
    and record.status not in ('finalized', 'void')
    and not exists (
      select 1
      from public.attendance as attendance_row
      where attendance_row.user_id = record.employee_id
        and attendance_row.schedule_id = schedule.id
    );

  with source_rows as materialized (
    select
      record.id as payroll_record_id,
      attendance_row.id as attendance_id,
      attendance_row.user_id as employee_id,
      attendance_row.schedule_id,
      attendance_row.work_date,
      attendance_row.billed_clock_in as billed_clock_in,
      attendance_row.billed_clock_out as billed_clock_out,
      attendance_row.regular_minutes,
      attendance_row.pre_shift_overtime_minutes,
      attendance_row.post_shift_overtime_minutes,
      attendance_row.total_overtime_minutes,
      attendance_row.minutes_late,
      attendance_row.undertime_minutes,
      attendance_row.attendance_version,
      attendance_row.updated_at as attendance_updated_at
    from public.payroll_records as record
    join public.attendance as attendance_row
      on attendance_row.user_id = record.employee_id
     and attendance_row.work_date
       between v_period.period_start and v_period.period_end
    join public.workforce_attendance_payroll_readiness as readiness
      on readiness.id = attendance_row.id
     and readiness.is_payroll_ready
    where record.payroll_period_id = v_period.id
      and record.status not in ('finalized', 'void')
    for share of attendance_row
  ),
  inserted as (
    insert into public.payroll_attendance_snapshots (
      payroll_record_id,
      attendance_id,
      employee_id,
      schedule_id,
      work_date,
      clock_in,
      clock_out,
      regular_minutes,
      pre_shift_overtime_minutes,
      post_shift_overtime_minutes,
      total_overtime_minutes,
      late_minutes,
      undertime_minutes,
      attendance_version,
      attendance_updated_at,
      imported_at
    )
    select
      source.payroll_record_id,
      source.attendance_id,
      source.employee_id,
      source.schedule_id,
      source.work_date,
      source.billed_clock_in,
      source.billed_clock_out,
      source.regular_minutes,
      source.pre_shift_overtime_minutes,
      source.post_shift_overtime_minutes,
      source.total_overtime_minutes,
      source.minutes_late,
      source.undertime_minutes,
      source.attendance_version,
      source.attendance_updated_at,
      now()
    from source_rows as source
    on conflict (
      payroll_record_id,
      attendance_id,
      attendance_version
    ) do nothing
    returning id
  )
  select count(*)
  into v_new_snapshot_count
  from inserted;

  select
    count(*),
    count(distinct snapshot.payroll_record_id)
  into
    v_current_snapshot_count,
    v_records_with_snapshots
  from public.payroll_attendance_snapshots as snapshot
  join public.attendance as attendance_row
    on attendance_row.id = snapshot.attendance_id
   and attendance_row.attendance_version = snapshot.attendance_version
  join public.payroll_records as record
    on record.id = snapshot.payroll_record_id
  where record.payroll_period_id = v_period.id;

  insert into public.payroll_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    payroll_period_id,
    after_data,
    reason,
    metadata
  )
  values (
    v_actor_user_id,
    'payroll_attendance_imported',
    'payroll_period',
    v_period.id,
    v_period.id,
    jsonb_build_object(
      'new_snapshot_count', v_new_snapshot_count,
      'current_snapshot_count', v_current_snapshot_count,
      'payroll_ready_attendance_count', v_total_ready_count
    ),
    'Imported payroll-ready attendance into immutable payroll snapshots',
    jsonb_build_object(
      'employee_record_count', v_employee_record_count,
      'records_with_snapshots', v_records_with_snapshots,
      'incomplete_attendance_count', v_incomplete_attendance_count,
      'missing_attendance_count', v_missing_attendance_count,
      'source', 'payroll_period'
    )
  );

  return jsonb_build_object(
    'payroll_period_id', v_period.id,
    'employee_record_count', v_employee_record_count,
    'payroll_ready_attendance_count', v_total_ready_count,
    'new_snapshot_count', v_new_snapshot_count,
    'already_current_snapshot_count',
      greatest(v_current_snapshot_count - v_new_snapshot_count, 0),
    'current_snapshot_count', v_current_snapshot_count,
    'records_with_snapshots', v_records_with_snapshots,
    'incomplete_attendance_count', v_incomplete_attendance_count,
    'missing_attendance_count', v_missing_attendance_count,
    'imported_at', now()
  );
end;
$$;
revoke all on function public.payroll_import_attendance(uuid) from public, anon;
grant execute on function public.payroll_import_attendance(uuid) to authenticated, service_role;
