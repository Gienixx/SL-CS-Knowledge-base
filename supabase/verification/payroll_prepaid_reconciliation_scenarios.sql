-- Rollback-only integration scenarios for Phase 2 prepaid-hour reconciliation.
-- The inner block is a PostgreSQL subtransaction. Its sentinel exception is
-- caught only after every assertion passes, which rolls back all synthetic
-- payroll, schedule, attendance, balance, allocation, and audit rows.

create temporary table payroll_reconciliation_test_results (
  result jsonb not null
) on commit drop;

create temporary table payroll_reconciliation_test_users (
  scenario text primary key,
  employee_email text not null unique,
  employee_id uuid not null,
  payroll_record_id uuid
) on commit drop;

create temporary table payroll_reconciliation_test_schedules (
  scenario text not null,
  schedule_role text not null,
  work_date date not null,
  schedule_id uuid not null,
  primary key (scenario, schedule_role)
) on commit drop;

create temporary table payroll_reconciliation_test_sources (
  scenario text primary key,
  schedule_snapshot_id uuid not null,
  prepaid_hour_id uuid not null
) on commit drop;

insert into payroll_reconciliation_test_users (
  scenario,
  employee_email,
  employee_id
)
select source.scenario, source.employee_email, profile.user_id
from (
  values
    ('exact_match', 'amora@eurekasurveys.com'),
    ('partial_work', 'arby@eurekasurveys.com'),
    ('multi_day_carry_forward', 'arez@eurekasurveys.com'),
    ('overtime_settlement', 'ford@eurekasurveys.com'),
    ('special_day_exclusion', 'gen@eurekasurveys.com')
) as source(scenario, employee_email)
join public.profiles as profile
  on lower(profile.email) = lower(source.employee_email)
 and profile.employment_status = 'active'
 and profile.is_agent;

do $verification$
declare
  v_actor_user_id uuid;
  v_actor_count integer;
  v_period_id uuid;
  v_user_count integer;
  v_settled integer;
  v_remaining integer;
  v_line_count integer;
  v_regular integer;
  v_pre_shift integer;
  v_post_shift integer;
  v_special_snapshot_count integer;
  v_multi_day_allocations integer[];
  v_result jsonb;
