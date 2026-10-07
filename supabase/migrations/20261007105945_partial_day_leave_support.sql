begin;

alter table public.leave_requests
  add column if not exists leave_duration text not null default 'whole_day',
  add column if not exists leave_half text,
  add column if not exists requested_schedule_id uuid,
  add column if not exists requested_schedule_start timestamptz,
  add column if not exists requested_schedule_end timestamptz,
  add column if not exists requested_schedule_timezone text,
  add column if not exists requested_leave_start timestamptz,
  add column if not exists requested_leave_end timestamptz,
  add column if not exists requested_leave_minutes integer;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'leave_requests_requested_schedule_id_fkey'
      and conrelid = 'public.leave_requests'::regclass
  ) then
    alter table public.leave_requests
      add constraint leave_requests_requested_schedule_id_fkey
      foreign key (requested_schedule_id)
      references public.work_schedules(id)
      on delete restrict;
  end if;
end;
$$;

alter table public.leave_requests
  drop constraint if exists leave_requests_duration_shape_check;

alter table public.leave_requests
  add constraint leave_requests_duration_shape_check check (
    (
      request_category = 'schedule_change'
      and leave_duration = 'whole_day'
      and leave_half is null
      and requested_schedule_id is null
      and requested_schedule_start is null
      and requested_schedule_end is null
      and requested_schedule_timezone is null
      and requested_leave_start is null
      and requested_leave_end is null
      and requested_leave_minutes is null
    )
    or
    (
      coalesce(request_category, 'leave') = 'leave'
      and (
        (
          leave_duration = 'whole_day'
          and leave_half is null
          and requested_schedule_id is null
          and requested_schedule_start is null
          and requested_schedule_end is null
          and requested_schedule_timezone is null
          and requested_leave_start is null
          and requested_leave_end is null
          and requested_leave_minutes is null
        )
        or
        (
          leave_duration in ('half_day', 'specific_time')
          and (
            (leave_duration = 'half_day' and leave_half in ('first', 'second'))
            or (leave_duration = 'specific_time' and leave_half is null)
          )
          and start_date = end_date
          and requested_schedule_id is not null
          and requested_schedule_start is not null
          and requested_schedule_end > requested_schedule_start
          and requested_schedule_end - requested_schedule_start <= interval '24 hours'
          and nullif(trim(requested_schedule_timezone), '') is not null
          and requested_leave_start is not null
          and requested_leave_end > requested_leave_start
          and requested_leave_start >= requested_schedule_start
          and requested_leave_end <= requested_schedule_end
          and requested_leave_minutes =
            floor(extract(epoch from (requested_leave_end - requested_leave_start)) / 60)::integer
          and requested_leave_minutes > 0
        )
      )
    )
  );

create index if not exists leave_requests_requested_schedule_id_idx
  on public.leave_requests (requested_schedule_id)
  where requested_schedule_id is not null;

comment on column public.leave_requests.leave_duration is
  'Authoritative leave duration: whole_day, half_day, or specific_time. Existing requests default to whole_day.';
comment on column public.leave_requests.leave_half is
  'For half_day requests, records whether the requested segment is first or second half of the scheduled shift.';
comment on column public.leave_requests.requested_schedule_id is
  'Timed source schedule used to derive and validate a partial-day leave interval.';
comment on column public.leave_requests.requested_schedule_start is
  'Source shift start snapshot used to audit and revalidate a partial-day leave request.';
comment on column public.leave_requests.requested_schedule_end is
  'Source shift end snapshot used to audit and revalidate a partial-day leave request.';
comment on column public.leave_requests.requested_schedule_timezone is
  'Source shift timezone used to anchor the partial leave interval to its work date.';
comment on column public.leave_requests.requested_leave_start is
  'Absolute start timestamp of the requested partial leave interval.';
comment on column public.leave_requests.requested_leave_end is
  'Absolute end timestamp of the requested partial leave interval.';
comment on column public.leave_requests.requested_leave_minutes is
  'Exact whole-minute duration of the requested partial leave interval.';

create or replace function public.workforce_submit_partial_leave_request(
  p_leave_type text,
  p_work_date date,
  p_leave_duration text,
  p_leave_half text,
  p_from_time time,
  p_to_time time,
  p_reason text
)
returns public.leave_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := public.workforce_current_profile_id();
  v_leave_type text := lower(trim(coalesce(p_leave_type, '')));
  v_duration text := lower(trim(coalesce(p_leave_duration, '')));
  v_half text := lower(trim(coalesce(p_leave_half, '')));
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_schedule public.work_schedules%rowtype;
  v_schedule_count integer := 0;
  v_timezone text;
  v_shift_start_local timestamp without time zone;
  v_leave_start_local timestamp without time zone;
  v_leave_end_local timestamp without time zone;
  v_leave_start timestamptz;
  v_leave_end timestamptz;
  v_schedule_minutes integer;
  v_leave_minutes integer;
  v_midpoint timestamptz;
  v_result public.leave_requests%rowtype;
