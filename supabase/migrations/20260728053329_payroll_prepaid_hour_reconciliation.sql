begin;

-- Live attendance must represent an event that has already happened. Future
-- paid coverage is represented by payroll schedule snapshots and prepaid
-- balances, never by inserting a completed attendance row ahead of time.
create or replace function public.workforce_reject_future_attendance_timestamps()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_latest_allowed timestamptz := statement_timestamp() + interval '5 minutes';
begin
  if new.clock_in is not null and new.clock_in > v_latest_allowed then
    raise exception
      using
        errcode = '22007',
        message = 'Clock-in cannot be recorded in the future. Use a payroll pre-plot for prepaid hours.';
  end if;

  if new.clock_out is not null and new.clock_out > v_latest_allowed then
    raise exception
      using
        errcode = '22007',
        message = 'Clock-out cannot be recorded in the future. Use a payroll pre-plot for prepaid hours.';
  end if;

  return new;
end;
$$;

drop trigger if exists attendance_reject_future_timestamps
  on public.attendance;
create trigger attendance_reject_future_timestamps
before insert or update of clock_in, clock_out on public.attendance
for each row
execute function public.workforce_reject_future_attendance_timestamps();

revoke all on function public.workforce_reject_future_attendance_timestamps()
  from public, anon, authenticated;
grant execute on function public.workforce_reject_future_attendance_timestamps()
  to service_role;

comment on function public.workforce_reject_future_attendance_timestamps() is
  'Prevents planned or prepaid future time from being inserted as completed live attendance.';

-- Every approved ordinary pre-plot becomes a minute balance. Re-approving a
-- changed schedule supersedes an unsettled prior version instead of creating
-- two active balances for the same scheduled day.
create or replace function public.payroll_create_prepaid_balance()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_previous_balance record;
  v_new_prepaid_hour_id uuid;
begin
  if new.is_rest_day
     or new.is_holiday
     or new.scheduled_minutes <= 0 then
    raise exception
      using
        errcode = '22023',
        message = 'Only future ordinary schedules with positive minutes can create prepaid-hour balances.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.payroll_prepaid_hours:' || new.employee_id::text,
      0
    )
  );

  for v_previous_balance in
    select
      prepaid.id,
      prepaid.settled_minutes
    from public.payroll_prepaid_hours as prepaid
    join public.payroll_schedule_snapshots as previous_snapshot
      on previous_snapshot.id = prepaid.source_schedule_snapshot_id
    where previous_snapshot.payroll_record_id = new.payroll_record_id
      and previous_snapshot.schedule_id = new.schedule_id
      and previous_snapshot.id <> new.id
      and prepaid.voided_at is null
    order by previous_snapshot.schedule_version, prepaid.id
    for update of prepaid
  loop
    if v_previous_balance.settled_minutes > 0 then
      raise exception
        using
          errcode = '55000',
          message = 'A changed pre-plot cannot be reapproved after its prepaid balance has started settling.';
    end if;
  end loop;

  insert into public.payroll_prepaid_hours (
    source_payroll_record_id,
    source_schedule_snapshot_id,
    employee_id,
    prepaid_minutes,
    settled_minutes,
    created_by,
    created_at,
    updated_at
  )
  values (
    new.payroll_record_id,
    new.id,
    new.employee_id,
    new.scheduled_minutes,
    0,
    new.approved_by,
    new.approved_at,
    new.approved_at
  )
  on conflict (source_schedule_snapshot_id) do nothing
  returning id into v_new_prepaid_hour_id;

  if v_new_prepaid_hour_id is null then
    select prepaid.id
    into v_new_prepaid_hour_id
    from public.payroll_prepaid_hours as prepaid
    where prepaid.source_schedule_snapshot_id = new.id;
  end if;

  update public.payroll_prepaid_hours as prepaid
  set
    voided_at = new.approved_at,
    voided_by = new.approved_by,
    void_reason = 'Superseded by approved schedule version ' ||
      new.schedule_version::text || '.',
    superseded_by_id = v_new_prepaid_hour_id
  from public.payroll_schedule_snapshots as previous_snapshot
  where previous_snapshot.id = prepaid.source_schedule_snapshot_id
    and previous_snapshot.payroll_record_id = new.payroll_record_id
    and previous_snapshot.schedule_id = new.schedule_id
    and previous_snapshot.id <> new.id
    and prepaid.voided_at is null;

  return new;