begin
  select count(*)
  into v_user_count
  from payroll_reconciliation_test_users;

  if v_user_count <> 5 then
    raise exception
      'Reconciliation scenarios require five active test agents; found %.',
      v_user_count;
  end if;

  select count(*)
  into v_actor_count
  from public.profiles
  where is_system_admin
    and employment_status = 'active';

  if v_actor_count <> 1 then
    raise exception
      'Reconciliation scenarios require exactly one active system administrator; found %.',
      v_actor_count;
  end if;

  select user_id
  into v_actor_user_id
  from public.profiles
  where is_system_admin
    and employment_status = 'active';

  begin
    insert into public.payroll_periods (
      period_start,
      period_end,
      payment_date,
      status,
      currency_code,
      created_by
    )
    values (
      '2001-02-01',
      '2001-02-28',
      '2001-02-25',
      'draft',
      'USD',
      v_actor_user_id
    )
    returning id into v_period_id;

    insert into public.payroll_records (
      payroll_period_id,
      employee_id,
      status,
      currency_code
    )
    select
      v_period_id,
      test_user.employee_id,
      'draft',
      'USD'
    from payroll_reconciliation_test_users as test_user;

    update payroll_reconciliation_test_users as test_user
    set payroll_record_id = record.id
    from public.payroll_records as record
    where record.payroll_period_id = v_period_id
      and record.employee_id = test_user.employee_id;

    insert into public.work_schedules (
      user_id,
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
    select
      test_user.employee_id,
      source.work_date,
      1,
      case
        when source.is_rest_day then null
        else (source.work_date + time '09:00')
          at time zone 'America/New_York'
      end,
      case
        when source.is_rest_day then null
        else (source.work_date + time '17:00')
          at time zone 'America/New_York'
      end,
      'America/New_York',
      'published',
      source.is_rest_day,
      source.is_holiday,
      case when source.is_holiday then 'Verification holiday' else null end,
      'payroll-reconciliation-test:' ||
        source.scenario || ':' || source.schedule_role,
      v_actor_user_id,
      v_actor_user_id
    from (
      values
        ('exact_match', 'source_and_actual', date '2001-02-01', false, false),
        ('partial_work', 'source_and_actual', date '2001-02-02', false, false),
        ('multi_day_carry_forward', 'source_and_day_1', date '2001-02-03', false, false),
        ('multi_day_carry_forward', 'actual_day_2', date '2001-02-04', false, false),
        ('multi_day_carry_forward', 'actual_day_3', date '2001-02-05', false, false),
        ('overtime_settlement', 'source_and_actual', date '2001-02-10', false, false),
        ('special_day_exclusion', 'source', date '2001-02-20', false, false),
        ('special_day_exclusion', 'rest_day_actual', date '2001-02-21', true, false),
        ('special_day_exclusion', 'holiday_actual', date '2001-02-22', false, true)
    ) as source(
      scenario,
      schedule_role,
      work_date,
      is_rest_day,
      is_holiday
    )
    join payroll_reconciliation_test_users as test_user
      on test_user.scenario = source.scenario;

    insert into payroll_reconciliation_test_schedules (
      scenario,
      schedule_role,
      work_date,
      schedule_id
    )
    select
      split_part(schedule.notes, ':', 2),
      split_part(schedule.notes, ':', 3),
      schedule.shift_date,
      schedule.id
    from public.work_schedules as schedule
    where schedule.notes like 'payroll-reconciliation-test:%';

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
      source_reference,
      source_metadata
    )
    select
      test_user.payroll_record_id,
      schedule.schedule_id,
      test_user.employee_id,
      schedule.work_date,
      case
        when schedule.scenario = 'overtime_settlement'
          then (schedule.work_date + time '07:00')
            at time zone 'America/New_York'
        else (schedule.work_date + time '09:00')
          at time zone 'America/New_York'
      end,
      (schedule.work_date + time '17:00')
        at time zone 'America/New_York',
      'America/New_York',
      work_schedule.status,
      false,
      false,
      null,
      work_schedule.schedule_version,
      work_schedule.updated_at,
      v_actor_user_id,
      statement_timestamp(),
      'Rollback-only prepaid reconciliation integration test.',
      'website_schedule',
      'payroll-reconciliation-test:' || schedule.scenario,
      jsonb_build_object(
        'verification', true,
        'scenario', schedule.scenario
      )
    from payroll_reconciliation_test_schedules as schedule
    join payroll_reconciliation_test_users as test_user
      on test_user.scenario = schedule.scenario
    join public.work_schedules as work_schedule
      on work_schedule.id = schedule.schedule_id
    where schedule.schedule_role in (
      'source_and_actual',
      'source_and_day_1',
      'source'
    );

    insert into payroll_reconciliation_test_sources (
      scenario,
      schedule_snapshot_id,
      prepaid_hour_id
    )
    select
      snapshot.source_metadata ->> 'scenario',
      snapshot.id,
      prepaid.id
    from public.payroll_schedule_snapshots as snapshot
    join public.payroll_prepaid_hours as prepaid
      on prepaid.source_schedule_snapshot_id = snapshot.id
    where snapshot.source_reference like 'payroll-reconciliation-test:%';

    insert into public.attendance (
      user_id,
      schedule_id,
      work_date,
      clock_in,
      clock_out,
      attendance_status,
      is_late,
      minutes_late,
      overtime_minutes,
      undertime_minutes,
      pre_shift_overtime_minutes,
      regular_minutes,
      post_shift_overtime_minutes,
      total_overtime_minutes,
      review_status,
      reviewed_by,
      reviewed_at,
      rest_day_overtime_minutes,
      holiday_overtime_minutes,
      admin_notes,
      created_by,
      updated_by
    )
    select
      test_user.employee_id,
      schedule.schedule_id,
      schedule.work_date,
      (schedule.work_date + source.clock_in)
        at time zone 'America/New_York',
      (schedule.work_date + source.clock_out)
        at time zone 'America/New_York',
      'present',
      false,
      0,
      source.pre_shift_minutes
        + source.post_shift_minutes
        + source.rest_day_minutes
        + source.holiday_minutes,
      source.undertime_minutes,
      source.pre_shift_minutes,
      source.regular_minutes,
      source.post_shift_minutes,
      source.pre_shift_minutes
        + source.post_shift_minutes
        + source.rest_day_minutes
        + source.holiday_minutes,
      'approved',
      v_actor_user_id,
      statement_timestamp(),
      source.rest_day_minutes,
      source.holiday_minutes,
      'payroll-reconciliation-test:' ||
        source.scenario || ':' || source.attendance_role,
      v_actor_user_id,
      v_actor_user_id
    from (
      values
        ('exact_match', 'source_and_actual', 'day_1', time '09:00', time '17:00', 480, 0, 0, 0, 0, 0),
        ('partial_work', 'source_and_actual', 'day_1', time '09:00', time '14:00', 300, 0, 0, 0, 0, 180),
        ('multi_day_carry_forward', 'source_and_day_1', 'day_1', time '09:00', time '12:00', 180, 0, 0, 0, 0, 300),
        ('multi_day_carry_forward', 'actual_day_2', 'day_2', time '09:00', time '12:00', 180, 0, 0, 0, 0, 300),
        ('multi_day_carry_forward', 'actual_day_3', 'day_3', time '09:00', time '11:00', 120, 0, 0, 0, 0, 360),
        ('overtime_settlement', 'source_and_actual', 'day_1', time '07:00', time '17:00', 480, 60, 60, 0, 0, 0),
        ('special_day_exclusion', 'rest_day_actual', 'rest_day', time '09:00', time '17:00', 0, 0, 0, 480, 0, 0),
        ('special_day_exclusion', 'holiday_actual', 'holiday', time '09:00', time '17:00', 0, 0, 0, 0, 480, 0)
    ) as source(
      scenario,
      schedule_role,
      attendance_role,
      clock_in,
      clock_out,
      regular_minutes,
      pre_shift_minutes,
      post_shift_minutes,
      rest_day_minutes,
      holiday_minutes,
      undertime_minutes
    )
    join payroll_reconciliation_test_users as test_user
      on test_user.scenario = source.scenario
    join payroll_reconciliation_test_schedules as schedule
      on schedule.scenario = source.scenario
     and schedule.schedule_role = source.schedule_role;

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
      attendance_updated_at
    )
    select
      test_user.payroll_record_id,
      attendance_row.id,
      attendance_row.user_id,
      attendance_row.schedule_id,
      attendance_row.work_date,
      attendance_row.clock_in,
      attendance_row.clock_out,
      attendance_row.regular_minutes,
      attendance_row.pre_shift_overtime_minutes,
      attendance_row.post_shift_overtime_minutes,
      attendance_row.total_overtime_minutes,
      attendance_row.minutes_late,
      attendance_row.undertime_minutes,
      attendance_row.attendance_version,
      attendance_row.updated_at
    from public.attendance as attendance_row
    join payroll_reconciliation_test_users as test_user
      on test_user.employee_id = attendance_row.user_id
    where attendance_row.admin_notes
      like 'payroll-reconciliation-test:%'
    order by attendance_row.work_date, attendance_row.id;

    select prepaid.settled_minutes, prepaid.remaining_minutes
    into v_settled, v_remaining
    from public.payroll_prepaid_hours as prepaid
    join payroll_reconciliation_test_sources as source
      on source.prepaid_hour_id = prepaid.id
    where source.scenario = 'exact_match';

    if v_settled <> 480 or v_remaining <> 0 then
      raise exception
        'Exact-match scenario failed: settled %, remaining %.',
        v_settled,
        v_remaining;
    end if;

    select prepaid.settled_minutes, prepaid.remaining_minutes
    into v_settled, v_remaining
    from public.payroll_prepaid_hours as prepaid
    join payroll_reconciliation_test_sources as source
      on source.prepaid_hour_id = prepaid.id
    where source.scenario = 'partial_work';

    if v_settled <> 300 or v_remaining <> 180 then
      raise exception
        'Partial-work scenario failed: settled %, remaining %.',
        v_settled,
        v_remaining;
    end if;

    select
      prepaid.settled_minutes,
      prepaid.remaining_minutes,
      array_agg(
        allocation.allocated_minutes
        order by attendance_snapshot.work_date
      )
    into v_settled, v_remaining, v_multi_day_allocations
    from public.payroll_prepaid_hours as prepaid
    join payroll_reconciliation_test_sources as source
      on source.prepaid_hour_id = prepaid.id
    join public.payroll_hour_allocations as allocation
      on allocation.prepaid_hour_id = prepaid.id
     and allocation.allocation_type = 'settlement'
    join public.payroll_attendance_snapshots as attendance_snapshot
      on attendance_snapshot.id = allocation.attendance_snapshot_id
    where source.scenario = 'multi_day_carry_forward'
    group by prepaid.id;

    if v_settled <> 480
       or v_remaining <> 0
       or v_multi_day_allocations <> array[180, 180, 120] then
      raise exception
        'Multi-day carry-forward failed: settled %, remaining %, allocations %.',
        v_settled,
        v_remaining,
        v_multi_day_allocations;
    end if;

    select
      prepaid.settled_minutes,
      prepaid.remaining_minutes,
      coalesce(sum(allocation.allocated_minutes) filter (
        where allocation.minute_category = 'regular'
      ), 0)::integer,
      coalesce(sum(allocation.allocated_minutes) filter (
        where allocation.minute_category = 'pre_shift_overtime'
      ), 0)::integer,
      coalesce(sum(allocation.allocated_minutes) filter (
        where allocation.minute_category = 'post_shift_overtime'
      ), 0)::integer
    into
      v_settled,
      v_remaining,
      v_regular,
      v_pre_shift,
      v_post_shift
    from public.payroll_prepaid_hours as prepaid
    join payroll_reconciliation_test_sources as source
      on source.prepaid_hour_id = prepaid.id
    join public.payroll_hour_allocations as allocation
      on allocation.prepaid_hour_id = prepaid.id
     and allocation.allocation_type = 'settlement'
    where source.scenario = 'overtime_settlement'
    group by prepaid.id;

    if v_settled <> 600
       or v_remaining <> 0
       or v_regular <> 480
       or v_pre_shift <> 60
       or v_post_shift <> 60 then
      raise exception
        'Overtime settlement failed: regular %, pre %, post %, remaining %.',
        v_regular,
        v_pre_shift,
        v_post_shift,
        v_remaining;
    end if;

    select
      prepaid.settled_minutes,
      prepaid.remaining_minutes,
      count(allocation.id)::integer
    into v_settled, v_remaining, v_line_count
    from public.payroll_prepaid_hours as prepaid
    join payroll_reconciliation_test_sources as source
      on source.prepaid_hour_id = prepaid.id
    left join public.payroll_hour_allocations as allocation
      on allocation.prepaid_hour_id = prepaid.id
    where source.scenario = 'special_day_exclusion'
    group by prepaid.id;

    select count(*)::integer
    into v_special_snapshot_count
    from public.payroll_attendance_snapshots as snapshot
    join public.attendance as attendance_row
      on attendance_row.id = snapshot.attendance_id
    where attendance_row.admin_notes like
      'payroll-reconciliation-test:special_day_exclusion:%'
      and snapshot.special_day_type in ('rest_day', 'holiday');

    if v_settled <> 0
       or v_remaining <> 480
       or v_line_count <> 0
       or v_special_snapshot_count <> 2 then
      raise exception
        'Special-day exclusion failed: settled %, remaining %, allocations %, classified snapshots %.',
        v_settled,
        v_remaining,
        v_line_count,
        v_special_snapshot_count;
    end if;

    v_result := jsonb_build_object(
      'status', 'passed',
      'rollback_only', true,
      'scenarios', jsonb_build_array(
        jsonb_build_object(
          'name', 'exact_match',
          'prepaid_minutes', 480,
          'settled_minutes', 480,
          'remaining_minutes', 0
        ),
        jsonb_build_object(
          'name', 'partial_work',
          'prepaid_minutes', 480,
          'settled_minutes', 300,
          'remaining_minutes', 180
        ),
        jsonb_build_object(
          'name', 'multi_day_carry_forward',
          'prepaid_minutes', 480,
          'daily_allocations', v_multi_day_allocations,
          'remaining_minutes', 0
        ),
        jsonb_build_object(
          'name', 'overtime_settlement',
          'prepaid_minutes', 600,
          'regular_minutes', v_regular,
          'pre_shift_overtime_minutes', v_pre_shift,
          'post_shift_overtime_minutes', v_post_shift,
          'remaining_minutes', 0
        ),
        jsonb_build_object(
          'name', 'special_day_exclusion',
          'rest_day_and_holiday_snapshots', v_special_snapshot_count,
          'settled_minutes', 0,
          'remaining_minutes', 480
        )
      )
    );

    raise exception
      using
        errcode = 'ZX001',
        message = 'Rollback successful after all reconciliation scenarios passed.';
  exception
    when sqlstate 'ZX001' then
      insert into payroll_reconciliation_test_results (result)
      values (v_result);
  end;
end;
$verification$;

select
  result,
  (
    select count(*)
    from public.payroll_schedule_snapshots
    where source_reference like 'payroll-reconciliation-test:%'
  ) as persistent_test_snapshots_should_be_zero,
  (
    select count(*)
    from public.attendance
    where admin_notes like 'payroll-reconciliation-test:%'
  ) as persistent_test_attendance_should_be_zero
from payroll_reconciliation_test_results;