begin
  if auth.uid() is null
     or v_user_id is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_current_user_is_agent() then
    raise exception 'Authentication and an active workforce agent profile are required.';
  end if;

  if v_leave_type not in (
    'incentive_vl', 'birthday_vl', 'leave_without_pay'
  ) then
    raise exception 'Select a valid leave type.';
  end if;

  if p_work_date is null then
    raise exception 'A work date is required for partial-day leave.';
  end if;

  if v_duration not in ('half_day', 'specific_time') then
    raise exception 'Select Half Day or Specific Time for this request.';
  end if;

  if v_duration = 'half_day' then
    if v_half not in ('first', 'second')
       or p_from_time is not null
       or p_to_time is not null then
      raise exception 'Select First Half or Second Half.';
    end if;
  elsif v_half <> ''
     or p_from_time is null
     or p_to_time is null then
    raise exception 'Specific Time requires From and To times.';
  end if;

  if v_reason is null then
    raise exception 'Explain the reason for this leave request.';
  end if;

  if length(v_reason) > 1000 then
    raise exception 'The request reason cannot exceed 1000 characters.';
  end if;

  select count(*)::integer
  into v_schedule_count
  from public.work_schedules schedule
  where schedule.user_id = v_user_id
    and schedule.shift_date = p_work_date
    and schedule.status in ('published', 'changed');

  if v_schedule_count <> 1 then
    raise exception 'Partial-day leave requires exactly one published timed work schedule on this date.';
  end if;

  select *
  into v_schedule
  from public.work_schedules schedule
  where schedule.user_id = v_user_id
    and schedule.shift_date = p_work_date
    and schedule.status in ('published', 'changed')
  for update;

  if not found then
    raise exception 'No published timed work schedule exists for this date.';
  end if;

  if v_schedule.is_rest_day
     or v_schedule.is_holiday
     or v_schedule.is_leave
     or v_schedule.is_absent
     or v_schedule.shift_start is null
     or v_schedule.shift_end is null then
    raise exception 'Half Day and Specific Time require a timed work schedule; Open Schedule, Rest Day, and other non-working schedules do not have a leave interval.';
  end if;

  v_timezone := coalesce(nullif(trim(v_schedule.timezone), ''), 'America/New_York');

  begin
    perform (p_work_date::timestamp at time zone v_timezone);
  exception
    when invalid_parameter_value then
      raise exception 'The selected schedule has an unsupported timezone.';
  end;

  if v_schedule.shift_end <= v_schedule.shift_start
     or v_schedule.shift_end - v_schedule.shift_start > interval '24 hours' then
    raise exception 'The selected schedule does not have a valid timed work period.';
  end if;

  v_shift_start_local := v_schedule.shift_start at time zone v_timezone;
  if v_shift_start_local::date <> p_work_date then
    raise exception 'The selected schedule start does not match its work date.';
  end if;

  v_schedule_minutes :=
    floor(extract(epoch from (v_schedule.shift_end - v_schedule.shift_start)) / 60)::integer;

  if v_schedule_minutes < 2 then
    raise exception 'The selected schedule is too short to split into a partial-day interval.';
  end if;

  if v_duration = 'half_day' then
    v_midpoint :=
      v_schedule.shift_start + make_interval(mins => v_schedule_minutes / 2);

    if v_half = 'first' then
      v_leave_start := v_schedule.shift_start;
      v_leave_end := v_midpoint;
    else
      v_leave_start := v_midpoint;
      v_leave_end := v_schedule.shift_end;
    end if;
  else
    v_leave_start_local := p_work_date + p_from_time;
    v_leave_end_local := p_work_date + p_to_time;

    -- A selected clock time earlier than the shift's local start belongs to
    -- the next calendar date of an overnight work period.
    if p_from_time < v_shift_start_local::time then
      v_leave_start_local := v_leave_start_local + interval '1 day';
    end if;
    if p_to_time < v_shift_start_local::time then
      v_leave_end_local := v_leave_end_local + interval '1 day';
    end if;

    v_leave_start := v_leave_start_local at time zone v_timezone;
    v_leave_end := v_leave_end_local at time zone v_timezone;

    if (v_leave_start at time zone v_timezone) is distinct from v_leave_start_local
       or (v_leave_end at time zone v_timezone) is distinct from v_leave_end_local then
      raise exception 'The selected time does not exist in the schedule timezone.';
    end if;

    if v_leave_end <= v_leave_start then
      raise exception 'Requested leave end must be later than its start.';
    end if;

    if v_leave_start < v_schedule.shift_start
       or v_leave_end > v_schedule.shift_end then
      raise exception 'The requested leave interval must fit within the scheduled shift.';
    end if;
  end if;

  v_leave_minutes :=
    floor(extract(epoch from (v_leave_end - v_leave_start)) / 60)::integer;

  if v_leave_minutes <= 0 then
    raise exception 'The requested leave interval must be at least one minute.';
  end if;

  if exists (
    select 1
    from public.leave_requests request
    where request.user_id = v_user_id
      and request.status in ('pending', 'approved')
      and daterange(request.start_date, request.end_date, '[]')
        && daterange(p_work_date, p_work_date, '[]')
  ) then
    raise exception 'A pending or approved leave request already overlaps this date.';
  end if;

  insert into public.leave_requests (
    user_id,
    leave_type,
    start_date,
    end_date,
    reason,
    status,
    request_category,
    request_type,
    leave_duration,
    leave_half,
    requested_schedule_id,
    requested_schedule_start,
    requested_schedule_end,
    requested_schedule_timezone,
    requested_leave_start,
    requested_leave_end,
    requested_leave_minutes
  ) values (
    v_user_id,
    v_leave_type,
    p_work_date,
    p_work_date,
    v_reason,
    'pending',
    'leave',
    v_leave_type,
    v_duration,
    case when v_duration = 'half_day' then v_half else null end,
    v_schedule.id,
    v_schedule.shift_start,
    v_schedule.shift_end,
    v_timezone,
    v_leave_start,
    v_leave_end,
    v_leave_minutes
  )
  returning * into v_result;

  return v_result;
