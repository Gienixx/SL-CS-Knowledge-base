-- Phase 2 Step 6: import payroll-ready attendance into immutable, versioned
-- payroll snapshots and flag non-finalized payroll records when the source
-- attendance changes after import.

begin;

alter table public.attendance
  add column attendance_version bigint not null default 1;

alter table public.attendance
  add constraint attendance_version_positive_check
  check (attendance_version > 0);

comment on column public.attendance.attendance_version is
  'Monotonic source version incremented on every attendance update and captured by payroll imports.';

create or replace function public.workforce_increment_attendance_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.attendance_version := old.attendance_version + 1;
  return new;
end;
$$;

drop trigger if exists attendance_increment_version on public.attendance;
create trigger attendance_increment_version
before update on public.attendance
for each row
execute function public.workforce_increment_attendance_version();

revoke all on function public.workforce_increment_attendance_version()
  from public, anon, authenticated;
grant execute on function public.workforce_increment_attendance_version()
  to service_role;

alter table public.payroll_attendance_snapshots
  drop constraint payroll_attendance_snapshots_record_attendance_key;

alter table public.payroll_attendance_snapshots
  add constraint payroll_attendance_snapshots_record_attendance_version_key
  unique (payroll_record_id, attendance_id, attendance_version);

comment on column public.payroll_attendance_snapshots.attendance_version is
  'Exact monotonic attendance.attendance_version captured during import.';

create or replace function public.payroll_prevent_snapshot_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    using
      errcode = '55000',
      message = 'Payroll attendance snapshots are immutable.';
end;
$$;

drop trigger if exists payroll_attendance_snapshots_immutable
  on public.payroll_attendance_snapshots;
create trigger payroll_attendance_snapshots_immutable
before update or delete on public.payroll_attendance_snapshots
for each row
execute function public.payroll_prevent_snapshot_mutation();

revoke all on function public.payroll_prevent_snapshot_mutation()
  from public, anon, authenticated;
grant execute on function public.payroll_prevent_snapshot_mutation()
  to service_role;

create or replace function public.payroll_flag_changed_attendance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := coalesce(
    public.workforce_current_profile_id(),
    new.updated_by,
    old.updated_by
  );
  v_target record;
  v_before public.payroll_records%rowtype;
  v_after public.payroll_records%rowtype;
  v_reason text := format(
    'Attendance changed after import for %s.',
    to_char(new.work_date, 'YYYY-MM-DD')
  );
begin
  for v_target in
    select distinct
      record.id as payroll_record_id,
      record.payroll_period_id
    from public.payroll_attendance_snapshots as snapshot
    join public.payroll_records as record
      on record.id = snapshot.payroll_record_id
    join public.payroll_periods as period
      on period.id = record.payroll_period_id
    where snapshot.attendance_id = new.id
      and snapshot.attendance_version < new.attendance_version
      and period.status not in ('finalized', 'void')
      and record.status not in ('finalized', 'void')
  loop
    select record.*
    into v_before
    from public.payroll_records as record
    where record.id = v_target.payroll_record_id
    for update;

    if not found
       or v_before.status in ('finalized', 'void') then
      continue;
    end if;

    update public.payroll_records
    set
      requires_recalculation = true,
      recalculation_reason = v_reason,
      updated_at = now()
    where id = v_before.id
    returning * into v_after;

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
      'payroll_attendance_changed_after_import',
      'payroll_record',
      v_after.id,
      v_after.payroll_period_id,
      v_after.id,
      jsonb_build_object(
        'requires_recalculation', v_before.requires_recalculation,
        'recalculation_reason', v_before.recalculation_reason
      ),
      jsonb_build_object(
        'requires_recalculation', v_after.requires_recalculation,
        'recalculation_reason', v_after.recalculation_reason
      ),
      v_reason,
      jsonb_build_object(
        'attendance_id', new.id,
        'employee_id', new.user_id,
        'work_date', new.work_date,
        'previous_attendance_version', old.attendance_version,
        'new_attendance_version', new.attendance_version
      )
    );
  end loop;

  return new;
end;
$$;

drop trigger if exists attendance_flag_payroll_recalculation
  on public.attendance;
create trigger attendance_flag_payroll_recalculation
after update on public.attendance
for each row
execute function public.payroll_flag_changed_attendance();

revoke all on function public.payroll_flag_changed_attendance()
  from public, anon, authenticated;
grant execute on function public.payroll_flag_changed_attendance()
  to service_role;

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
      attendance_row.clock_in,
      attendance_row.clock_out,
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
      source.clock_in,
      source.clock_out,
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

create or replace function public.payroll_get_period_attendance_import_status(
  p_payroll_period_id uuid
)
returns table (
  employee_user_id uuid,
  imported_attendance_count bigint,
  current_snapshot_count bigint,
  outdated_snapshot_count bigint,
  latest_imported_at timestamptz,
  requires_recalculation boolean,
  recalculation_reason text
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
        message = 'You do not have permission to view payroll attendance imports.';
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
  select
    record.employee_id,
    count(distinct snapshot.attendance_id),
    count(distinct snapshot.attendance_id) filter (
      where attendance_row.attendance_version = snapshot.attendance_version
    ),
    count(*) filter (
      where attendance_row.attendance_version > snapshot.attendance_version
    ),
    max(snapshot.imported_at),
    record.requires_recalculation,
    record.recalculation_reason
  from public.payroll_records as record
  left join public.payroll_attendance_snapshots as snapshot
    on snapshot.payroll_record_id = record.id
  left join public.attendance as attendance_row
    on attendance_row.id = snapshot.attendance_id
  where record.payroll_period_id = v_period.id
  group by
    record.id,
    record.employee_id,
    record.requires_recalculation,
    record.recalculation_reason
  order by record.employee_id;
end;
$$;

revoke all on function public.payroll_import_attendance(uuid)
  from public, anon;
revoke all on function public.payroll_get_period_attendance_import_status(uuid)
  from public, anon;

grant execute on function public.payroll_import_attendance(uuid)
  to authenticated, service_role;
grant execute on function public.payroll_get_period_attendance_import_status(uuid)
  to authenticated, service_role;

comment on function public.payroll_import_attendance(uuid) is
  'Imports only payroll-ready attendance into append-only versioned snapshots for a draft or reopened payroll period.';
comment on function public.payroll_get_period_attendance_import_status(uuid) is
  'Returns attendance snapshot coverage and recalculation flags without exposing rate or pay amounts.';

commit;
