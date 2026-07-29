-- Phase 2 Step 8: complete payroll exception review for prepaid hours.
-- Keep the original attendance/rate checks private, then expose one
-- permission-scoped RPC that also validates pre-plot provenance, balances,
-- schedule versions, and hour allocations.

begin;

alter function public.payroll_get_period_exceptions(uuid)
  rename to payroll_get_period_exceptions_attendance;

revoke all on function public.payroll_get_period_exceptions_attendance(uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_get_period_exceptions_attendance(uuid)
  to service_role;

create function public.payroll_get_period_exceptions(
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
      profile.full_name as employee_name,
      profile.employee_id as employee_number
    from public.payroll_records as record
    join public.profiles as profile
      on profile.user_id = record.employee_id
    where record.payroll_period_id = v_period.id
      and record.status <> 'void'
  ),
  active_prepaid as materialized (
    select
      prepaid.id as prepaid_hour_id,
      prepaid.source_payroll_record_id as payroll_record_id,
      prepaid.source_schedule_snapshot_id,
      prepaid.employee_id,
      prepaid.prepaid_minutes,
      prepaid.settled_minutes,
      prepaid.remaining_minutes,
      record.employee_name,
      record.employee_number,
      snapshot.work_date,
      snapshot.schedule_id,
      snapshot.shift_start,
      snapshot.shift_end,
      snapshot.timezone,
      snapshot.scheduled_minutes,
      snapshot.schedule_status,
      snapshot.is_rest_day,
      snapshot.is_holiday,
      snapshot.schedule_version as snapshot_schedule_version,
      snapshot.approved_by,
      snapshot.approval_reason,
      snapshot.source_type,
      snapshot.source_reference,
      schedule.user_id as schedule_employee_id,
      schedule.schedule_version as current_schedule_version,
      schedule.shift_date as current_work_date,
      schedule.shift_start as current_shift_start,
      schedule.shift_end as current_shift_end,
      schedule.timezone as current_timezone,
      schedule.status as current_schedule_status,
      schedule.is_rest_day as current_is_rest_day,
      schedule.is_holiday as current_is_holiday
    from period_records as record
    join public.payroll_prepaid_hours as prepaid
      on prepaid.source_payroll_record_id = record.payroll_record_id
     and prepaid.employee_id = record.employee_id
     and prepaid.voided_at is null
    left join public.payroll_schedule_snapshots as snapshot
      on snapshot.id = prepaid.source_schedule_snapshot_id
     and snapshot.payroll_record_id = prepaid.source_payroll_record_id
     and snapshot.employee_id = prepaid.employee_id
    left join public.work_schedules as schedule
      on schedule.id = snapshot.schedule_id
  ),
  active_allocations as materialized (
    select
      allocation.id,
      allocation.prepaid_hour_id,
      allocation.employee_id,
      allocation.destination_payroll_record_id,
      allocation.attendance_snapshot_id,
      allocation.minute_category,
      allocation.allocated_minutes,
      allocation.calculation_version
    from public.payroll_hour_allocations as allocation
    where allocation.allocation_type = 'settlement'
      and not exists (
        select 1
        from public.payroll_hour_allocations as reversal
        where reversal.allocation_type = 'reversal'
          and reversal.reverses_allocation_id = allocation.id
      )
  ),
  duplicate_balances as materialized (
    select
      prepaid.employee_id,
      prepaid.schedule_id,
      count(*) as balance_count
    from active_prepaid as prepaid
    where prepaid.schedule_id is not null
    group by prepaid.employee_id, prepaid.schedule_id
    having count(*) > 1
  ),
  duplicate_allocations as materialized (
    select
      allocation.prepaid_hour_id,
      allocation.attendance_snapshot_id,
      allocation.minute_category,
      count(*) as allocation_count,
      jsonb_agg(
        allocation.id order by allocation.calculation_version, allocation.id
      ) as allocation_ids
    from active_allocations as allocation
    join active_prepaid as prepaid
      on prepaid.prepaid_hour_id = allocation.prepaid_hour_id
    group by
      allocation.prepaid_hour_id,
      allocation.attendance_snapshot_id,
      allocation.minute_category
    having count(*) > 1
  ),
  supplemental_issues as (
    select
      format(
        'schedule_changed_after_preplot_approval:%s',
        prepaid.prepaid_hour_id
      ) as exception_key,
      'schedule_changed_after_preplot_approval'::text as exception_code,
      'Schedule changed after pre-plot approval'::text as exception_label,
      'blocking'::text as severity,
      true as is_blocking,
      prepaid.employee_id as employee_user_id,
      prepaid.employee_name,
      prepaid.employee_number,
      prepaid.work_date,
      null::uuid as attendance_id,
      prepaid.schedule_id,
      prepaid.payroll_record_id,
      'The source schedule changed after this prepaid schedule was approved. Approve the current schedule version before calculation.'::text as message,
      jsonb_build_object(
        'prepaid_hour_id', prepaid.prepaid_hour_id,
        'schedule_snapshot_id', prepaid.source_schedule_snapshot_id,
        'approved_schedule_version', prepaid.snapshot_schedule_version,
        'current_schedule_version', prepaid.current_schedule_version
      ) as details
    from active_prepaid as prepaid
    where prepaid.source_schedule_snapshot_id is not null
      and (
        prepaid.current_schedule_version is distinct from
          prepaid.snapshot_schedule_version
        or prepaid.current_work_date is distinct from prepaid.work_date
        or prepaid.current_shift_start is distinct from prepaid.shift_start
        or prepaid.current_shift_end is distinct from prepaid.shift_end
        or prepaid.current_timezone is distinct from prepaid.timezone
        or prepaid.current_schedule_status is distinct from
          prepaid.schedule_status
        or prepaid.current_is_rest_day is distinct from prepaid.is_rest_day
        or prepaid.current_is_holiday is distinct from prepaid.is_holiday
      )

    union all

    select
      format('preplot_missing_payroll_approval:%s', schedule.id),
      'preplot_missing_payroll_approval'::text,
      'Pre-plot missing payroll approval'::text,
      'blocking'::text,
      true,
      record.employee_id,
      record.employee_name,
      record.employee_number,
      schedule.shift_date,
      null::uuid,
      schedule.id,
      record.payroll_record_id,
      'This future ordinary shift is included in early payroll but has not been explicitly approved as prepaid hours.'::text,
      jsonb_build_object(
        'schedule_version', schedule.schedule_version,
        'shift_start', schedule.shift_start,
        'shift_end', schedule.shift_end,
        'payment_date', v_period.payment_date
      )
    from period_records as record
    join public.work_schedules as schedule
      on schedule.user_id = record.employee_id
     and schedule.shift_date between v_period.period_start and v_period.period_end
    where schedule.shift_date > v_period.payment_date
      and schedule.status in ('published', 'changed')
      and not schedule.is_rest_day
      and not schedule.is_holiday
      and schedule.shift_start is not null
      and schedule.shift_end is not null
      and schedule.shift_end > schedule.shift_start
      and not exists (
        select 1
        from public.attendance as attendance_row
        where attendance_row.user_id = record.employee_id
          and attendance_row.schedule_id = schedule.id
      )
      and not exists (
        select 1
        from public.payroll_schedule_snapshots as snapshot
        where snapshot.payroll_record_id = record.payroll_record_id
          and snapshot.employee_id = record.employee_id
          and snapshot.schedule_id = schedule.id
          and snapshot.schedule_version = schedule.schedule_version
      )

    union all

    select
      format('invalid_preplot_minutes:%s', prepaid.prepaid_hour_id),
      'invalid_preplot_minutes'::text,
      'Invalid pre-plot minutes'::text,
      'blocking'::text,
      true,
      prepaid.employee_id,
      prepaid.employee_name,
      prepaid.employee_number,
      prepaid.work_date,
      null::uuid,
      prepaid.schedule_id,
      prepaid.payroll_record_id,
      'The prepaid balance does not match a valid ordinary scheduled shift.'::text,
      jsonb_build_object(
        'prepaid_hour_id', prepaid.prepaid_hour_id,
        'prepaid_minutes', prepaid.prepaid_minutes,
        'scheduled_minutes', prepaid.scheduled_minutes,
        'schedule_status', prepaid.schedule_status,
        'is_rest_day', prepaid.is_rest_day,
        'is_holiday', prepaid.is_holiday
      )
    from active_prepaid as prepaid
    where prepaid.source_schedule_snapshot_id is not null
      and (
        prepaid.prepaid_minutes <= 0
        or prepaid.scheduled_minutes is null
        or prepaid.scheduled_minutes <= 0
        or prepaid.prepaid_minutes <> prepaid.scheduled_minutes
        or prepaid.schedule_status not in ('published', 'changed', 'completed')
        or prepaid.is_rest_day
        or prepaid.is_holiday
        or prepaid.shift_start is null
        or prepaid.shift_end is null
        or prepaid.shift_end <= prepaid.shift_start
        or nullif(trim(prepaid.timezone), '') is null
        or prepaid.work_date not between v_period.period_start and v_period.period_end
      )

    union all

    select
      format('duplicate_hour_allocation:%s:%s:%s',
        duplicate.prepaid_hour_id,
        duplicate.attendance_snapshot_id,
        duplicate.minute_category
      ),
      'duplicate_hour_allocation'::text,
      'Duplicate hour allocation'::text,
      'blocking'::text,
      true,
      prepaid.employee_id,
      prepaid.employee_name,
      prepaid.employee_number,
      attendance.work_date,
      attendance.attendance_id,
      attendance.schedule_id,
      prepaid.payroll_record_id,
      'The same attendance minutes were allocated to this prepaid balance more than once without a reversal.'::text,
      jsonb_build_object(
        'prepaid_hour_id', duplicate.prepaid_hour_id,
        'attendance_snapshot_id', duplicate.attendance_snapshot_id,
        'minute_category', duplicate.minute_category,
        'allocation_count', duplicate.allocation_count,
        'allocation_ids', duplicate.allocation_ids
      )
    from duplicate_allocations as duplicate
    join active_prepaid as prepaid
      on prepaid.prepaid_hour_id = duplicate.prepaid_hour_id
    join public.payroll_attendance_snapshots as attendance
      on attendance.id = duplicate.attendance_snapshot_id

    union all

    select
      format('prepaid_balance_missing_source:%s', prepaid.prepaid_hour_id),
      'prepaid_balance_missing_source'::text,
      'Prepaid balance missing a valid source'::text,
      'blocking'::text,
      true,
      prepaid.employee_id,
      prepaid.employee_name,
      prepaid.employee_number,
      prepaid.work_date,
      null::uuid,
      prepaid.schedule_id,
      prepaid.payroll_record_id,
      'The prepaid balance cannot be traced to a valid approved schedule snapshot and source schedule.'::text,
      jsonb_build_object(
        'prepaid_hour_id', prepaid.prepaid_hour_id,
        'schedule_snapshot_id', prepaid.source_schedule_snapshot_id,
        'schedule_employee_id', prepaid.schedule_employee_id
      )
    from active_prepaid as prepaid
    where prepaid.source_schedule_snapshot_id is null
       or prepaid.schedule_id is null
       or prepaid.current_schedule_version is null
       or prepaid.schedule_employee_id is distinct from prepaid.employee_id
       or prepaid.approved_by is null
       or nullif(trim(prepaid.approval_reason), '') is null

    union all

    select
      format(
        'duplicate_prepaid_balance:%s:%s',
        duplicate.employee_id,
        duplicate.schedule_id
      ),
      'duplicate_prepaid_balance'::text,
      'Duplicate prepaid balance'::text,
      'blocking'::text,
      true,
      prepaid.employee_id,
      prepaid.employee_name,
      prepaid.employee_number,
      prepaid.work_date,
      null::uuid,
      prepaid.schedule_id,
      prepaid.payroll_record_id,
      'More than one active prepaid balance exists for the same employee and source schedule.'::text,
      jsonb_build_object(
        'balance_count', duplicate.balance_count,
        'schedule_id', duplicate.schedule_id
      )
    from duplicate_balances as duplicate
    join lateral (
      select source.*
      from active_prepaid as source
      where source.employee_id = duplicate.employee_id
        and source.schedule_id = duplicate.schedule_id
      order by source.work_date, source.prepaid_hour_id
      limit 1
    ) as prepaid on true

    union all

    select
      format('unaudited_prepaid_balance:%s', prepaid.prepaid_hour_id),
      'unaudited_prepaid_balance'::text,
      'Unaudited prepaid balance'::text,
      'blocking'::text,
      true,
      prepaid.employee_id,
      prepaid.employee_name,
      prepaid.employee_number,
      prepaid.work_date,
      null::uuid,
      prepaid.schedule_id,
      prepaid.payroll_record_id,
      'The approved prepaid balance has no matching payroll approval or controlled-import audit record.'::text,
      jsonb_build_object(
        'prepaid_hour_id', prepaid.prepaid_hour_id,
        'schedule_snapshot_id', prepaid.source_schedule_snapshot_id,
        'source_type', prepaid.source_type,
        'source_reference', prepaid.source_reference
      )
    from active_prepaid as prepaid
    where prepaid.source_schedule_snapshot_id is not null
      and (
        (
          prepaid.source_type = 'website_schedule'
          and not exists (
            select 1
            from public.payroll_audit_logs as audit
            where audit.payroll_period_id = v_period.id
              and audit.action = 'payroll_preplots_approved'
              and (
                audit.entity_id = prepaid.source_schedule_snapshot_id
                or coalesce(
                  audit.after_data -> 'schedule_snapshot_ids',
                  '[]'::jsonb
                ) @> jsonb_build_array(prepaid.source_schedule_snapshot_id)
                or audit.after_data ->> 'schedule_snapshot_id' =
                  prepaid.source_schedule_snapshot_id::text
              )
          )
        )
        or (
          prepaid.source_type = 'excel_import'
          and (
            nullif(trim(prepaid.source_reference), '') is null
            or not exists (
              select 1
              from public.payroll_audit_logs as audit
              where audit.payroll_period_id = v_period.id
                and audit.action = 'payroll_excel_preplots_imported'
            )
          )
        )
        or prepaid.source_type not in ('website_schedule', 'excel_import')
      )

    union all

    select
      format('unresolved_prepaid_balance:%s', prepaid.prepaid_hour_id),
      'unresolved_prepaid_balance'::text,
      'Unresolved prepaid balance'::text,
      'warning'::text,
      false,
      prepaid.employee_id,
      prepaid.employee_name,
      prepaid.employee_number,
      prepaid.work_date,
      null::uuid,
      prepaid.schedule_id,
      prepaid.payroll_record_id,
      format(
        '%s of %s prepaid minutes remain to be rendered in later approved attendance.',
        prepaid.remaining_minutes,
        prepaid.prepaid_minutes
      )::text,
      jsonb_build_object(
        'prepaid_hour_id', prepaid.prepaid_hour_id,
        'prepaid_minutes', prepaid.prepaid_minutes,
        'settled_minutes', prepaid.settled_minutes,
        'remaining_minutes', prepaid.remaining_minutes,
        'balance_status',
          case
            when prepaid.settled_minutes = 0 then 'open'
            else 'partially_settled'
          end
      )
    from active_prepaid as prepaid
    where prepaid.remaining_minutes > 0
  ),
  all_issues as (
    select existing.*
    from public.payroll_get_period_exceptions_attendance(
      p_payroll_period_id
    ) as existing

    union all

    select supplemental.*
    from supplemental_issues as supplemental
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
  from all_issues as issue
  order by
    issue.is_blocking desc,
    issue.work_date nulls last,
    issue.employee_name nulls last,
    issue.exception_label,
    issue.exception_key;
end;
$$;

revoke all on function public.payroll_get_period_exceptions(uuid)
  from public, anon;
grant execute on function public.payroll_get_period_exceptions(uuid)
  to authenticated, service_role;

comment on function public.payroll_get_period_exceptions(uuid) is
  'Returns permission-scoped payroll exceptions, including prepaid schedule provenance, balance, and allocation checks. No rate or salary amounts are exposed.';

commit;
