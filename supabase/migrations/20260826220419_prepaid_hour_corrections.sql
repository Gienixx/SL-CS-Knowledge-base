-- Audited, append-only corrections for unsettled prepaid balances.
-- The original schedule snapshot and original balance values remain immutable;
-- a correction is a new balance version that supersedes the active version.
begin;

alter table public.payroll_prepaid_hours
  add column prepaid_version integer not null default 1,
  add column correction_of_id uuid
    references public.payroll_prepaid_hours(id) on delete restrict,
  add column effective_work_date date,
  add column effective_shift_start timestamptz,
  add column effective_shift_end timestamptz,
  add column effective_timezone text,
  add column correction_reason text,
  add column corrected_by uuid references public.profiles(user_id) on delete restrict,
  add column corrected_at timestamptz;

alter table public.payroll_prepaid_hours
  drop constraint payroll_prepaid_hours_source_snapshot_key,
  add constraint payroll_prepaid_hours_source_snapshot_version_key
    unique (source_schedule_snapshot_id, prepaid_version),
  add constraint payroll_prepaid_hours_version_check
    check (prepaid_version > 0),
  add constraint payroll_prepaid_hours_correction_check
    check (
      (
        prepaid_version = 1
        and correction_of_id is null
        and effective_work_date is null
        and effective_shift_start is null
        and effective_shift_end is null
        and effective_timezone is null
        and correction_reason is null
        and corrected_by is null
        and corrected_at is null
      )
      or (
        prepaid_version > 1
        and correction_of_id is not null
        and effective_work_date is not null
        and effective_shift_start is not null
        and effective_shift_end is not null
        and effective_shift_end > effective_shift_start
        and nullif(trim(effective_timezone), '') is not null
        and nullif(trim(correction_reason), '') is not null
        and corrected_by is not null
        and corrected_at is not null
      )
    ),
  add constraint payroll_prepaid_hours_not_self_corrected_check
    check (correction_of_id is null or correction_of_id <> id);

create index payroll_prepaid_hours_correction_idx
  on public.payroll_prepaid_hours (correction_of_id);

create or replace function public.payroll_guard_prepaid_hour_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception
      using
        errcode = '55000',
        message = 'Payroll prepaid-hour balances cannot be deleted.';
  end if;

  if new.source_payroll_record_id is distinct from old.source_payroll_record_id
     or new.source_schedule_snapshot_id is distinct from old.source_schedule_snapshot_id
     or new.employee_id is distinct from old.employee_id
     or new.prepaid_minutes is distinct from old.prepaid_minutes
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or new.prepaid_version is distinct from old.prepaid_version
     or new.correction_of_id is distinct from old.correction_of_id
     or new.effective_work_date is distinct from old.effective_work_date
     or new.effective_shift_start is distinct from old.effective_shift_start
     or new.effective_shift_end is distinct from old.effective_shift_end
     or new.effective_timezone is distinct from old.effective_timezone
     or new.correction_reason is distinct from old.correction_reason
     or new.corrected_by is distinct from old.corrected_by
     or new.corrected_at is distinct from old.corrected_at then
    raise exception
      using
        errcode = '55000',
        message = 'Payroll prepaid-hour source and correction details are immutable.';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

