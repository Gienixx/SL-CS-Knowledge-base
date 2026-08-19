-- Phase 2 Step 8: permission-scoped payroll exception review.
-- The RPC returns issue metadata only. Rate amounts and calculated pay values
-- are intentionally excluded from this review surface.

begin;

create or replace function public.payroll_get_period_exceptions(
  p_payroll_period_id uuid
)
returns table (
  exception_key text,
  exception_code text,
  exception_label text,
  severity text,
  is_blocking boolean,
  employee_user_id uuid,
  employee_name text,
  employee_number text,
  work_date date,
  attendance_id uuid,
  schedule_id uuid,
  payroll_record_id uuid,
  message text,
  details jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_period public.payroll_periods%rowtype;
begin
  if auth.uid() is null
     or public.workforce_current_profile_id() is null
     or not public.workforce_current_user_is_active()
     or not (
       public.workforce_has_permission('create_payroll')
       or public.workforce_has_permission('review_payroll')
       or public.workforce_has_permission('finalize_payroll')
       or public.workforce_has_permission('reopen_payroll')
     ) then
    raise exception
      using
        errcode = '42501',
        message = 'You do not have permission to review payroll exceptions.';
  end if;

  if p_payroll_period_id is null then
    raise exception
      using errcode = '22023', message = 'Payroll period is required.';
  end if;

  select period.*
  into v_period
  from public.payroll_periods as period
  where period.id = p_payroll_period_id;

  if not found then
    raise exception
      using errcode = 'P0002', message = 'Payroll period was not found.';
  end if;

  return query
  with period_records as materialized (
    select
      record.id as payroll_record_id,
      record.employee_id,
      record.requires_recalculation,
      record.recalculation_reason,
      profile.full_name as employee_name,
      profile.employee_id as employee_number
    from public.payroll_records as record
    join public.profiles as profile
      on profile.user_id = record.employee_id
    where record.payroll_period_id = v_period.id
      and record.status <> 'void'
  ),
  period_attendance as materialized (
    select
      record.payroll_record_id,
      record.employee_id,
      record.employee_name,
      record.employee_number,
      attendance_row.id as attendance_id,
      attendance_row.schedule_id,
      attendance_row.work_date,
      attendance_row.clock_in,
      attendance_row.clock_out,
      attendance_row.review_status,
      attendance_row.total_overtime_minutes,
      attendance_row.attendance_version,
      readiness.is_payroll_ready,
      readiness.payroll_readiness_blockers
    from period_records as record
    join public.attendance as attendance_row
      on attendance_row.user_id = record.employee_id
     and attendance_row.work_date
       between v_period.period_start and v_period.period_end
    join public.workforce_attendance_payroll_readiness as readiness
      on readiness.id = attendance_row.id
  ),
  active_schedules as materialized (
    select
      record.payroll_record_id,
      record.employee_id,
      record.employee_name,
      record.employee_number,
      schedule.id as schedule_id,
      schedule.shift_date,
      schedule.shift_start,
      schedule.shift_end
    from period_records as record
    join public.work_schedules as schedule
      on schedule.user_id = record.employee_id
     and schedule.shift_date
       between v_period.period_start and v_period.period_end
    where schedule.status in ('published', 'changed', 'completed')
      and schedule.is_rest_day is false
      and schedule.shift_start is not null
      and schedule.shift_end is not null
  ),
  latest_snapshots as materialized (
    select
      snapshot.payroll_record_id,
      snapshot.attendance_id,
      max(snapshot.attendance_version) as attendance_version
    from public.payroll_attendance_snapshots as snapshot
    join period_records as record
      on record.payroll_record_id = snapshot.payroll_record_id
    group by snapshot.payroll_record_id, snapshot.attendance_id
  ),
  stale_snapshot_records as materialized (
    select
      record.payroll_record_id,
      record.employee_id,
      record.employee_name,
      record.employee_number,
      attendance_row.id as attendance_id,
      attendance_row.schedule_id,
      attendance_row.work_date,
      snapshot.attendance_version as imported_version,
      attendance_row.attendance_version as current_version
    from latest_snapshots as snapshot
    join period_records as record
      on record.payroll_record_id = snapshot.payroll_record_id
    join public.attendance as attendance_row
      on attendance_row.id = snapshot.attendance_id
    where snapshot.attendance_version < attendance_row.attendance_version
  ),
  exception_rows as (
    -- A rate must exist on or before every attendance work date.
    select
      format(
        'missing_rate:%s:%s',
        attendance_row.employee_id,
        attendance_row.work_date
      ) as exception_key,
      'missing_rate'::text as exception_code,
      'Missing rate'::text as exception_label,
      'blocking'::text as severity,
      true as is_blocking,
      attendance_row.employee_id as employee_user_id,
      attendance_row.employee_name,
      attendance_row.employee_number,
      attendance_row.work_date,
      attendance_row.attendance_id,
      attendance_row.schedule_id,
      attendance_row.payroll_record_id,
      'No effective rate covers this attendance date.'::text as message,
      jsonb_build_object(
        'required_effective_date', attendance_row.work_date
      ) as details
    from period_attendance as attendance_row
    where not exists (
      select 1
      from public.agent_rates as rate
      where rate.employee_id = attendance_row.employee_id
        and rate.effective_date <= attendance_row.work_date
    )

    union all

    -- Employees without attendance still require a rate for the period.
    select
      format(
        'missing_rate:%s:%s',
        record.employee_id,
        v_period.period_end
      ),
      'missing_rate'::text,
      'Missing rate'::text,
      'blocking'::text,
      true,
      record.employee_id,
      record.employee_name,
      record.employee_number,
      v_period.period_end,
      null::uuid,
      null::uuid,
      record.payroll_record_id,
      'No effective rate is available for this payroll period.'::text,
      jsonb_build_object(
        'required_effective_date', v_period.period_end,
        'attendance_record_count', 0
      )
    from period_records as record
    where not exists (
      select 1
      from period_attendance as attendance_row
      where attendance_row.payroll_record_id = record.payroll_record_id
    )
      and not exists (
        select 1
        from public.agent_rates as rate
        where rate.employee_id = record.employee_id
          and rate.effective_date <= v_period.period_end
      )

    union all

    select
      format('incomplete_attendance:%s', attendance_row.attendance_id),
      'incomplete_attendance'::text,
      'Incomplete attendance'::text,
      'blocking'::text,
      true,
      attendance_row.employee_id,
      attendance_row.employee_name,
      attendance_row.employee_number,
      attendance_row.work_date,
      attendance_row.attendance_id,
      attendance_row.schedule_id,
      attendance_row.payroll_record_id,
      'Attendance is not payroll-ready.'::text,
      jsonb_build_object(
        'blockers', attendance_row.payroll_readiness_blockers
      )
    from period_attendance as attendance_row
    where not attendance_row.is_payroll_ready

    union all

    select
      format('unapproved_attendance:%s', attendance_row.attendance_id),
      'unapproved_attendance'::text,
      'Unapproved attendance'::text,
      'blocking'::text,
      true,
      attendance_row.employee_id,
      attendance_row.employee_name,
      attendance_row.employee_number,
      attendance_row.work_date,
      attendance_row.attendance_id,
      attendance_row.schedule_id,
      attendance_row.payroll_record_id,
      'Attendance must be approved or locked before payroll.'::text,
      jsonb_build_object(
        'review_status', attendance_row.review_status
      )
    from period_attendance as attendance_row
    where attendance_row.review_status not in ('approved', 'locked')

    union all

    select
      format('missing_clock_out:%s', attendance_row.attendance_id),
      'missing_clock_out'::text,
      'Missing clock-out'::text,
      'blocking'::text,
      true,
      attendance_row.employee_id,
      attendance_row.employee_name,
      attendance_row.employee_number,
      attendance_row.work_date,
      attendance_row.attendance_id,
      attendance_row.schedule_id,
      attendance_row.payroll_record_id,
      'Clock-out is missing for this attendance entry.'::text,
      jsonb_build_object(
        'clock_in', attendance_row.clock_in
      )
    from period_attendance as attendance_row
    where attendance_row.clock_in is not null
      and attendance_row.clock_out is null

    union all

    select
      format(
        'overtime_above_limit:%s:%s',
        attendance_row.employee_id,
        attendance_row.work_date
      ),
      'overtime_above_limit'::text,
      'Overtime above limit'::text,
      'blocking'::text,
      true,
      attendance_row.employee_id,
      attendance_row.employee_name,
      attendance_row.employee_number,
      attendance_row.work_date,
      (
        array_agg(
          attendance_row.attendance_id
          order by attendance_row.attendance_id
        )
      )[1],
      null::uuid,
      attendance_row.payroll_record_id,
      'Total overtime exceeds the 20-hour work-date limit.'::text,
      jsonb_build_object(
        'total_overtime_minutes',
        sum(attendance_row.total_overtime_minutes),
        'limit_minutes',
        1200
      )
    from period_attendance as attendance_row
    group by
      attendance_row.payroll_record_id,
      attendance_row.employee_id,
      attendance_row.employee_name,
      attendance_row.employee_number,
      attendance_row.work_date
    having sum(attendance_row.total_overtime_minutes) > 1200

    union all

    select
      format(
        'duplicate_attendance:%s:%s:%s:%s',
        attendance_row.employee_id,
        attendance_row.work_date,
        attendance_row.clock_in,
        attendance_row.clock_out
      ),
      'duplicate_attendance'::text,
      'Duplicate attendance'::text,
      'blocking'::text,
      true,
      attendance_row.employee_id,
      attendance_row.employee_name,
      attendance_row.employee_number,
      attendance_row.work_date,
      (
        array_agg(
          attendance_row.attendance_id
          order by attendance_row.attendance_id
        )
      )[1],
      (
        array_agg(
          attendance_row.schedule_id
          order by attendance_row.schedule_id
        ) filter (where attendance_row.schedule_id is not null)
      )[1],
      attendance_row.payroll_record_id,
      'Multiple attendance entries use the same clock-in and clock-out.'::text,
      jsonb_build_object(
        'duplicate_count', count(*),
        'clock_in', attendance_row.clock_in,
        'clock_out', attendance_row.clock_out
      )
    from period_attendance as attendance_row
    where attendance_row.clock_in is not null
      and attendance_row.clock_out is not null
    group by
      attendance_row.payroll_record_id,
      attendance_row.employee_id,
      attendance_row.employee_name,
      attendance_row.employee_number,
      attendance_row.work_date,
      attendance_row.clock_in,
      attendance_row.clock_out
    having count(*) > 1

    union all

    select
      format(
        'overlapping_schedules:%s:%s:%s',
        earlier.employee_id,
        earlier.schedule_id,
        later.schedule_id
      ),
      'overlapping_schedules'::text,
      'Overlapping schedules'::text,
      'blocking'::text,
      true,
      earlier.employee_id,
      earlier.employee_name,
      earlier.employee_number,
      least(earlier.shift_date, later.shift_date),
      null::uuid,
      earlier.schedule_id,
      earlier.payroll_record_id,
      'Two active schedules overlap for this employee.'::text,
      jsonb_build_object(
        'first_schedule_id', earlier.schedule_id,
        'second_schedule_id', later.schedule_id,
        'first_shift_start', earlier.shift_start,
        'first_shift_end', earlier.shift_end,
        'second_shift_start', later.shift_start,
        'second_shift_end', later.shift_end
      )
    from active_schedules as earlier
    join active_schedules as later
      on later.employee_id = earlier.employee_id
     and later.schedule_id > earlier.schedule_id
     and tstzrange(
       earlier.shift_start,
       earlier.shift_end,
       '[)'
     ) && tstzrange(
       later.shift_start,
       later.shift_end,
       '[)'
     )

    union all

    select
      format(
        'payroll_period_overlap:%s:%s',
        v_period.id,
        other_period.id
      ),
      'payroll_period_overlap'::text,
      'Payroll-period overlap'::text,
      'blocking'::text,
      true,
      null::uuid,
      null::text,
      null::text,
      null::date,
      null::uuid,
      null::uuid,
      null::uuid,
      'This payroll period overlaps another active payroll period.'::text,
      jsonb_build_object(
        'overlapping_payroll_period_id', other_period.id,
        'overlapping_period_start', other_period.period_start,
        'overlapping_period_end', other_period.period_end,
        'overlapping_period_status', other_period.status
      )
    from public.payroll_periods as other_period
    where other_period.id <> v_period.id
      and other_period.status <> 'void'
      and daterange(
        other_period.period_start,
        other_period.period_end,
        '[]'
      ) && daterange(
        v_period.period_start,
        v_period.period_end,
        '[]'
      )

    union all

    select
      format('changed_attendance_after_import:%s', stale.attendance_id),
      'changed_attendance_after_import'::text,
      'Changed attendance after import'::text,
      'blocking'::text,
      true,
      stale.employee_id,
      stale.employee_name,
      stale.employee_number,
      stale.work_date,
      stale.attendance_id,
      stale.schedule_id,
      stale.payroll_record_id,
      'Attendance changed after its latest payroll snapshot.'::text,
      jsonb_build_object(
        'imported_attendance_version', stale.imported_version,
        'current_attendance_version', stale.current_version
      )
    from stale_snapshot_records as stale

    union all

    -- A re-import preserves the flag until Step 7 recalculates the record.
    select
      format(
        'changed_attendance_after_import:record:%s',
        record.payroll_record_id
      ),
      'changed_attendance_after_import'::text,
      'Changed attendance after import'::text,
      'blocking'::text,
      true,
      record.employee_id,
      record.employee_name,
      record.employee_number,
      null::date,
      null::uuid,
      null::uuid,
      record.payroll_record_id,
      coalesce(
        nullif(record.recalculation_reason, ''),
        'Payroll requires recalculation after an attendance change.'
      )::text,
      jsonb_build_object(
        'requires_recalculation', true,
        'latest_attendance_versions_imported', true
      )
    from period_records as record
    where record.requires_recalculation
      and not exists (
        select 1
        from stale_snapshot_records as stale
        where stale.payroll_record_id = record.payroll_record_id
      )

    union all

    select
      format('missing_attendance:%s', schedule.schedule_id),
      'missing_attendance'::text,
      'Missing attendance'::text,
      'blocking'::text,
      true,
      schedule.employee_id,
      schedule.employee_name,
      schedule.employee_number,
      schedule.shift_date,
      null::uuid,
      schedule.schedule_id,
      schedule.payroll_record_id,
      'No attendance entry is linked to this scheduled shift.'::text,
      jsonb_build_object(
        'shift_start', schedule.shift_start,
        'shift_end', schedule.shift_end
      )
    from active_schedules as schedule
    where not exists (
      select 1
      from public.attendance as attendance_row
      where attendance_row.user_id = schedule.employee_id
        and attendance_row.schedule_id = schedule.schedule_id
    )
  )
  select
    issue.exception_key,
    issue.exception_code,
    issue.exception_label,
    issue.severity,
    issue.is_blocking,
    issue.employee_user_id,
    issue.employee_name,
    issue.employee_number,
    issue.work_date,
    issue.attendance_id,
    issue.schedule_id,
    issue.payroll_record_id,
    issue.message,
    issue.details
  from exception_rows as issue
  order by
    issue.is_blocking desc,
    issue.work_date nulls first,
    issue.employee_name nulls first,
    issue.exception_label,
    issue.exception_key;
end;
$$;

revoke all on function public.payroll_get_period_exceptions(uuid)
  from public, anon;
grant execute on function public.payroll_get_period_exceptions(uuid)
  to authenticated, service_role;

comment on function public.payroll_get_period_exceptions(uuid) is
  'Returns permission-scoped Step 8 payroll exceptions without exposing rate amounts or calculated pay values.';

commit;
