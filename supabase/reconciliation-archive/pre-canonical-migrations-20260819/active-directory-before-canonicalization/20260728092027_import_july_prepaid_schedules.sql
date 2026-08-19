-- Import the July 2026 pre-plotted shifts from the approved support timesheet.
-- Historical January-June rows are intentionally excluded because no matching
-- payroll periods exist. July OFF rows and the mixed RDOT row are also excluded
-- because special/rest-day work must not create ordinary prepaid-hour debt.

begin;

alter table public.payroll_schedule_snapshots
  add column source_type text not null default 'website_schedule',
  add column source_reference text,
  add column source_metadata jsonb not null default '{}'::jsonb;

alter table public.payroll_schedule_snapshots
  add constraint payroll_schedule_snapshots_source_type_check
    check (source_type in ('website_schedule', 'excel_import')),
  add constraint payroll_schedule_snapshots_source_reference_check
    check (
      (source_type = 'website_schedule')
      or (
        source_reference is not null
        and length(trim(source_reference)) > 0
      )
    ),
  add constraint payroll_schedule_snapshots_source_metadata_check
    check (jsonb_typeof(source_metadata) = 'object');

create unique index payroll_schedule_snapshots_source_reference_key
  on public.payroll_schedule_snapshots (source_type, source_reference)
  where source_reference is not null;

comment on column public.payroll_schedule_snapshots.source_type is
  'Provenance of the immutable prepaid schedule: website approval or controlled Excel import.';
comment on column public.payroll_schedule_snapshots.source_reference is
  'Stable source-row reference used to prevent duplicate controlled imports.';
comment on column public.payroll_schedule_snapshots.source_metadata is
  'Non-sensitive source details needed to audit a controlled prepaid-schedule import.';

create temporary table payroll_excel_preplots_import (
  sheet_name text not null,
  workbook_row integer not null,
  employee_email text not null,
  work_date date not null,
  schedule_label text not null,
  prepaid_login time not null,
  prepaid_logout time not null,
  source_note text not null,
  primary key (sheet_name, workbook_row)
) on commit drop;