-- Corrected work dates/times are prepaid-only effective values. The live
-- published work schedule and the original payroll schedule snapshot are not
-- changed by this RPC.
create or replace function public.payroll_correct_prepaid_hours(
  p_prepaid_hour_id uuid,
  p_work_date date,
  p_prepaid_login time without time zone,
  p_prepaid_logout time without time zone,
  p_timezone text,
  p_correction_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := public.workforce_current_profile_id();
  v_old public.payroll_prepaid_hours%rowtype;
  v_snapshot public.payroll_schedule_snapshots%rowtype;
  v_record public.payroll_records%rowtype;
  v_period public.payroll_periods%rowtype;
  v_target_schedule public.work_schedules%rowtype;
  v_reason text := nullif(trim(p_correction_reason), '');
  v_timezone text := nullif(trim(p_timezone), '');
  v_local_start timestamp without time zone;
  v_local_end timestamp without time zone;
  v_shift_start timestamptz;
  v_shift_end timestamptz;
  v_minutes integer;
  v_schedule_count integer := 0;
  v_new_id uuid;
  v_old_work_date date;
  v_old_shift_start timestamptz;
  v_old_shift_end timestamptz;
  v_old_timezone text;
begin
  if auth.uid() is null
     or v_actor_user_id is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_has_permission('create_payroll') then
    raise exception
      using
        errcode = '42501',
        message = 'You do not have permission to edit payroll prepaid hours.';
  end if;

  if p_prepaid_hour_id is null
     or p_work_date is null
     or p_prepaid_login is null
     or p_prepaid_logout is null then
    raise exception
      using
        errcode = '22023',
        message = 'Prepaid entry, work date, login, and logout are required.';
  end if;

  if v_timezone is null or length(v_timezone) > 100 then
    raise exception
      using
        errcode = '22023',
        message = 'A valid prepaid timezone is required.';
  end if;

  if v_reason is null then
    raise exception
      using
        errcode = '22023',
        message = 'A correction reason is required.';
  end if;

  if length(v_reason) > 500 then
    raise exception
      using
        errcode = '22023',
        message = 'The correction reason cannot exceed 500 characters.';
  end if;

  begin
    perform pg_catalog.now() at time zone v_timezone;
  exception
    when invalid_parameter_value then
      raise exception
        using
          errcode = '22023',
          message = 'The selected prepaid timezone is not valid.';
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
  v_minutes := floor(extract(epoch from (v_shift_end - v_shift_start)) / 60)::integer;

  if v_shift_end <= v_shift_start
     or v_shift_end - v_shift_start > interval '24 hours'
     or v_minutes <= 0 then
    raise exception
      using
        errcode = '22023',
        message = 'Prepaid times must create a positive shift of no more than 24 hours.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.payroll_prepaid_correction:' || p_prepaid_hour_id::text,
      0
    )
  );

  select prepaid.*
  into v_old
  from public.payroll_prepaid_hours as prepaid
  where prepaid.id = p_prepaid_hour_id
  for update;

  if not found then
    raise exception
      using errcode = 'P0002', message = 'The prepaid entry was not found.';
  end if;

  -- Serialize correction with the existing snapshot-to-balance supersession
  -- trigger and with reconciliation for this employee.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.payroll_prepaid_hours:' || v_old.employee_id::text,
      0
    )
  );

  if v_old.voided_at is not null
     or v_old.superseded_by_id is not null then
    raise exception
      using
        errcode = '55000',
        message = 'Only the current active prepaid version can be edited.';
  end if;

  if v_old.settled_minutes > 0 then
    raise exception
      using
        errcode = '55000',
        message = 'This prepaid balance has already been partially or fully settled and cannot be edited safely.';
  end if;

  select snapshot.*
  into v_snapshot
  from public.payroll_schedule_snapshots as snapshot
  where snapshot.id = v_old.source_schedule_snapshot_id
    and snapshot.employee_id = v_old.employee_id;

  if not found then
    raise exception
      using
        errcode = '55000',
        message = 'The original prepaid schedule snapshot is missing.';
  end if;

  select record.*
  into v_record
  from public.payroll_records as record
  where record.id = v_old.source_payroll_record_id
    and record.employee_id = v_old.employee_id
  for update;

  if not found then
    raise exception
      using errcode = '55000', message = 'The prepaid payroll record is missing.';
  end if;

  select period.*
  into v_period
  from public.payroll_periods as period
  where period.id = v_record.payroll_period_id
  for update;

  if not found then
    raise exception
      using errcode = '55000', message = 'The prepaid payroll period is missing.';
  end if;

  if v_period.status not in ('draft', 'reopened')
     or v_record.status in ('approved', 'finalized', 'void') then
    raise exception
      using
        errcode = '55000',
        message = 'Prepaid corrections are protected after payroll review, finalization, or lock.';
  end if;

  if p_work_date < public.payroll_prepaid_eligibility_start(v_period.period_end)
     or p_work_date > v_period.period_end then
    raise exception
      using
        errcode = '22023',
        message = 'The corrected prepaid work date must be within ten calendar days before and on the payroll cutoff.';
  end if;

  if exists (
    select 1
    from public.attendance as attendance_row
    where attendance_row.user_id = v_old.employee_id
      and attendance_row.work_date = p_work_date
  ) then
    raise exception
      using
        errcode = '22023',
        message = 'Attendance already exists for this employee and date. Prepaid hours cannot be corrected onto attendance.';
  end if;

  select count(*)::integer
  into v_schedule_count
  from public.work_schedules as schedule
  where schedule.user_id = v_old.employee_id
    and schedule.shift_date = p_work_date;

  if v_schedule_count > 1 then
    raise exception
      using
        errcode = '22023',
        message = 'Multiple schedules exist for this employee and date. Resolve them before correcting prepaid hours.';
  end if;

  if v_schedule_count = 1 then
    select schedule.*
    into v_target_schedule
    from public.work_schedules as schedule
    where schedule.user_id = v_old.employee_id
      and schedule.shift_date = p_work_date
    for update;

    if v_target_schedule.is_rest_day then
      raise exception
        using errcode = '22023', message = 'Rest days do not create prepaid-hour debt.';
    end if;

    if v_target_schedule.is_holiday then
      raise exception
        using errcode = '22023', message = 'Guaranteed special days do not create prepaid-hour debt.';
    end if;

    if v_target_schedule.status in ('cancelled', 'completed') then
      raise exception
        using
          errcode = '22023',
          message = 'Cancelled or completed schedules cannot receive corrected prepaid hours.';
    end if;
  end if;

  if exists (
    select 1
    from public.payroll_prepaid_hours as other
    join public.payroll_schedule_snapshots as other_snapshot
      on other_snapshot.id = other.source_schedule_snapshot_id
    where other.employee_id = v_old.employee_id
      and other.id <> v_old.id
      and other.voided_at is null
      and coalesce(other.effective_work_date, other_snapshot.work_date) = p_work_date
  ) then
    raise exception
      using
        errcode = '22023',
        message = 'Another active prepaid entry already exists for this employee and corrected work date.';
  end if;

  select
    coalesce(v_old.effective_work_date, v_snapshot.work_date),
    coalesce(v_old.effective_shift_start, v_snapshot.shift_start),
    coalesce(v_old.effective_shift_end, v_snapshot.shift_end),
    coalesce(v_old.effective_timezone, v_snapshot.timezone)
  into v_old_work_date, v_old_shift_start, v_old_shift_end, v_old_timezone;

  insert into public.payroll_prepaid_hours (
    source_payroll_record_id,
    source_schedule_snapshot_id,
    employee_id,
    prepaid_minutes,
    settled_minutes,
    prepaid_version,
    correction_of_id,
    effective_work_date,
    effective_shift_start,
    effective_shift_end,
    effective_timezone,
    correction_reason,
    corrected_by,
    corrected_at,
    created_by,
    created_at,
    updated_at
  )
  values (
    v_old.source_payroll_record_id,
    v_old.source_schedule_snapshot_id,
    v_old.employee_id,
    v_minutes,
    0,
    v_old.prepaid_version + 1,
    v_old.id,
    p_work_date,
    v_shift_start,
    v_shift_end,
    v_timezone,
    v_reason,
    v_actor_user_id,
    pg_catalog.statement_timestamp(),
    v_actor_user_id,
    pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp()
  )
  returning id into v_new_id;

  update public.payroll_prepaid_hours
  set
    voided_at = pg_catalog.statement_timestamp(),
    voided_by = v_actor_user_id,
    void_reason = 'Superseded by audited prepaid correction ' || v_new_id::text || '.',
    superseded_by_id = v_new_id
  where id = v_old.id;

  if v_record.calculated_at is not null then
    update public.payroll_records
    set
      requires_recalculation = true,
      recalculation_reason = 'Prepaid hours were corrected; recalculate payroll before review.',
      updated_at = pg_catalog.statement_timestamp()
    where id = v_record.id;
  end if;

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
    'payroll_prepaid_hours_corrected',
    'payroll_prepaid_hours',
    v_new_id,
    v_period.id,
    v_record.id,
    jsonb_build_object(
      'prepaid_hour_id', v_old.id,
      'prepaid_version', v_old.prepaid_version,
      'work_date', v_old_work_date,
      'prepaid_login', v_old_shift_start,
      'prepaid_logout', v_old_shift_end,
      'timezone', v_old_timezone,
      'prepaid_minutes', v_old.prepaid_minutes,
      'settled_minutes', v_old.settled_minutes
    ),
    jsonb_build_object(
      'prepaid_hour_id', v_new_id,
      'prepaid_version', v_old.prepaid_version + 1,
      'work_date', p_work_date,
      'prepaid_login', v_shift_start,
      'prepaid_logout', v_shift_end,
      'timezone', v_timezone,
      'prepaid_minutes', v_minutes,
      'settled_minutes', 0,
      'correction_of_id', v_old.id,
      'source_snapshot_unchanged', true,
      'live_schedule_unchanged', true,
      'payroll_recalculation_required', v_record.calculated_at is not null
    ),
    v_reason,
    jsonb_build_object(
      'original_prepaid_hour_id', v_old.id,
      'corrected_prepaid_hour_id', v_new_id,
      'actor_user_id', v_actor_user_id,
      'correction_reason', v_reason
    )
  );

  return jsonb_build_object(
    'prepaid_hour_id', v_new_id,
    'superseded_prepaid_hour_id', v_old.id,
    'prepaid_version', v_old.prepaid_version + 1,
    'prepaid_minutes', v_minutes,
    'work_date', p_work_date,
    'requires_recalculation', v_record.calculated_at is not null
  );