end;
$$;

drop trigger if exists payroll_schedule_snapshot_create_prepaid_balance
  on public.payroll_schedule_snapshots;
create trigger payroll_schedule_snapshot_create_prepaid_balance
after insert on public.payroll_schedule_snapshots
for each row
execute function public.payroll_create_prepaid_balance();

revoke all on function public.payroll_create_prepaid_balance()
  from public, anon, authenticated;
grant execute on function public.payroll_create_prepaid_balance()
  to service_role;

comment on function public.payroll_create_prepaid_balance() is
  'Creates one prepaid-minute balance per approved ordinary schedule snapshot and safely supersedes an unsettled prior schedule version.';

-- When payroll-ready attendance is imported, apply approved billed rendered minutes
-- to the employee's oldest eligible prepaid balance. Categories settle in this
-- order: regular, normal pre-shift overtime, normal post-shift overtime.
-- Special-day minutes never reach this trigger because they are explicitly
-- skipped below.
create or replace function public.payroll_reconcile_prepaid_hours()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_actor_user_id uuid := public.workforce_current_profile_id();
  v_previous_allocation record;
  v_balance record;
  v_category record;
  v_available_minutes integer;
  v_allocated_minutes integer;
  v_total_allocated integer := 0;
  v_total_reversed integer := 0;
  v_calculation_version integer;
begin
  if new.attendance_version > 2147483647 then
    raise exception
      using
        errcode = '22003',
        message = 'Attendance version is too large for payroll reconciliation.';
  end if;

  v_calculation_version := new.attendance_version::integer;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.payroll_prepaid_hours:' || new.employee_id::text,
      0
    )
  );

  -- If a corrected attendance version is imported, reverse the still-active
  -- allocations made by its earlier snapshot before applying the new values.
  for v_previous_allocation in
    select
      allocation.id,
      allocation.prepaid_hour_id,
      allocation.minute_category,
      allocation.allocated_minutes
    from public.payroll_hour_allocations as allocation
    join public.payroll_attendance_snapshots as previous_snapshot
      on previous_snapshot.id = allocation.attendance_snapshot_id
    where previous_snapshot.payroll_record_id = new.payroll_record_id
      and previous_snapshot.attendance_id = new.attendance_id
      and previous_snapshot.id <> new.id
      and allocation.employee_id = new.employee_id
      and allocation.allocation_type = 'settlement'
      and not exists (
        select 1
        from public.payroll_hour_allocations as reversal
        where reversal.reverses_allocation_id = allocation.id
      )
    order by allocation.created_at, allocation.id
  loop
    select
      prepaid.id,
      prepaid.settled_minutes
    into v_balance
    from public.payroll_prepaid_hours as prepaid
    where prepaid.id = v_previous_allocation.prepaid_hour_id
    for update;

    if not found
       or v_balance.settled_minutes <
          v_previous_allocation.allocated_minutes then
      raise exception
        using
          errcode = '23514',
          message = 'The prior prepaid-hour allocation cannot be safely reversed.';
    end if;

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
      v_previous_allocation.prepaid_hour_id,
      new.employee_id,
      new.payroll_record_id,
      new.id,
      'reversal',
      v_previous_allocation.minute_category,
      v_previous_allocation.allocated_minutes,
      v_calculation_version,
      v_previous_allocation.id,
      'Reversed because a newer approved attendance version was imported.',
      v_actor_user_id
    );

    update public.payroll_prepaid_hours
    set
      settled_minutes =
        settled_minutes - v_previous_allocation.allocated_minutes,
      last_settled_at = case
        when settled_minutes - v_previous_allocation.allocated_minutes = 0
          then null
        else last_settled_at
      end
    where id = v_previous_allocation.prepaid_hour_id;

    v_total_reversed :=
      v_total_reversed + v_previous_allocation.allocated_minutes;
  end loop;

  if new.special_day_type <> 'ordinary'
     or new.is_rest_day
     or new.is_holiday then
    return new;
  end if;

  for v_category in
    select category.minute_category, category.available_minutes
    from (
      values
        ('regular'::text, greatest(0, floor(extract(epoch from (new.clock_out - new.clock_in)) / 60)::integer))
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
      where prepaid.employee_id = new.employee_id
        and prepaid.voided_at is null
        and prepaid.remaining_minutes > 0
        and source_snapshot.work_date <= new.work_date
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
        new.employee_id,
        new.payroll_record_id,
        new.id,
        'settlement',
        v_category.minute_category,
        v_allocated_minutes,
        v_calculation_version,
        null,
        'Applied approved ordinary attendance to the oldest prepaid-hour balance.',
        v_actor_user_id
      );

      update public.payroll_prepaid_hours
      set
        settled_minutes = settled_minutes + v_allocated_minutes,
        last_settled_at = statement_timestamp()
      where id = v_balance.id;

      v_available_minutes := v_available_minutes - v_allocated_minutes;
      v_total_allocated := v_total_allocated + v_allocated_minutes;
    end loop;
  end loop;

  if v_actor_user_id is not null
     and (v_total_allocated > 0 or v_total_reversed > 0) then
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
      'payroll_prepaid_hours_reconciled',
      'payroll_attendance_snapshot',
      new.id,
      record.payroll_period_id,
      jsonb_build_object(
        'allocated_minutes', v_total_allocated,
        'reversed_minutes', v_total_reversed
      ),
      'Reconciled approved ordinary attendance against FIFO prepaid-hour balances.',
      jsonb_build_object(
        'attendance_id', new.attendance_id,
        'attendance_version', new.attendance_version,
        'employee_id', new.employee_id,
        'work_date', new.work_date
      )
    from public.payroll_records as record
    where record.id = new.payroll_record_id;
  end if;

  return new;