insert into payroll_excel_preplots_import (
  sheet_name,
  workbook_row,
  employee_email,
  work_date,
  schedule_label,
  prepaid_login,
  prepaid_logout,
  source_note
)
values
  ('AMOR', 262, 'amora@eurekasurveys.com', '2026-07-10', '9PM - 5AM', '19:00', '15:00', 'pre plotted'),
  ('AMOR', 265, 'amora@eurekasurveys.com', '2026-07-13', '9PM - 5AM', '19:00', '15:00', 'pre plotted'),
  ('AMOR', 266, 'amora@eurekasurveys.com', '2026-07-14', '9PM - 5AM', '19:00', '15:00', 'pre plotted'),
  ('AMOR', 267, 'amora@eurekasurveys.com', '2026-07-15', '9PM - 5AM', '19:00', '15:00', 'pre plotted'),
  ('AMOR', 282, 'amora@eurekasurveys.com', '2026-07-27', '9PM - 5AM', '19:00', '15:00', 'pre plotted'),
  ('AMOR', 283, 'amora@eurekasurveys.com', '2026-07-28', '9PM - 5AM', '19:00', '15:00', 'pre plotted'),
  ('AMOR', 284, 'amora@eurekasurveys.com', '2026-07-29', '9PM - 5AM', '19:00', '15:00', 'pre plotted'),
  ('AMOR', 285, 'amora@eurekasurveys.com', '2026-07-30', '9PM - 5AM', '19:00', '15:00', 'pre plotted'),
  ('AMOR', 286, 'amora@eurekasurveys.com', '2026-07-31', '9PM - 5AM', '19:00', '15:00', 'pre plotted'),
  ('ARBY', 262, 'arby@eurekasurveys.com', '2026-07-10', '10AM-6PM', '01:10', '18:10', 'pre plotted'),
  ('ARBY', 263, 'arby@eurekasurveys.com', '2026-07-11', '12AM-8AM', '00:00', '14:00', 'pre plotted'),
  ('ARBY', 266, 'arby@eurekasurveys.com', '2026-07-14', '10AM-6PM', '00:45', '18:45', 'pre plotted'),
  ('ARBY', 283, 'arby@eurekasurveys.com', '2026-07-28', '10AM-6PM', '00:00', '18:00', 'pre plotted'),
  ('ARBY', 284, 'arby@eurekasurveys.com', '2026-07-29', '10AM-6PM', '00:00', '18:00', 'pre plotted'),
  ('ARBY', 285, 'arby@eurekasurveys.com', '2026-07-30', '10AM-6PM', '00:00', '18:00', 'pre plotted'),
  ('ARBY', 286, 'arby@eurekasurveys.com', '2026-07-31', '10AM-6PM', '00:00', '18:00', 'pre plotted'),
  ('AREZ', 284, 'arez@eurekasurveys.com', '2026-07-29', '10AM-6PM', '10:00', '04:00', 'pre plotted'),
  ('AREZ', 285, 'arez@eurekasurveys.com', '2026-07-30', '10AM-6PM', '10:00', '04:00', 'pre plotted'),
  ('AREZ', 286, 'arez@eurekasurveys.com', '2026-07-31', '10AM-6PM', '10:00', '04:00', 'pre plotted'),
  ('FORD', 262, 'ford@eurekasurveys.com', '2026-07-10', '8AM-4PM', '03:00', '17:00', 'pre plotted'),
  ('FORD', 265, 'ford@eurekasurveys.com', '2026-07-13', '8AM-4PM', '03:00', '17:00', 'pre plotted'),
  ('FORD', 266, 'ford@eurekasurveys.com', '2026-07-14', '8AM-4PM', '03:00', '17:00', 'pre plotted'),
  ('FORD', 267, 'ford@eurekasurveys.com', '2026-07-15', '8AM-4PM', '03:00', '17:00', 'pre plotted'),
  ('FORD', 282, 'ford@eurekasurveys.com', '2026-07-27', '8AM-4PM', '03:00', '17:00', 'pre plotted'),
  ('FORD', 283, 'ford@eurekasurveys.com', '2026-07-28', '8AM-4PM', '03:00', '17:00', 'pre plotted'),
  ('FORD', 284, 'ford@eurekasurveys.com', '2026-07-29', '8AM-4PM', '03:00', '17:00', 'pre plotted'),
  ('FORD', 285, 'ford@eurekasurveys.com', '2026-07-30', '8AM-4PM', '03:00', '17:00', 'pre plotted'),
  ('FORD', 286, 'ford@eurekasurveys.com', '2026-07-31', '8AM-4PM', '03:00', '17:00', 'pre plotted'),
  ('GEN', 262, 'gen@eurekasurveys.com', '2026-07-10', '8AM-4PM', '00:00', '19:00', 'pre plotted'),
  ('GEN', 263, 'gen@eurekasurveys.com', '2026-07-11', '8AM-4PM', '02:00', '19:00', 'pre plotted'),
  ('GEN', 264, 'gen@eurekasurveys.com', '2026-07-12', '8AM-4PM', '01:10', '18:10', 'pre plotted'),
  ('GEN', 267, 'gen@eurekasurveys.com', '2026-07-15', '8AM-4PM', '02:00', '21:00', 'pre plotted'),
  ('GEN', 284, 'gen@eurekasurveys.com', '2026-07-29', '8AM-4PM', '00:00', '19:00', 'pre plotted'),
  ('GEN', 285, 'gen@eurekasurveys.com', '2026-07-30', '8AM-4PM', '00:00', '19:00', 'pre plotted'),
  ('GEN', 286, 'gen@eurekasurveys.com', '2026-07-31', '8AM-4PM', '00:00', '19:00', 'pre plotted'),
  ('JEAN', 264, 'jean@eurekasurveys.com', '2026-07-12', '11AM-7PM', '04:30', '18:30', 'pre plotted'),
  ('JEAN', 265, 'jean@eurekasurveys.com', '2026-07-13', '11AM-7PM', '05:00', '19:00', 'pre plotted'),
  ('JEAN', 266, 'jean@eurekasurveys.com', '2026-07-14', '11AM-7PM', '05:10', '19:10', 'pre plotted'),
  ('JEAN', 282, 'jean@eurekasurveys.com', '2026-07-27', '11AM-7PM', '05:00', '19:00', 'pre plotted'),
  ('JEAN', 283, 'jean@eurekasurveys.com', '2026-07-28', '11AM-7PM', '03:00', '19:00', 'pre plotted'),
  ('JEAN', 284, 'jean@eurekasurveys.com', '2026-07-29', '11AM-7PM', '03:00', '19:00', 'pre plotted'),
  ('JEAN', 285, 'jean@eurekasurveys.com', '2026-07-30', '11AM-7PM', '03:00', '19:00', 'pre plotted'),
  ('JERSON', 262, 'jerson@eurekasurveys.com', '2026-07-10', '4PM-12AM', '12:00', '04:00', 'pre plotted'),
  ('JERSON', 265, 'jerson@eurekasurveys.com', '2026-07-13', '4PM-12AM', '12:00', '04:00', 'pre plotted'),
  ('JERSON', 266, 'jerson@eurekasurveys.com', '2026-07-14', '4PM-12AM', '12:00', '04:00', 'pre plotted'),
  ('JERSON', 267, 'jerson@eurekasurveys.com', '2026-07-15', '4PM-12AM', '12:00', '04:00', 'pre plotted'),
  ('JERSON', 282, 'jerson@eurekasurveys.com', '2026-07-27', '4PM-12AM', '12:00', '04:00', 'pre plotted'),
  ('JERSON', 283, 'jerson@eurekasurveys.com', '2026-07-28', '4PM-12AM', '12:00', '04:00', 'pre plotted'),
  ('JERSON', 284, 'jerson@eurekasurveys.com', '2026-07-29', '4PM-12AM', '12:00', '04:00', 'pre plotted'),
  ('JERSON', 285, 'jerson@eurekasurveys.com', '2026-07-30', '4PM-12AM', '12:00', '04:00', 'pre plotted'),
  ('JERSON', 286, 'jerson@eurekasurveys.com', '2026-07-31', '4PM-12AM', '12:00', '04:00', 'pre plotted'),
  ('TRISTAN', 261, 'tristan@eurekasurveys.com', '2026-07-09', '9PM-5AM', '23:30', '15:30', 'pre plotted'),
  ('TRISTAN', 264, 'tristan@eurekasurveys.com', '2026-07-12', '9PM-5AM', '18:15', '13:15', 'pre plotted'),
  ('TRISTAN', 265, 'tristan@eurekasurveys.com', '2026-07-13', '9PM-5AM', '21:00', '13:00', 'pre plotted'),
  ('TRISTAN', 266, 'tristan@eurekasurveys.com', '2026-07-14', '9PM-5AM', '21:00', '13:00', 'pre plotted'),
  ('TRISTAN', 282, 'tristan@eurekasurveys.com', '2026-07-27', '9PM-5AM', '21:00', '13:00', 'pre plotted'),
  ('TRISTAN', 283, 'tristan@eurekasurveys.com', '2026-07-28', '9PM-5AM', '21:00', '13:00', 'pre plotted'),
  ('TRISTAN', 284, 'tristan@eurekasurveys.com', '2026-07-29', '9PM-5AM', '21:00', '13:00', 'pre plotted'),
  ('TRISTAN', 285, 'tristan@eurekasurveys.com', '2026-07-30', '9PM-5AM', '21:00', '13:00', 'pre plotted');