end;
$$;

revoke all on function public.workforce_submit_partial_leave_request(
  text, date, text, text, time, time, text
) from public, anon, authenticated;
grant execute on function public.workforce_submit_partial_leave_request(
  text, date, text, text, time, time, text
) to authenticated, service_role;

comment on function public.workforce_submit_partial_leave_request(
  text, date, text, text, time, time, text
) is
  'Submits a Half Day or Specific Time leave request after deriving and validating its interval against one published timed work schedule.';

create or replace function public.workforce_validate_partial_leave_approval()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_schedule public.work_schedules%rowtype;
  v_schedule_count integer := 0;
  v_schedule_minutes integer;
  v_midpoint timestamptz;
  v_expected_start timestamptz;
  v_expected_end timestamptz;
begin
  if coalesce(new.request_category, 'leave') <> 'leave'
     or new.leave_duration = 'whole_day'
     or new.status <> 'approved'
     or old.status = 'approved' then
    return new;
  end if;

  if exists (
    select 1
    from public.payroll_periods period
    left join public.payroll_records record
      on record.payroll_period_id = period.id
     and record.employee_id = new.user_id
    where new.start_date between period.period_start and period.period_end
      and (period.status = 'finalized' or record.status = 'finalized')
  ) then
    raise exception 'The payroll period is finalized. Partial-day leave can no longer be approved for this date.';
  end if;

  select count(*)::integer
  into v_schedule_count
  from public.work_schedules schedule
  where schedule.user_id = new.user_id
    and schedule.shift_date = new.start_date
    and schedule.status in ('published', 'changed');

  if v_schedule_count <> 1 then
    raise exception 'The source schedule changed; update or resubmit this partial-day leave request.';
  end if;

  select *
  into v_schedule
  from public.work_schedules schedule
  where schedule.id = new.requested_schedule_id
    and schedule.user_id = new.user_id
    and schedule.shift_date = new.start_date
  for update;

  if not found
     or v_schedule.status not in ('published', 'changed')
     or v_schedule.is_rest_day
     or v_schedule.is_holiday
     or v_schedule.is_leave
     or v_schedule.is_absent
     or v_schedule.shift_start is null
     or v_schedule.shift_end is null
     or v_schedule.shift_start is distinct from new.requested_schedule_start
     or v_schedule.shift_end is distinct from new.requested_schedule_end
     or coalesce(nullif(trim(v_schedule.timezone), ''), 'America/New_York')
       is distinct from new.requested_schedule_timezone then
    raise exception 'The source schedule changed; update or resubmit this partial-day leave request.';
  end if;

  if v_schedule.shift_end <= v_schedule.shift_start
     or v_schedule.shift_end - v_schedule.shift_start > interval '24 hours'
     or new.requested_leave_start < v_schedule.shift_start
     or new.requested_leave_end > v_schedule.shift_end then
    raise exception 'The requested leave interval no longer fits within the scheduled shift.';
  end if;

  if new.leave_duration = 'half_day' then
    v_schedule_minutes :=
      floor(extract(epoch from (v_schedule.shift_end - v_schedule.shift_start)) / 60)::integer;
    v_midpoint :=
      v_schedule.shift_start + make_interval(mins => v_schedule_minutes / 2);

    if new.leave_half = 'first' then
      v_expected_start := v_schedule.shift_start;
      v_expected_end := v_midpoint;
    else
      v_expected_start := v_midpoint;
      v_expected_end := v_schedule.shift_end;
    end if;

    if new.requested_leave_start is distinct from v_expected_start
       or new.requested_leave_end is distinct from v_expected_end then
      raise exception 'The source schedule changed; update or resubmit this partial-day leave request.';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.workforce_validate_partial_leave_approval()
  from public, anon, authenticated;