end;
$$;

revoke all on function public.payroll_correct_prepaid_hours(
  uuid, date, time without time zone, time without time zone, text, text
) from public, anon, authenticated;
grant execute on function public.payroll_correct_prepaid_hours(
  uuid, date, time without time zone, time without time zone, text, text
) to authenticated, service_role;

-- Return both immutable history and the current effective correction values.
drop function public.payroll_get_period_prepaid_hours(uuid);
create function public.payroll_get_period_prepaid_hours(
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
  settlement_line_count bigint,
  prepaid_version integer,
  correction_of_id uuid,
  effective_shift_start timestamptz,
  effective_shift_end timestamptz,
  effective_timezone text,
  correction_reason text,
  corrected_by uuid,
  corrected_at timestamptz,
  original_work_date date,
  original_shift_start timestamptz,
  original_shift_end timestamptz,
  original_timezone text,
  created_by uuid,
  created_at timestamptz,
  created_by_name text,
  corrected_by_name text,
  original_approval_reason text
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
    coalesce(prepaid.effective_work_date, snapshot.work_date),
    prepaid.prepaid_minutes,
    prepaid.settled_minutes,
    prepaid.remaining_minutes,
    prepaid.status,
    snapshot.approved_at,
    prepaid.last_settled_at,
    count(allocation.id) filter (
      where allocation.allocation_type = 'settlement'
    ),
    prepaid.prepaid_version,
    prepaid.correction_of_id,
    coalesce(prepaid.effective_shift_start, snapshot.shift_start),
    coalesce(prepaid.effective_shift_end, snapshot.shift_end),
    coalesce(prepaid.effective_timezone, snapshot.timezone),
    prepaid.correction_reason,
    prepaid.corrected_by,
    prepaid.corrected_at,
    snapshot.work_date,
    snapshot.shift_start,
    snapshot.shift_end,
    snapshot.timezone,
    prepaid.created_by,
    prepaid.created_at,
    creator.full_name,
    correction_actor.full_name,
    snapshot.approval_reason
  from public.payroll_prepaid_hours as prepaid
  join public.payroll_schedule_snapshots as snapshot
    on snapshot.id = prepaid.source_schedule_snapshot_id
  join public.payroll_records as record
    on record.id = prepaid.source_payroll_record_id
   and record.employee_id = prepaid.employee_id
  join public.profiles as profile
    on profile.user_id = prepaid.employee_id
  left join public.profiles as creator
    on creator.user_id = prepaid.created_by
  left join public.profiles as correction_actor
    on correction_actor.user_id = prepaid.corrected_by
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
    prepaid.effective_work_date,
    snapshot.work_date,
    prepaid.prepaid_minutes,
    prepaid.settled_minutes,
    prepaid.remaining_minutes,
    prepaid.status,
    snapshot.approved_at,
    prepaid.last_settled_at,
    prepaid.prepaid_version,
    prepaid.correction_of_id,
    prepaid.effective_shift_start,
    snapshot.shift_start,
    prepaid.effective_shift_end,
    snapshot.shift_end,
    prepaid.effective_timezone,
    snapshot.timezone,
    prepaid.correction_reason,
    prepaid.corrected_by,
    prepaid.corrected_at,
    prepaid.created_by,
    prepaid.created_at,
    creator.full_name,
    correction_actor.full_name,
    snapshot.approval_reason
  order by
    coalesce(prepaid.effective_work_date, snapshot.work_date),
    profile.full_name,
    prepaid.prepaid_version,
    prepaid.id;
end;
$$;

revoke all on function public.payroll_get_period_prepaid_hours(uuid)
  from public, anon;
grant execute on function public.payroll_get_period_prepaid_hours(uuid)
  to authenticated, service_role;

-- The active effective work date is the FIFO/reconciliation date.
do $$
declare
  v_definition text;
begin
  v_definition := replace(pg_get_functiondef(
    'public.payroll_reconcile_prepaid_hours()'::regprocedure
  ), chr(13), '');
  if position('and source_snapshot.work_date <= new.work_date' in v_definition) = 0
     or position('source_snapshot.work_date,' || chr(10) || '        prepaid.created_at' in v_definition) = 0 then
    raise exception 'payroll_reconcile_prepaid_hours live definition is not the expected version';
  end if;
  v_definition := replace(
    v_definition,
    'and source_snapshot.work_date <= new.work_date',
    'and coalesce(prepaid.effective_work_date, source_snapshot.work_date) <= new.work_date'
  );
  v_definition := replace(
    v_definition,
    'source_snapshot.work_date,' || chr(10) || '        prepaid.created_at',
    'coalesce(prepaid.effective_work_date, source_snapshot.work_date),' || chr(10) || '        prepaid.created_at'
  );
  if position('coalesce(prepaid.effective_work_date, source_snapshot.work_date) <= new.work_date' in v_definition) = 0
     or position('coalesce(prepaid.effective_work_date, source_snapshot.work_date),' || chr(10) || '        prepaid.created_at' in v_definition) = 0 then
    raise exception 'payroll_reconcile_prepaid_hours correction rewrite did not apply';
  end if;
  execute v_definition;
end;
$$;

-- Only the prepaid earning source/date/rate inputs change in the calculator.
do $$
declare
  v_definition text;
begin
  v_definition := replace(pg_get_functiondef(
    'public.payroll_calculate_draft(uuid, uuid)'::regprocedure
  ), chr(13), '');
  if position('-- Approved pre-plotted schedules are paid in their source payroll period.' in v_definition) = 0
     or position('    snapshot.work_date,' || chr(10) || '    snapshot.id,' in v_definition) = 0
     or position('effective_rate.effective_date <= snapshot.work_date' in v_definition) = 0 then
    raise exception 'payroll_calculate_draft live definition is not the expected version';
  end if;
  v_definition := replace(
    v_definition,
    '    snapshot.work_date,' || chr(10) || '    snapshot.id,',
    '    coalesce(prepaid.effective_work_date, snapshot.work_date),' || chr(10) || '    snapshot.id,'
  );
  v_definition := replace(
    v_definition,
    'effective_rate.effective_date <= snapshot.work_date',
    'effective_rate.effective_date <= coalesce(prepaid.effective_work_date, snapshot.work_date)'
  );
  if position('coalesce(prepaid.effective_work_date, snapshot.work_date),' || chr(10) || '    snapshot.id,' in v_definition) = 0
     or position('effective_rate.effective_date <= coalesce(prepaid.effective_work_date, snapshot.work_date)' in v_definition) = 0 then
    raise exception 'payroll_calculate_draft prepaid correction rewrite did not apply';
  end if;
  execute v_definition;
end;
$$;

-- Finalization evidence must bucket corrected balances by their effective date.
do $$
declare
  v_definition text;
begin
  v_definition := replace(pg_get_functiondef(
    'public.payroll_collect_finalization_evidence(uuid)'::regprocedure
  ), chr(13), '');
  if position('source_snapshot.work_date <= period.period_end' in v_definition) = 0
     or position('source_snapshot.work_date < period.period_start' in v_definition) = 0
     or position('source_snapshot.work_date' || chr(10) || '            between period.period_start and period.period_end' in v_definition) = 0 then
    raise exception 'payroll_collect_finalization_evidence live definition is not the expected version';
  end if;
  v_definition := replace(
    v_definition,
    'source_snapshot.work_date <= period.period_end',
    'coalesce(prepaid.effective_work_date, source_snapshot.work_date) <= period.period_end'
  );
  v_definition := replace(
    v_definition,
    'source_snapshot.work_date < period.period_start',
    'coalesce(prepaid.effective_work_date, source_snapshot.work_date) < period.period_start'
  );
  v_definition := replace(
    v_definition,
    'source_snapshot.work_date' || chr(10) || '            between period.period_start and period.period_end',
    'coalesce(prepaid.effective_work_date, source_snapshot.work_date)' || chr(10) || '            between period.period_start and period.period_end'
  );
  if position('coalesce(prepaid.effective_work_date, source_snapshot.work_date) < period.period_start' in v_definition) = 0
     or position('coalesce(prepaid.effective_work_date, source_snapshot.work_date)' || chr(10) || '            between period.period_start and period.period_end' in v_definition) = 0 then
    raise exception 'payroll_collect_finalization_evidence correction rewrite did not apply';
  end if;
  execute v_definition;
end;
$$;

-- Exception/readiness checks use effective correction values while retaining
-- the immutable source schedule comparison.
do $$
declare
  v_definition text;
begin
  v_definition := replace(pg_get_functiondef(
    'public.payroll_get_period_exceptions(uuid)'::regprocedure
  ), chr(13), '');
  if position('snapshot.work_date,' || chr(10) || '      snapshot.schedule_id,' in v_definition) = 0
     or position('prepaid.prepaid_minutes <> prepaid.scheduled_minutes' in v_definition) = 0 then
    raise exception 'payroll_get_period_exceptions live definition is not the expected version';
  end if;
  v_definition := replace(
    v_definition,
    '      snapshot.work_date,' || chr(10) || '      snapshot.schedule_id,',
    '      snapshot.work_date as source_work_date,' || chr(10) || '      coalesce(prepaid.effective_work_date, snapshot.work_date) as work_date,' || chr(10) || '      snapshot.schedule_id,'
  );
  v_definition := replace(
    v_definition,
    '      snapshot.shift_end,' || chr(10) || '      snapshot.timezone,' || chr(10) || '      snapshot.scheduled_minutes,',
    '      snapshot.shift_end,' || chr(10) || '      snapshot.timezone,' || chr(10) || '      floor(extract(epoch from (coalesce(prepaid.effective_shift_end, snapshot.shift_end) - coalesce(prepaid.effective_shift_start, snapshot.shift_start))) / 60)::integer as scheduled_minutes,' || chr(10) || '      coalesce(prepaid.effective_shift_start, snapshot.shift_start) as effective_shift_start,' || chr(10) || '      coalesce(prepaid.effective_shift_end, snapshot.shift_end) as effective_shift_end,' || chr(10) || '      coalesce(prepaid.effective_timezone, snapshot.timezone) as effective_timezone,'
  );
  v_definition := replace(
    v_definition,
    'prepaid.current_work_date is distinct from prepaid.work_date',
    'prepaid.current_work_date is distinct from prepaid.source_work_date'
  );
  v_definition := replace(
    v_definition,
    'prepaid.current_work_date is distinct from' || chr(10) || '          prepaid.work_date',
    'prepaid.current_work_date is distinct from prepaid.source_work_date'
  );
  v_definition := replace(v_definition, 'prepaid.shift_start is null', 'prepaid.effective_shift_start is null');
  v_definition := replace(v_definition, 'prepaid.shift_end is null', 'prepaid.effective_shift_end is null');
  v_definition := replace(v_definition, 'prepaid.shift_end <= prepaid.shift_start', 'prepaid.effective_shift_end <= prepaid.effective_shift_start');
  v_definition := replace(v_definition, 'nullif(trim(prepaid.timezone), '''') is null', 'nullif(trim(prepaid.effective_timezone), '''') is null');
  if position('prepaid.current_work_date is distinct from prepaid.source_work_date' in v_definition) = 0
     or position('prepaid.effective_shift_start is null' in v_definition) = 0
     or position('coalesce(prepaid.effective_work_date, snapshot.work_date) as work_date' in v_definition) = 0 then
    raise exception 'payroll_get_period_exceptions correction rewrite did not apply';
  end if;
  execute v_definition;
end;
$$;

-- Team Attendance should show only the active effective balance when it
-- happens to render a reconciled prepaid source.
do $$
declare
  v_definition text;
begin
  v_definition := replace(pg_get_functiondef(
    'public.workforce_list_team_attendance_prepaid(date, date)'::regprocedure
  ), chr(13), '');
  if position('prepaid.prepaid_minutes' in v_definition) = 0
     or position('snapshot.work_date = attendance_row.work_date' in v_definition) = 0 then
    raise exception 'workforce_list_team_attendance_prepaid live definition is not the expected version';
  end if;
  v_definition := replace(
    v_definition,
    '      snapshot.shift_start,' || chr(10) || '      snapshot.shift_end,',
    '      coalesce(prepaid.effective_shift_start, snapshot.shift_start),' || chr(10) || '      coalesce(prepaid.effective_shift_end, snapshot.shift_end),'
  );
  v_definition := replace(
    v_definition,
    '     and prepaid.employee_id = snapshot.employee_id' || chr(10) || '    where',
    '     and prepaid.employee_id = snapshot.employee_id' || chr(10) || '     and prepaid.voided_at is null' || chr(10) || '    where'
  );
  v_definition := replace(
    v_definition,
    '      and snapshot.work_date = attendance_row.work_date',
    '      and coalesce(prepaid.effective_work_date, snapshot.work_date) = attendance_row.work_date'
  );
  if position('and prepaid.voided_at is null' in v_definition) = 0
     or position('coalesce(prepaid.effective_work_date, snapshot.work_date) = attendance_row.work_date' in v_definition) = 0 then
    raise exception 'workforce_list_team_attendance_prepaid correction rewrite did not apply';
  end if;
  execute v_definition;
end;
$$;

comment on function public.payroll_correct_prepaid_hours(
  uuid, date, time without time zone, time without time zone, text, text
) is
  'Creates an audited immutable prepaid correction version for an unsettled balance without changing the live schedule or original snapshot.';

-- The existing snapshot trigger now targets the versioned uniqueness key.
do $$
declare
  v_definition text;
begin
  v_definition := replace(pg_get_functiondef(
    'public.payroll_create_prepaid_balance()'::regprocedure
  ), chr(13), '');
  if position('on conflict (source_schedule_snapshot_id) do nothing' in v_definition) = 0 then
    raise exception 'payroll_create_prepaid_balance live definition is not the expected version';
  end if;
  v_definition := replace(
    v_definition,
    'on conflict (source_schedule_snapshot_id) do nothing',
    'on conflict (source_schedule_snapshot_id, prepaid_version) do nothing'
  );
  if position('on conflict (source_schedule_snapshot_id, prepaid_version) do nothing' in v_definition) = 0 then
    raise exception 'payroll_create_prepaid_balance versioned conflict rewrite did not apply';
  end if;
  execute v_definition;
end;
$$;

commit;
