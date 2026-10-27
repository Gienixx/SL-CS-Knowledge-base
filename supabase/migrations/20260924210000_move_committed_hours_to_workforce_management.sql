begin;
-- Standalone daily targets are kept in the existing audited, versioned ledger.
-- Nullable Payroll V1 references distinguish new Workforce Management targets
-- without touching the historical prepaid table or existing commitment rows.
alter table public.payroll_prepaid_commitments
  alter column payroll_period_id drop not null,
  alter column payroll_record_id drop not null;
alter table public.payroll_prepaid_commitments
  drop constraint if exists payroll_prepaid_commitments_period_record_pair_check;
alter table public.payroll_prepaid_commitments
  add constraint payroll_prepaid_commitments_period_record_pair_check
  check ((payroll_period_id is null) = (payroll_record_id is null));
do $preflight$
begin
  if exists (
    select 1
    from public.payroll_prepaid_commitments commitment
    where commitment.superseded_at is null
    group by commitment.employee_id, commitment.work_date
    having count(*) > 1
  ) then
    raise exception 'Cannot enforce one active Committed Hours target per employee and date: active duplicates exist.';
  end if;
end;
$preflight$;
drop index if exists public.payroll_prepaid_commitments_active_target_key;
create unique index payroll_prepaid_commitments_active_employee_date_key
  on public.payroll_prepaid_commitments (employee_id, work_date)
  where superseded_at is null;