do $$
declare
  v_input_count integer;
  v_actor_user_id uuid;
  v_actor_count integer;
  v_match_count integer;
  v_inserted_count integer;
  v_attendance_snapshot record;
  v_category record;
  v_balance record;
  v_available_minutes integer;
  v_allocated_minutes integer;
  v_total_allocated_minutes integer := 0;
  v_allocation_line_count integer := 0;
begin
  select count(*) into v_input_count
  from payroll_excel_preplots_import;

  if v_input_count <> 59 then
    raise exception 'Expected 59 approved Excel pre-plots, found %.', v_input_count;
  end if;

  select count(*)
  into v_actor_count
  from public.profiles as profile
  where profile.is_system_admin
    and profile.employment_status = 'active';

  if v_actor_count <> 1 then
    raise exception
      'Expected exactly one active system administrator for the controlled import, found %.',
      v_actor_count;
  end if;

  select profile.user_id
  into v_actor_user_id
  from public.profiles as profile
  where profile.is_system_admin
    and profile.employment_status = 'active';

  select count(*)
  into v_match_count
  from payroll_excel_preplots_import as source
  join public.profiles as profile
    on lower(profile.email) = lower(source.employee_email)
   and profile.employment_status = 'active'
  join public.work_schedules as schedule
    on schedule.user_id = profile.user_id
   and schedule.shift_date = source.work_date
  join public.payroll_periods as period
    on source.work_date between period.period_start and period.period_end
   and period.status <> 'void'
  join public.payroll_records as record
    on record.payroll_period_id = period.id
   and record.employee_id = profile.user_id
   and record.status <> 'void'
  where not schedule.is_rest_day
    and not schedule.is_holiday
    and schedule.status in ('published', 'changed', 'completed');

  if v_match_count <> v_input_count then
    raise exception
      'Only % of % Excel pre-plots matched one active employee, ordinary schedule, payroll period, and payroll record.',
      v_match_count,
      v_input_count;
  end if;

  if exists (
    select 1
    from payroll_excel_preplots_import as source
    join public.profiles as profile
      on lower(profile.email) = lower(source.employee_email)
    join public.work_schedules as schedule
      on schedule.user_id = profile.user_id
     and schedule.shift_date = source.work_date
    group by source.sheet_name, source.workbook_row
    having count(*) <> 1
  ) then
    raise exception 'At least one Excel pre-plot matched more than one website schedule.';
  end if;

  if exists (
    select 1
    from payroll_excel_preplots_import as source
    where exists (
      select 1
      from public.payroll_schedule_snapshots as snapshot
      where snapshot.source_type = 'excel_import'
        and snapshot.source_reference =
          '2026 Support Timesheet.xlsx|' ||
          source.sheet_name || '|' || source.workbook_row::text
    )
  ) then
    raise exception 'At least one approved Excel pre-plot was already imported.';
  end if;

  with matched as materialized (
    select
      source.*,
      profile.user_id as employee_id,
      schedule.id as schedule_id,
      schedule.timezone,
      schedule.status as schedule_status,
      schedule.is_rest_day,
      schedule.is_holiday,
      schedule.holiday_name,
      schedule.schedule_version,
      schedule.updated_at as schedule_updated_at,
      record.id as payroll_record_id,
      (
        source.work_date + source.prepaid_login
      ) at time zone schedule.timezone as shift_start,
      (
        source.work_date
        + case
            when source.prepaid_logout <= source.prepaid_login then 1
            else 0
          end
        + source.prepaid_logout
      ) at time zone schedule.timezone as shift_end
    from payroll_excel_preplots_import as source
    join public.profiles as profile
      on lower(profile.email) = lower(source.employee_email)
     and profile.employment_status = 'active'
    join public.work_schedules as schedule
      on schedule.user_id = profile.user_id
     and schedule.shift_date = source.work_date
     and not schedule.is_rest_day
     and not schedule.is_holiday
     and schedule.status in ('published', 'changed', 'completed')
    join public.payroll_periods as period
      on source.work_date between period.period_start and period.period_end
     and period.status <> 'void'
    join public.payroll_records as record
      on record.payroll_period_id = period.id
     and record.employee_id = profile.user_id
     and record.status <> 'void'
  ),
  inserted as (
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
      snapshotted_at,
      source_type,
      source_reference,
      source_metadata
    )
    select
      matched.payroll_record_id,
      matched.schedule_id,
      matched.employee_id,
      matched.work_date,
      matched.shift_start,
      matched.shift_end,
      matched.timezone,
      matched.schedule_status,
      matched.is_rest_day,
      matched.is_holiday,
      matched.holiday_name,
      matched.schedule_version,
      matched.schedule_updated_at,
      v_actor_user_id,
      statement_timestamp(),
      'Imported from approved 2026 Support Timesheet.xlsx pre-plotted rows.',
      statement_timestamp(),
      'excel_import',
      '2026 Support Timesheet.xlsx|' ||
        matched.sheet_name || '|' || matched.workbook_row::text,
      jsonb_build_object(
        'workbook', '2026 Support Timesheet.xlsx',
        'sheet', matched.sheet_name,
        'row', matched.workbook_row,
        'employee_email', matched.employee_email,
        'schedule_label', matched.schedule_label,
        'source_note', matched.source_note,
        'import_scope', 'July 2026 ordinary pre-plotted schedules'
      )
    from matched
    returning id
  )
  select count(*) into v_inserted_count
  from inserted;

  if v_inserted_count <> v_input_count then
    raise exception
      'Expected to import % Excel pre-plots, inserted %.',
      v_input_count,
      v_inserted_count;
  end if;

  -- The attendance snapshots were imported before these historical pre-plots.
  -- Reconcile them in work-date order using the same FIFO/category rules as the
  -- normal attendance-import trigger. Special-day work remains excluded.
  for v_attendance_snapshot in
    select snapshot.*
    from public.payroll_attendance_snapshots as snapshot
    where snapshot.employee_id in (
      select profile.user_id
      from payroll_excel_preplots_import as source
      join public.profiles as profile
        on lower(profile.email) = lower(source.employee_email)
    )
      and snapshot.special_day_type = 'ordinary'
      and not snapshot.is_rest_day
      and not snapshot.is_holiday
      and snapshot.attendance_version <= 2147483647
      and not exists (
        select 1
        from public.payroll_hour_allocations as existing_allocation
        where existing_allocation.attendance_snapshot_id = snapshot.id
      )
    order by
      snapshot.employee_id,
      snapshot.work_date,
      snapshot.imported_at,
      snapshot.id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'public.payroll_prepaid_hours:' ||
        v_attendance_snapshot.employee_id::text,
        0
      )
    );

    for v_category in
      select category.minute_category, category.available_minutes
      from (
        values
          ('regular'::text, v_attendance_snapshot.regular_minutes),
          (
            'pre_shift_overtime'::text,
            v_attendance_snapshot.pre_shift_overtime_minutes
          ),
          (
            'post_shift_overtime'::text,
            v_attendance_snapshot.post_shift_overtime_minutes
          )
      ) as category(minute_category, available_minutes)
    loop
      v_available_minutes := greatest(v_category.available_minutes, 0);

      while v_available_minutes > 0 loop
        select
          prepaid.id,
          prepaid.remaining_minutes
        into v_balance
        from public.payroll_prepaid_hours as prepaid
        join public.payroll_schedule_snapshots as source_snapshot
          on source_snapshot.id = prepaid.source_schedule_snapshot_id
        where prepaid.employee_id = v_attendance_snapshot.employee_id
          and prepaid.voided_at is null
          and prepaid.remaining_minutes > 0
          and source_snapshot.source_type = 'excel_import'
          and source_snapshot.work_date <= v_attendance_snapshot.work_date
        order by
          source_snapshot.work_date,
          prepaid.created_at,
          prepaid.id
        limit 1
        for update of prepaid;

        exit when not found;

        v_allocated_minutes :=
          least(v_available_minutes, v_balance.remaining_minutes);

        insert into public.payroll_hour_allocations (
          prepaid_hour_id,
          employee_id,
          destination_payroll_record_id,
          attendance_snapshot_id,
          allocation_type,
          minute_category,
          allocated_minutes,
          calculation_version,
          reverses_allocation_id,
          reason,
          created_by
        )
        values (
          v_balance.id,
          v_attendance_snapshot.employee_id,
          v_attendance_snapshot.payroll_record_id,
          v_attendance_snapshot.id,
          'settlement',
          v_category.minute_category,
          v_allocated_minutes,
          v_attendance_snapshot.attendance_version::integer,
          null,
          'Backfilled approved attendance against an Excel-imported prepaid-hour balance.',
          v_actor_user_id
        );

        update public.payroll_prepaid_hours
        set
          settled_minutes = settled_minutes + v_allocated_minutes,
          last_settled_at = statement_timestamp()
        where id = v_balance.id;

        v_available_minutes := v_available_minutes - v_allocated_minutes;
        v_total_allocated_minutes :=
          v_total_allocated_minutes + v_allocated_minutes;
        v_allocation_line_count := v_allocation_line_count + 1;
      end loop;
    end loop;
  end loop;

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
  select
    v_actor_user_id,
    'payroll_excel_preplots_imported',
    'payroll_period',
    period.id,
    period.id,
    jsonb_build_object(
      'imported_schedule_count',
      count(snapshot.id),
      'prepaid_minutes',
      sum(prepaid.prepaid_minutes),
      'settled_minutes_after_backfill',
      sum(prepaid.settled_minutes),
      'remaining_minutes_after_backfill',
      sum(prepaid.remaining_minutes)
    ),
    'Imported approved July 2026 ordinary pre-plotted schedules from the support timesheet.',
    jsonb_build_object(
      'workbook', '2026 Support Timesheet.xlsx',
      'source_row_count', 359,
      'imported_july_ordinary_rows', 59,
      'excluded_historical_rows_without_payroll_periods', 283,
      'excluded_july_off_rows', 16,
      'excluded_july_mixed_rdot_rows', 1,
      'backfilled_allocation_lines', v_allocation_line_count,
      'backfilled_allocated_minutes', v_total_allocated_minutes,
      'import_method', 'controlled_data_migration'
    )
  from public.payroll_schedule_snapshots as snapshot
  join public.payroll_prepaid_hours as prepaid
    on prepaid.source_schedule_snapshot_id = snapshot.id
  join public.payroll_records as record
    on record.id = snapshot.payroll_record_id
  join public.payroll_periods as period
    on period.id = record.payroll_period_id
  where snapshot.source_type = 'excel_import'
    and snapshot.source_reference like '2026 Support Timesheet.xlsx|%'
  group by period.id;
end;
$$;

commit;