drop trigger if exists leave_requests_validate_partial_leave_approval
  on public.leave_requests;
create trigger leave_requests_validate_partial_leave_approval
before update of status on public.leave_requests
for each row execute function public.workforce_validate_partial_leave_approval();

create or replace function public.payroll_apply_paid_leave_earnings()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_leave record;
  v_rate record;
  v_minutes integer;
  v_amount numeric(14,2);
begin
  if new.calculated_at is null or new.status = 'void' then
    return new;
  end if;

  delete from public.payroll_items item
  where item.payroll_record_id = new.id
    and not item.is_manual
    and item.item_code = 'paid_leave_earnings';

  update public.payroll_records
  set paid_leave_minutes = 0,
      paid_leave_pay = 0
  where id = new.id;

  for v_leave in
    select distinct on (schedule.shift_date)
      schedule.shift_date,
      schedule.id,
      schedule.leave_type,
      schedule.leave_request_id,
      request.leave_duration,
      request.requested_leave_minutes
    from public.work_schedules schedule
    left join public.leave_requests request
      on request.id = schedule.leave_request_id
    where schedule.user_id = new.employee_id
      and schedule.status in ('published', 'changed', 'completed')
      and schedule.is_leave
      and public.workforce_is_paid_leave_type(schedule.leave_type)
      and schedule.shift_date between
        (select period_start from public.payroll_periods where id = new.payroll_period_id)
        and (select period_end from public.payroll_periods where id = new.payroll_period_id)
    order by schedule.shift_date, schedule.updated_at desc, schedule.id
  loop
    -- Whole-day paid leave retains its configured 480-minute entitlement.
    -- Partial leave uses the exact schedule interval stored on the request.
    if v_leave.leave_duration in ('half_day', 'specific_time') then
      v_minutes := coalesce(v_leave.requested_leave_minutes, 0);
    else
      v_minutes := 480;
    end if;

    if v_minutes <= 0 then
      continue;
    end if;

    select rate.*
    into v_rate
    from public.agent_rates rate
    where rate.employee_id = new.employee_id
      and rate.effective_date <= v_leave.shift_date
    order by rate.effective_date desc
    limit 1;

    if not found then
      continue;
    end if;

    v_amount := round(v_minutes::numeric / 60 * v_rate.hourly_rate, 2);

    insert into public.payroll_items (
      payroll_record_id,
      item_type,
      item_code,
      description,
      quantity,
      unit_rate,
      amount,
      rate_id,
      work_date,
      source_schedule_id,
      calculation_version,
      metadata,
      created_by
    ) values (
      new.id,
      'earning',
      'paid_leave_earnings',
      'Approved paid leave — worked hours are additional',
      v_minutes::numeric / 60,
      v_rate.hourly_rate,
      v_amount,
      v_rate.id,
      v_leave.shift_date,
      v_leave.id,
      new.calculation_version,
      jsonb_build_object(
        'source', 'approved_paid_leave',
        'leave_type', v_leave.leave_type,
        'leave_duration', coalesce(v_leave.leave_duration, 'whole_day'),
        'requested_leave_minutes', v_leave.requested_leave_minutes,
        'guaranteed_minutes', v_minutes,
        'prepaid_independent', true,
        'premium_pay', false
      ),
      new.calculated_by
    );

    update public.payroll_records
    set paid_leave_minutes = paid_leave_minutes + v_minutes,
        paid_leave_pay = paid_leave_pay + v_amount
    where id = new.id;
  end loop;

  return new;
end;
$$;

revoke all on function public.payroll_apply_paid_leave_earnings()
  from public, anon, authenticated;

commit;