-- One chronological projection is shared by Agent Attendance, Team Attendance,
-- Workforce Management, and Payroll V2. Attendance is allocated once, to the
-- oldest open target, and never banked when no target is outstanding.
create or replace function public.payroll_get_expected_committed_hours_summary(
  p_employee_user_id uuid,
  p_start_date date,
  p_end_date date
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  v_first_date date;
  v_day date;
  v_queue jsonb := '[]'::jsonb;
  v_open_queue jsonb := '[]'::jsonb;
  v_targets jsonb := '[]'::jsonb;
  v_carryover_targets jsonb := '[]'::jsonb;
  v_payroll_targets jsonb := '[]'::jsonb;
  v_days jsonb := '[]'::jsonb;
  v_target jsonb;
  v_attendance record;
  v_target_row record;
  v_index integer;
  v_day_ready integer;
  v_day_used integer;
  v_day_carryover integer;
  v_day_target_minutes integer;
  v_day_expected_minutes integer;
  v_attendance_minutes integer;
  v_apply integer;
  v_target_remaining integer;
  v_opening_carryover integer := 0;
  v_current_target_minutes integer := 0;
  v_expected_minutes integer := 0;
  v_credited_minutes integer := 0;
  v_remaining_minutes integer := 0;
  v_paid_minutes integer;
  v_queue_length integer;
  v_status text;
begin
  if p_employee_user_id is null or p_start_date is null or p_end_date is null then
    raise exception using errcode = '22004', message = 'Employee and date range are required.';
  end if;
  if p_end_date < p_start_date then
    raise exception using errcode = '22007', message = 'End date cannot be earlier than start date.';
  end if;
  if p_end_date - p_start_date > 366 then
    raise exception using errcode = '22023', message = 'Committed Hours date ranges cannot exceed 367 calendar days.';
  end if;

  select min(commitment.work_date)
  into v_first_date
  from public.payroll_prepaid_commitments commitment
  where commitment.employee_id = p_employee_user_id
    and commitment.work_date <= p_end_date
    and commitment.superseded_at is null;

  if v_first_date is null then
    return jsonb_build_object(
      'expected_minutes', 0, 'target_minutes', 0, 'carryover_minutes', 0,
      'payroll_ready_minutes', 0,
      'covered_minutes', 0, 'credited_minutes', 0, 'remaining_minutes', 0,
      'status', 'No commitment required', 'targets', '[]'::jsonb,
      'carryover_targets', '[]'::jsonb, 'payroll_targets', '[]'::jsonb,
      'days', '[]'::jsonb
    );
  end if;

  if p_start_date < v_first_date then
    v_open_queue := '[]'::jsonb;
  end if;

  for v_day in
    select generated.work_date::date
    from generate_series(v_first_date, p_end_date, interval '1 day') generated(work_date)
    order by generated.work_date
  loop
    -- Capture the debt at the boundary before this range's first target is due.
    if v_day = p_start_date then
      v_open_queue := '[]'::jsonb;
      v_queue_length := jsonb_array_length(v_queue);
      if v_queue_length > 0 then
        for v_index in 0..v_queue_length - 1 loop
          v_target := v_queue -> v_index;
          if (v_target ->> 'work_date')::date < p_start_date
             and coalesce((v_target ->> 'remaining_minutes')::integer, 0) > 0 then
            v_target := jsonb_set(
              v_target, '{carryover_minutes}', v_target -> 'remaining_minutes', true
            );
            v_queue := jsonb_set(v_queue, array[v_index::text], v_target, true);
            v_open_queue := v_open_queue || jsonb_build_array(v_target);
            v_opening_carryover := v_opening_carryover
              + (v_target ->> 'remaining_minutes')::integer;
          end if;
        end loop;
      end if;
    end if;

    v_day_ready := 0;
    v_day_used := 0;
    v_day_carryover := 0;
    v_day_target_minutes := 0;

    for v_target_row in
      select commitment.id, commitment.work_date, commitment.expected_minutes,
        commitment.commitment_version, commitment.prepaid_day_type
      from public.payroll_prepaid_commitments commitment
      where commitment.employee_id = p_employee_user_id
        and commitment.work_date = v_day
        and commitment.superseded_at is null
      order by commitment.work_date, commitment.created_at, commitment.id
    loop
      v_queue := v_queue || jsonb_build_array(jsonb_build_object(
        'commitment_id', v_target_row.id,
        'work_date', v_target_row.work_date,
        'expected_minutes', v_target_row.expected_minutes,
        'payroll_ready_minutes', 0,
        'covered_minutes', 0,
        'remaining_minutes', v_target_row.expected_minutes,
        'carryover_minutes', 0,
        'payable_minutes', 0,
        'already_paid_minutes', 0,
        'day_type', v_target_row.prepaid_day_type,
        'commitment_version', v_target_row.commitment_version,
        'attendance_sources', '[]'::jsonb,
        'source_attendance_ids', '[]'::jsonb
      ));
      if v_day between p_start_date and p_end_date then
        v_current_target_minutes := v_current_target_minutes + v_target_row.expected_minutes;
        v_day_target_minutes := v_day_target_minutes + v_target_row.expected_minutes;
      end if;
    end loop;

    select coalesce(sum(greatest((target.value ->> 'remaining_minutes')::integer, 0)), 0)::integer
    into v_day_carryover
    from jsonb_array_elements(v_queue) target(value)
    where (target.value ->> 'work_date')::date < v_day;
    v_day_expected_minutes := v_day_carryover + v_day_target_minutes;

    -- Process approved, payroll-ready attendance records individually so each
    -- attendance ID and each eligible minute can be allocated at most once.
    for v_attendance in
      select readiness.id, readiness.work_date,
        case
          when public.payroll_expected_commitment_day_type(p_employee_user_id, readiness.work_date) = 'rest_day'
            then greatest(coalesce(readiness.rest_day_overtime_minutes, 0), 0)
          else greatest(coalesce(readiness.regular_minutes, 0), 0)
        end::integer as eligible_minutes
      from public.workforce_attendance_payroll_readiness readiness
      where readiness.user_id = p_employee_user_id
        and readiness.work_date = v_day
        and readiness.is_payroll_ready
        and readiness.review_status in ('approved', 'locked')
      order by readiness.id
    loop
      v_attendance_minutes := greatest(coalesce(v_attendance.eligible_minutes, 0), 0);
      v_day_ready := v_day_ready + v_attendance_minutes;
      v_queue_length := jsonb_array_length(v_queue);

      if v_attendance_minutes > 0 and v_queue_length > 0 then
        for v_index in 0..v_queue_length - 1 loop
          exit when v_attendance_minutes <= 0;
          v_target := v_queue -> v_index;
          if (v_target ->> 'work_date')::date > v_day then
            continue;
          end if;
          v_target_remaining := greatest(coalesce((v_target ->> 'remaining_minutes')::integer, 0), 0);
          if v_target_remaining <= 0 then
            continue;
          end if;

          v_apply := least(v_target_remaining, v_attendance_minutes);
          v_target := jsonb_set(v_target, '{remaining_minutes}', to_jsonb(v_target_remaining - v_apply), true);
          v_target := jsonb_set(v_target, '{covered_minutes}', to_jsonb(
            coalesce((v_target ->> 'covered_minutes')::integer, 0) + v_apply
          ), true);
          v_target := jsonb_set(v_target, '{payroll_ready_minutes}', to_jsonb(
            coalesce((v_target ->> 'payroll_ready_minutes')::integer, 0) + v_apply
          ), true);
          v_target := jsonb_set(v_target, '{attendance_sources}',
            coalesce(v_target -> 'attendance_sources', '[]'::jsonb)
              || jsonb_build_array(jsonb_build_object(
                'attendance_id', v_attendance.id,
                'work_date', v_day,
                'minutes', v_apply
              )), true);
          if not coalesce(v_target -> 'source_attendance_ids', '[]'::jsonb) @> jsonb_build_array(v_attendance.id) then
            v_target := jsonb_set(v_target, '{source_attendance_ids}',
              coalesce(v_target -> 'source_attendance_ids', '[]'::jsonb)
                || jsonb_build_array(v_attendance.id), true);
          end if;
          v_queue := jsonb_set(v_queue, array[v_index::text], v_target, true);
          v_attendance_minutes := v_attendance_minutes - v_apply;
          v_day_used := v_day_used + v_apply;
        end loop;
      end if;
    end loop;

    if v_day between p_start_date and p_end_date then
      select coalesce(sum(greatest((target.value ->> 'remaining_minutes')::integer, 0)), 0)::integer
      into v_remaining_minutes
      from jsonb_array_elements(v_queue) target(value);

      select coalesce(jsonb_agg(jsonb_build_object(
        'commitment_id', target.value -> 'commitment_id',
        'work_date', target.value -> 'work_date',
        'expected_minutes', (target.value ->> 'expected_minutes')::integer,
        'credited_minutes', (target.value ->> 'covered_minutes')::integer,
        'remaining_minutes', (target.value ->> 'remaining_minutes')::integer,
        'source_attendance_ids', coalesce(target.value -> 'source_attendance_ids', '[]'::jsonb),
        'attendance_sources', coalesce(target.value -> 'attendance_sources', '[]'::jsonb),
        'day_type', target.value -> 'day_type',
        'commitment_version', target.value -> 'commitment_version'
      ) order by target.value ->> 'work_date'), '[]'::jsonb)
      into v_target
      from jsonb_array_elements(v_queue) target(value)
      where (target.value ->> 'work_date')::date = v_day;

      if v_day_expected_minutes = 0 then
        v_status := 'No commitment required';
      elsif v_remaining_minutes = 0 then
        v_status := 'Complete';
      elsif v_day_used = 0 then
        v_status := 'Outstanding';
      else
        v_status := 'Partially covered';
      end if;

      if v_day_used > 0 or jsonb_array_length(v_target) > 0 or v_remaining_minutes > 0 then
        v_days := v_days || jsonb_build_array(jsonb_build_object(
          'work_date', v_day,
          'target_minutes', v_day_target_minutes,
          'carryover_minutes', v_day_carryover,
          'expected_minutes', v_day_expected_minutes,
          'credited_minutes', v_day_used,
          'payroll_ready_minutes', v_day_used,
          'remaining_minutes', v_remaining_minutes,
          'status', case
            when v_day_expected_minutes = 0 then 'No commitment required'
            when v_remaining_minutes = 0 then 'Complete'
            when v_day_used = 0 then 'Outstanding'
            else 'Partially covered'
          end,
          'targets', v_target
        ));
      end if;
    end if;
  end loop;

  v_queue_length := jsonb_array_length(v_queue);
  if v_queue_length > 0 then
    for v_index in 0..v_queue_length - 1 loop
      v_target := v_queue -> v_index;
      select coalesce(sum(paid.paid_minutes), 0)::integer
      into v_paid_minutes
      from (
        select greatest(item.minutes, 0)::integer as paid_minutes
        from public.payroll_v2_committed_hours_snapshots snapshot
        join public.payroll_v2_records record on record.id = snapshot.payroll_v2_record_id
        join public.payroll_v2_items item
          on item.payroll_v2_record_id = record.id
         and item.item_type = 'committed_hours'
         and item.source_type = 'payroll_prepaid_commitments'
         and item.source_id = snapshot.commitment_source_id
        where snapshot.commitment_source_id = (v_target ->> 'commitment_id')::uuid
          and snapshot.employee_user_id = p_employee_user_id
          and record.status <> 'void'
        union all
        select greatest(round(item.quantity * 60), 0)::integer
        from public.payroll_items item
        join public.payroll_records record on record.id = item.payroll_record_id
        where item.metadata ->> 'commitment_id' = v_target ->> 'commitment_id'
          and item.quantity is not null
          and record.status <> 'void'
      ) paid;
      v_paid_minutes := greatest(coalesce(v_paid_minutes, 0), 0);
      v_target := jsonb_set(v_target, '{already_paid_minutes}', to_jsonb(v_paid_minutes), true);
      v_target := jsonb_set(v_target, '{payable_minutes}', to_jsonb(greatest(
        coalesce((v_target ->> 'remaining_minutes')::integer, 0) - v_paid_minutes, 0
      )), true);
      v_queue := jsonb_set(v_queue, array[v_index::text], v_target, true);

      if (v_target ->> 'work_date')::date between p_start_date and p_end_date then
        v_targets := v_targets || jsonb_build_array(v_target);
        v_payroll_targets := v_payroll_targets || jsonb_build_array(v_target);
      elsif coalesce((v_target ->> 'carryover_minutes')::integer, 0) > 0 then
        v_carryover_targets := v_carryover_targets || jsonb_build_array(v_target);
        v_payroll_targets := v_payroll_targets || jsonb_build_array(v_target);
      end if;
    end loop;
  end if;

  select coalesce(sum(greatest((target.value ->> 'remaining_minutes')::integer, 0)), 0)::integer
  into v_remaining_minutes
  from jsonb_array_elements(v_queue) target(value);
  v_expected_minutes := v_opening_carryover + v_current_target_minutes;
  v_credited_minutes := greatest(v_expected_minutes - v_remaining_minutes, 0);

  if v_expected_minutes = 0 then
    v_status := 'No commitment required';
  elsif v_remaining_minutes = 0 then
    v_status := 'Complete';
  elsif v_credited_minutes = 0 then
    v_status := 'Outstanding';
  else
    v_status := 'Partially covered';
  end if;

  return jsonb_build_object(
    'expected_minutes', v_expected_minutes,
    'target_minutes', v_current_target_minutes,
    'carryover_minutes', v_opening_carryover,
    'payroll_ready_minutes', v_credited_minutes,
    'covered_minutes', v_credited_minutes,
    'credited_minutes', v_credited_minutes,
    'remaining_minutes', v_remaining_minutes,
    'status', v_status,
    'targets', v_targets,
    'carryover_targets', v_carryover_targets,
    'payroll_targets', v_payroll_targets,
    'days', v_days
  );
end;
$function$;
revoke all on function public.payroll_get_expected_committed_hours_summary(uuid, date, date)
  from public, anon, authenticated;
comment on function public.payroll_get_expected_committed_hours_summary(uuid, date, date) is
  'Authoritative FIFO Committed Hours projection over active daily targets and approved payroll-ready attendance. Preserves original target dates, carryover, attendance evidence, and payroll-snapshot payable minutes.';
create or replace function public.workforce_get_attendance_committed_hours_summary(
  p_employee_user_id uuid,
  p_start_date date,
  p_end_date date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_profile_id uuid := public.workforce_current_profile_id();
  v_source jsonb;
  v_days jsonb;
begin
  if auth.uid() is null or v_profile_id is null or not public.workforce_current_user_is_active() then
    raise exception using errcode = '42501', message = 'Authentication and an active workforce profile are required.';
  end if;
  if p_employee_user_id is null or p_start_date is null or p_end_date is null then
    raise exception using errcode = '22004', message = 'Employee and date range are required.';
  end if;
  if p_end_date < p_start_date then
    raise exception using errcode = '22007', message = 'End date cannot be earlier than start date.';
  end if;
  if p_end_date - p_start_date > 366 then
    raise exception using errcode = '22023', message = 'Attendance date ranges cannot exceed 367 calendar days.';
  end if;
  if p_employee_user_id not in (auth.uid(), v_profile_id)
     and not public.workforce_is_authorized_attendance_admin('correct_attendance') then
    raise exception using errcode = '42501', message = 'You do not have permission to view this employee’s Committed Hours.';
  end if;
  if not exists (
    select 1 from public.profiles profile
    where profile.user_id = p_employee_user_id
      and profile.is_agent is true
      and profile.employment_status::text in ('active', 'on_leave')
  ) then
    raise exception using errcode = 'P0002', message = 'Active workforce employee was not found.';
  end if;

  v_source := public.payroll_get_expected_committed_hours_summary(p_employee_user_id, p_start_date, p_end_date);
  select coalesce(jsonb_agg(jsonb_build_object(
    'work_date', day.value -> 'work_date',
    'target_minutes', (day.value ->> 'target_minutes')::integer,
    'expected_minutes', (day.value ->> 'target_minutes')::integer
      + (day.value ->> 'carryover_minutes')::integer,
    'carryover_minutes', (day.value ->> 'carryover_minutes')::integer,
    'credited_minutes', (day.value ->> 'credited_minutes')::integer,
    'remaining_minutes', (day.value ->> 'remaining_minutes')::integer,
    'status', day.value -> 'status',
    'targets', coalesce(day.value -> 'targets', '[]'::jsonb)
  ) order by day.value ->> 'work_date'), '[]'::jsonb)
  into v_days
  from jsonb_array_elements(coalesce(v_source -> 'days', '[]'::jsonb)) day(value);

  return jsonb_build_object(
    'expected_minutes', coalesce((v_source ->> 'expected_minutes')::integer, 0),
    'target_minutes', coalesce((v_source ->> 'target_minutes')::integer, 0),
    'carryover_minutes', coalesce((v_source ->> 'carryover_minutes')::integer, 0),
    'credited_minutes', coalesce((v_source ->> 'credited_minutes')::integer, 0),
    'remaining_minutes', coalesce((v_source ->> 'remaining_minutes')::integer, 0),
    'status', case
      when coalesce((v_source ->> 'expected_minutes')::integer, 0) = 0 then 'No commitment required'
      when coalesce((v_source ->> 'remaining_minutes')::integer, 0) = 0 then 'Complete'
      else 'Remaining'
    end,
    'targets', v_days,
    'carryover_targets', coalesce(v_source -> 'carryover_targets', '[]'::jsonb)
  );
end;
$function$;
revoke all on function public.workforce_get_attendance_committed_hours_summary(uuid, date, date)
  from public, anon, authenticated;
grant execute on function public.workforce_get_attendance_committed_hours_summary(uuid, date, date)
  to authenticated, service_role;
create or replace function public.workforce_list_team_committed_hours(
  p_start_date date,
  p_end_date date
)
returns table (
  employee_user_id uuid,
  employee_name text,
  team_id uuid,
  team_name text,
  expected_minutes integer,
  credited_minutes integer,
  remaining_minutes integer,
  commitment_status text,
  targets jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if auth.uid() is null
     or public.workforce_current_profile_id() is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_has_permission('view_team_attendance') then
    raise exception using errcode = '42501', message = 'You do not have permission to view team Committed Hours.';
  end if;
  if p_start_date is null or p_end_date is null then
    raise exception using errcode = '22004', message = 'Start date and end date are required.';
  end if;
  if p_end_date < p_start_date then
    raise exception using errcode = '22007', message = 'End date cannot be earlier than start date.';
  end if;
  if p_end_date - p_start_date > 366 then
    raise exception using errcode = '22023', message = 'Team attendance date ranges cannot exceed 367 calendar days.';
  end if;

  return query
  select profile.user_id,
    coalesce(nullif(btrim(profile.full_name), ''), profile.email),
    profile.team_id,
    employee_team.name,
    coalesce((summary.value ->> 'expected_minutes')::integer, 0),
    coalesce((summary.value ->> 'credited_minutes')::integer, 0),
    coalesce((summary.value ->> 'remaining_minutes')::integer, 0),
    coalesce(summary.value ->> 'status', 'No commitment required'),
    day_rows.value
  from public.profiles profile
  left join public.teams employee_team on employee_team.id = profile.team_id
  cross join lateral (select public.payroll_get_expected_committed_hours_summary(
    profile.user_id, p_start_date, p_end_date
  ) as value) summary
  cross join lateral (
    select coalesce(jsonb_agg(jsonb_build_object(
      'work_date', day.value -> 'work_date',
      'target_minutes', (day.value ->> 'target_minutes')::integer,
      'expected_minutes', (day.value ->> 'expected_minutes')::integer,
      'carryover_minutes', (day.value ->> 'carryover_minutes')::integer,
      'credited_minutes', (day.value ->> 'credited_minutes')::integer,
      'remaining_minutes', (day.value ->> 'remaining_minutes')::integer,
      'status', day.value -> 'status',
      'targets', coalesce(day.value -> 'targets', '[]'::jsonb)
    ) order by day.value ->> 'work_date'), '[]'::jsonb) as value
    from jsonb_array_elements(coalesce(summary.value -> 'days', '[]'::jsonb)) day(value)
  ) day_rows
  where profile.is_agent is true
    and profile.employment_status::text in ('active', 'on_leave')
    and public.workforce_can_manage_user(profile.user_id, 'view_team_attendance')
  order by coalesce(nullif(btrim(profile.full_name), ''), profile.email), profile.user_id;
end;
$function$;
revoke all on function public.workforce_list_team_committed_hours(date, date)
  from public, anon, authenticated;
grant execute on function public.workforce_list_team_committed_hours(date, date)
  to authenticated, service_role;
create or replace function public.workforce_admin_list_committed_hours(
  p_start_date date,
  p_end_date date,
  p_employee_user_id uuid default null,
  p_team_id uuid default null
)
returns table (
  employee_user_id uuid,
  employee_name text,
  team_id uuid,
  team_name text,
  commitment_id uuid,
  work_date date,
  target_minutes integer,
  fulfilled_minutes integer,
  carryover_minutes integer,
  remaining_minutes integer,
  status text,
  reason text,
  editable boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if auth.uid() is null or public.workforce_current_profile_id() is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_has_permission('manage_employees') then
    raise exception using errcode = '42501', message = 'You do not have permission to manage Committed Hours.';
  end if;
  if p_start_date is null or p_end_date is null then
    raise exception using errcode = '22004', message = 'Start date and end date are required.';
  end if;
  if p_end_date < p_start_date then
    raise exception using errcode = '22007', message = 'End date cannot be earlier than start date.';
  end if;
  if p_end_date - p_start_date > 366 then
    raise exception using errcode = '22023', message = 'Committed Hours date ranges cannot exceed 367 calendar days.';
  end if;

  return query
  select profile.user_id,
    coalesce(nullif(btrim(profile.full_name), ''), profile.email),
    profile.team_id,
    employee_team.name,
    (target.value ->> 'commitment_id')::uuid,
    (target.value ->> 'work_date')::date,
    (target.value ->> 'expected_minutes')::integer,
    (target.value ->> 'covered_minutes')::integer,
    coalesce((target.value ->> 'carryover_minutes')::integer, 0),
    (target.value ->> 'remaining_minutes')::integer,
    case when (target.value ->> 'remaining_minutes')::integer = 0 then 'Complete'
         when (target.value ->> 'covered_minutes')::integer = 0 then 'Outstanding'
         else 'Partially covered' end,
    commitment.reason,
    not exists (
      select 1
      from public.payroll_v2_committed_hours_snapshots snapshot
      join public.payroll_v2_records record on record.id = snapshot.payroll_v2_record_id
      where snapshot.commitment_source_id = commitment.id
        and record.status <> 'void'
    ) and not exists (
      select 1 from public.payroll_items item
      join public.payroll_records record on record.id = item.payroll_record_id
      where item.metadata ->> 'commitment_id' = commitment.id::text
        and record.status <> 'void'
    )
  from public.profiles profile
  left join public.teams employee_team on employee_team.id = profile.team_id
  cross join lateral (select public.payroll_get_expected_committed_hours_summary(
    profile.user_id, p_start_date, p_end_date
  ) as value) summary
  cross join lateral jsonb_array_elements(coalesce(summary.value -> 'payroll_targets', '[]'::jsonb)) target(value)
  join public.payroll_prepaid_commitments commitment
    on commitment.id = (target.value ->> 'commitment_id')::uuid
   and commitment.superseded_at is null
  where profile.is_agent is true
    and profile.employment_status::text in ('active', 'on_leave')
    and (p_employee_user_id is null or profile.user_id = p_employee_user_id)
    and (p_team_id is null or profile.team_id = p_team_id)
    and public.workforce_can_manage_user(profile.user_id, 'manage_employees')
  order by (target.value ->> 'work_date')::date,
    coalesce(nullif(btrim(profile.full_name), ''), profile.email), profile.user_id;
end;
$function$;
revoke all on function public.workforce_admin_list_committed_hours(date, date, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.workforce_admin_list_committed_hours(date, date, uuid, uuid)
  to authenticated, service_role;
create or replace function public.workforce_admin_save_committed_hours(
  p_commitment_id uuid,
  p_employee_user_id uuid,
  p_work_date date,
  p_expected_minutes integer,
  p_reason text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := public.workforce_current_profile_id();
  v_current public.payroll_prepaid_commitments%rowtype;
  v_existing public.payroll_prepaid_commitments%rowtype;
  v_new_id uuid;
  v_reason text := coalesce(nullif(btrim(p_reason), ''), 'Committed Hours target maintained in Workforce Management');
  v_day_type text;
begin
  if auth.uid() is null or v_actor is null or not public.workforce_current_user_is_active()
     or not public.workforce_has_permission('manage_employees') then
    raise exception using errcode = '42501', message = 'You do not have permission to manage Committed Hours.';
  end if;
  if p_employee_user_id is null or p_work_date is null then
    raise exception using errcode = '22004', message = 'Employee and work date are required.';
  end if;
  if p_expected_minutes is null or p_expected_minutes < 1 or p_expected_minutes > 1440 then
    raise exception using errcode = '22023', message = 'Target hours must be greater than zero and at most 24 hours.';
  end if;
  if not public.workforce_can_manage_user(p_employee_user_id, 'manage_employees')
     or not exists (
       select 1 from public.profiles profile
       where profile.user_id = p_employee_user_id
         and profile.is_agent is true
         and profile.employment_status::text in ('active', 'on_leave')
     ) then
    raise exception using errcode = '42501', message = 'You cannot manage Committed Hours for this employee.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_employee_user_id::text || ':' || p_work_date::text, 0)
  );

  select commitment.* into v_existing
  from public.payroll_prepaid_commitments commitment
  where commitment.employee_id = p_employee_user_id
    and commitment.work_date = p_work_date
    and commitment.superseded_at is null
  for update;

  if p_commitment_id is null then
    if found then
      raise exception using errcode = '23505', message = 'An active target already exists for this employee and date.';
    end if;
  else
    if not found or v_existing.id <> p_commitment_id then
      raise exception using errcode = '55000', message = 'The Committed Hours target changed. Refresh and try again.';
    end if;
    if exists (
      select 1 from public.payroll_v2_committed_hours_snapshots snapshot
      join public.payroll_v2_records record on record.id = snapshot.payroll_v2_record_id
      where snapshot.commitment_source_id = v_existing.id
        and record.status <> 'void'
    ) then
      raise exception using errcode = '55000',
        message = 'This target is already represented in Payroll V2 and can no longer be edited.';
    end if;
    if exists (
      select 1 from public.payroll_items item
      join public.payroll_records record on record.id = item.payroll_record_id
      where item.metadata ->> 'commitment_id' = v_existing.id::text
        and record.status <> 'void'
    ) or (v_existing.payroll_record_id is not null and exists (
      select 1 from public.payroll_records record
      where record.id = v_existing.payroll_record_id and record.status = 'finalized'
    )) then
      raise exception using errcode = '55000',
        message = 'This target is already represented in finalized Payroll V1 and can no longer be edited.';
    end if;
  end if;

  if p_commitment_id is not null then
    update public.payroll_prepaid_commitments
    set superseded_at = statement_timestamp(), superseded_by = v_actor
    where id = v_existing.id and superseded_at is null;
    if not found then
      raise exception using errcode = '40001', message = 'The Committed Hours target changed. Refresh and try again.';
    end if;
  end if;

  v_day_type := public.payroll_expected_commitment_day_type(p_employee_user_id, p_work_date);
  if v_day_type = 'holiday' then
    raise exception using errcode = '22023', message = 'Holiday dates remain blocked for Committed Hours.';
  end if;
  if v_day_type not in ('ordinary', 'rest_day') then
    raise exception using errcode = '22023', message = 'The selected work date cannot have a Committed Hours target.';
  end if;

  insert into public.payroll_prepaid_commitments (
    payroll_period_id, payroll_record_id, employee_id, work_date, expected_minutes,
    payroll_ready_minutes_at_creation, coverage_minutes, replacement_coverage_minutes,
    prepaid_day_type, approval_evidence, created_by, reason, commitment_version,
    root_commitment_id, supersedes_commitment_id
  ) values (
    null, null, p_employee_user_id, p_work_date, p_expected_minutes,
    0, p_expected_minutes, p_expected_minutes,
    v_day_type, '[]'::jsonb, v_actor, v_reason,
    case when p_commitment_id is null then 1 else v_existing.commitment_version + 1 end,
    case when p_commitment_id is null then null else coalesce(v_existing.root_commitment_id, v_existing.id) end,
    p_commitment_id
  ) returning id into v_new_id;

  return v_new_id;
end;
$function$;
revoke all on function public.workforce_admin_save_committed_hours(uuid, uuid, date, integer, text)
  from public, anon, authenticated;
grant execute on function public.workforce_admin_save_committed_hours(uuid, uuid, date, integer, text)
  to authenticated, service_role;
-- Payroll V2's existing read-model and calculator consume the shared FIFO
-- projection. Pay only the still-outstanding target amount not already included
-- in a non-void payroll record; do not change V2 status or finalization procedures.
do $patch$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  v_definition := replace(
    pg_catalog.pg_get_functiondef(
      'public.payroll_v2_employee_calculation_payload(uuid, uuid)'::regprocedure
    ), chr(13), ''
  );

  v_old := 'v_targets := coalesce(v_committed_hours -> ''targets'', ''[]''::jsonb);';
  v_new := 'v_targets := coalesce(v_committed_hours -> ''payroll_targets'', '
    || 'v_committed_hours -> ''targets'', ''[]''::jsonb);';
  if strpos(v_definition, v_old) = 0 then
    raise exception 'Payroll V2 Committed Hours target source was not found.';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := 'where coalesce((target ->> ''remaining_minutes'')::integer, 0) > 0';
  v_new := 'where coalesce((target ->> ''payable_minutes'')::integer, 0) > 0';
  if strpos(v_definition, v_old) = 0 then
    raise exception 'Payroll V2 Committed Hours effective-rate source was not found.';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := 'coalesce(sum((target ->> ''remaining_minutes'')::integer), 0)::integer as committed_minutes,';
  v_new := 'coalesce(sum((target ->> ''payable_minutes'')::integer), 0)::integer as committed_minutes,';
  if strpos(v_definition, v_old) = 0 then
    raise exception 'Payroll V2 Committed Hours pricing source was not found.';
  end if;
  v_definition := replace(v_definition, v_old, v_new);
  execute v_definition;
end;
$patch$;
do $patch$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  v_definition := replace(
    pg_catalog.pg_get_functiondef(
      'public.payroll_v2_calculate_employee(uuid, uuid)'::regprocedure
    ), chr(13), ''
  );
  v_old := 'if coalesce((v_target ->> ''remaining_minutes'')::integer, 0) > 0 then';
  v_new := 'if coalesce((v_target ->> ''payable_minutes'')::integer, 0) > 0 then';
  if strpos(v_definition, v_old) = 0 then
    raise exception 'Payroll V2 Committed Hours payable guard was not found.';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $old$
          'Committed Hours — ' || (v_target ->> 'work_date'),
          (v_target ->> 'work_date')::date,
          'payroll_prepaid_commitments',
          v_source_id,
          (v_target ->> 'remaining_minutes')::integer,
$old$;
  v_new := $new$
          'Committed Hours — ' || (v_target ->> 'work_date'),
          (v_target ->> 'work_date')::date,
          'payroll_prepaid_commitments',
          v_source_id,
          (v_target ->> 'payable_minutes')::integer,
$new$;
  if strpos(v_definition, v_old) = 0 then
    raise exception 'Payroll V2 Committed Hours item payout source was not found.';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := '''remaining_minutes'', v_target -> ''remaining_minutes'',';
  v_new := '''remaining_minutes'', v_target -> ''remaining_minutes'', '
    || '''payable_committed_minutes'', v_target -> ''payable_minutes'', '
    || '''already_paid_minutes'', v_target -> ''already_paid_minutes'', '
    || '''source_attendance_ids'', v_target -> ''source_attendance_ids'',';
  if strpos(v_definition, v_old) = 0 then
    raise exception 'Payroll V2 Committed Hours snapshot metadata marker was not found.';
  end if;
  v_definition := replace(v_definition, v_old, v_new);
  execute v_definition;
end;
$patch$;
commit;