end;
$$;

drop trigger if exists payroll_attendance_snapshot_reconcile_prepaid_hours
  on public.payroll_attendance_snapshots;
create trigger payroll_attendance_snapshot_reconcile_prepaid_hours
after insert on public.payroll_attendance_snapshots
for each row
execute function public.payroll_reconcile_prepaid_hours();

revoke all on function public.payroll_reconcile_prepaid_hours()
  from public, anon, authenticated;
grant execute on function public.payroll_reconcile_prepaid_hours()
  to service_role;

comment on function public.payroll_reconcile_prepaid_hours() is
  'Applies imported ordinary attendance to FIFO prepaid-hour balances, carries shortfalls forward, and reverses superseded attendance-version allocations.';

create or replace function public.payroll_get_period_prepaid_hours(
  p_payroll_period_id uuid
)
returns table (
  prepaid_hour_id uuid,
  payroll_record_id uuid,
  employee_user_id uuid,
  employee_name text,
  employee_number text,
  schedule_id uuid,
  work_date date,
  prepaid_minutes integer,
  settled_minutes integer,
  remaining_minutes integer,
  balance_status text,
  approved_at timestamptz,
  last_settled_at timestamptz,
  settlement_line_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
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
        message = 'You do not have permission to view prepaid-hour balances.';
  end if;

  return query
  select
    prepaid.id,
    prepaid.source_payroll_record_id,
    prepaid.employee_id,
    profile.full_name,
    profile.employee_id,
    snapshot.schedule_id,
    snapshot.work_date,
    prepaid.prepaid_minutes,
    prepaid.settled_minutes,
    prepaid.remaining_minutes,
    prepaid.status,
    snapshot.approved_at,
    prepaid.last_settled_at,
    count(allocation.id) filter (
      where allocation.allocation_type = 'settlement'
    )
  from public.payroll_prepaid_hours as prepaid
  join public.payroll_schedule_snapshots as snapshot
    on snapshot.id = prepaid.source_schedule_snapshot_id
  join public.payroll_records as record
    on record.id = prepaid.source_payroll_record_id
   and record.employee_id = prepaid.employee_id
  join public.profiles as profile
    on profile.user_id = prepaid.employee_id
  left join public.payroll_hour_allocations as allocation
    on allocation.prepaid_hour_id = prepaid.id
  where record.payroll_period_id = p_payroll_period_id
  group by
    prepaid.id,
    prepaid.source_payroll_record_id,
    prepaid.employee_id,
    profile.full_name,
    profile.employee_id,
    snapshot.schedule_id,
    snapshot.work_date,
    snapshot.approved_at
  order by snapshot.work_date, profile.full_name, prepaid.id;
end;
$$;

revoke all on function public.payroll_get_period_prepaid_hours(uuid)
  from public, anon;
grant execute on function public.payroll_get_period_prepaid_hours(uuid)
  to authenticated, service_role;

comment on function public.payroll_get_period_prepaid_hours(uuid) is
  'Returns non-rate prepaid-hour balances for authorized payroll users on the payroll-period page.';

commit;
