begin;

-- Paid leave is a separate guaranteed earning.  It must not mutate or replace
-- a normal work schedule and it must not be represented as timed attendance.
create or replace function public.workforce_is_paid_leave_type(p_leave_type text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select lower(trim(coalesce(p_leave_type, ''))) in ('incentive_vl', 'birthday_vl');
$$;

revoke all on function public.workforce_is_paid_leave_type(text)
  from public, anon, authenticated;

create or replace function public.workforce_sync_approved_leave_schedules()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_schedule_leave_type text := public.workforce_leave_request_schedule_type(new.leave_type);
  v_shift_date date;
begin
  if new.status <> 'approved' then
    return new;
  end if;

  select * into v_profile from public.profiles where user_id = new.user_id;
  if not found then
    raise exception 'Employee profile not found for the leave request.';
  end if;

  -- Keep any normal schedule and its attendance intact.  Add one independent
  -- leave schedule per date instead of converting the work schedule.
  for v_shift_date in
    select generate_series(new.start_date::timestamp, new.end_date::timestamp, interval '1 day')::date
  loop
    if not exists (
      select 1 from public.work_schedules schedule
      where schedule.user_id = new.user_id
        and schedule.shift_date = v_shift_date
        and schedule.is_leave
        and schedule.leave_request_id = new.id
    ) then
      insert into public.work_schedules (
        user_id, team_id, shift_date, shift_sequence, shift_start, shift_end,
        timezone, status, is_rest_day, is_holiday, is_leave, is_absent,
        leave_type, absence_type, notes, planned_paid_minutes,
        leave_request_id, created_by, updated_by
      ) values (
        new.user_id, v_profile.team_id, v_shift_date, 99, null, null,
        coalesce(nullif(v_profile.timezone, ''), 'America/New_York'), 'published',
        false, false, true, false, v_schedule_leave_type, null,
        case v_schedule_leave_type
          when 'incentive_vl' then 'Approved Incentive VL'
          when 'birthday_vl' then 'Approved Birthday VL'
          else 'Approved Leave Without Pay'
        end,
        null, new.id, v_actor, v_actor
      );
    end if;
  end loop;

  return new;
end;
$$;

-- A paid-leave date may also contain attendance.  Leave schedules themselves
-- remain ineligible for timed attendance; the normal schedule is selected.
create or replace function public.workforce_reject_attended_leave_schedule()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.is_leave or new.is_absent)
     and exists (
       select 1 from public.attendance attendance_row
       where attendance_row.schedule_id = new.id
     ) then
    raise exception 'Attendance cannot be linked to a leave or absent schedule.';
  end if;
  return new;
end;
$$;

-- Do not rewrite a newly created normal schedule merely because an approved
-- leave request covers its date.  The leave schedule is maintained separately
-- by workforce_sync_approved_leave_schedules().
create or replace function public.workforce_apply_approved_leave_to_new_schedule()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return new;
end;
$$;

-- Replace clock-in discovery/validation only; retain authentication, open
-- session, date-range, and schedule ownership checks from the trusted flow.
create or replace function public.workforce_clock_in(p_schedule_id uuid default null::uuid)
returns public.attendance
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_auth_user_id uuid := auth.uid();
  v_profile_user_id uuid;
  v_timezone text;
  v_local_date date;
  v_work_date date;
  v_clock_time timestamptz := now();
  v_has_released_schedule boolean := false;
  v_schedule public.work_schedules%rowtype;
  v_existing public.attendance%rowtype;
  v_result public.attendance%rowtype;
begin
  if v_auth_user_id is null or not public.workforce_current_user_is_agent() then
    raise exception 'Authentication and an active agent profile are required.';
  end if;
  v_profile_user_id := public.workforce_current_profile_id();
  if v_profile_user_id is null then
    raise exception 'No workforce profile is linked to the current account.';
  end if;
  perform pg_advisory_xact_lock(hashtext(v_profile_user_id::text)::bigint);
  select coalesce(nullif(profile.timezone, ''), 'America/New_York') into v_timezone
  from public.profiles profile where profile.user_id = v_profile_user_id;
  v_local_date := (v_clock_time at time zone v_timezone)::date;
  v_work_date := v_local_date;

  if exists (select 1 from public.attendance a where a.user_id = v_profile_user_id and a.clock_in is not null and a.clock_out is null) then
    raise exception 'You are already clocked in to another shift.';
  end if;

  if p_schedule_id is null then
    select exists (
      select 1 from public.work_schedules schedule
      where schedule.user_id = v_profile_user_id
        and schedule.status in ('published', 'changed')
        and not schedule.is_leave and not schedule.is_absent
        and ((schedule.shift_start is not null and schedule.shift_end is not null
              and schedule.shift_date between v_local_date - 1 and v_local_date + 1
              and schedule.shift_end > v_clock_time)
             or (schedule.is_rest_day or schedule.is_holiday) and schedule.shift_date = v_local_date)
    ) into v_has_released_schedule;
    if v_has_released_schedule then
      raise exception 'A released shift or special work date is available. Select it before clocking in.';
    end if;
  else
    select * into v_schedule from public.work_schedules schedule
    where schedule.id = p_schedule_id and schedule.user_id = v_profile_user_id;
    if not found then raise exception 'The selected schedule does not belong to the current user.'; end if;
    if v_schedule.status not in ('published', 'changed') then raise exception 'Clock-in is not available for this schedule.'; end if;
    if v_schedule.is_leave or v_schedule.is_absent then raise exception 'Leave and absence schedules cannot be used for timed attendance.'; end if;
    if v_schedule.shift_start is null or v_schedule.shift_end is null then raise exception 'The selected schedule does not have valid shift times.'; end if;
    if v_schedule.shift_date < v_local_date - 1 or v_schedule.shift_date > v_local_date + 1 then raise exception 'The selected schedule is outside the available attendance date range.'; end if;
    if v_clock_time >= v_schedule.shift_end then raise exception 'This shift has already ended and is no longer available for clock-in.'; end if;
    v_work_date := v_schedule.shift_date;
  end if;

  if p_schedule_id is null then
    select * into v_existing from public.attendance a
    where a.user_id = v_profile_user_id and a.schedule_id is null and a.work_date = v_work_date
    order by a.created_at asc limit 1 for update;
  else
    select * into v_existing from public.attendance a
    where a.user_id = v_profile_user_id and a.schedule_id = p_schedule_id
    order by a.created_at asc limit 1 for update;
  end if;
  if found and v_existing.clock_in is not null then raise exception 'Attendance has already been recorded for this shift.'; end if;

  if v_existing.id is not null then
    update public.attendance set clock_in = v_clock_time, schedule_id = coalesce(p_schedule_id, schedule_id),
      work_date = v_work_date, attendance_status = 'present', created_by = coalesce(created_by, v_auth_user_id), updated_by = v_auth_user_id
    where id = v_existing.id returning * into v_result;
  else
    insert into public.attendance (user_id, schedule_id, work_date, clock_in, attendance_status, created_by, updated_by)
    values (v_profile_user_id, p_schedule_id, v_work_date, v_clock_time, 'present', v_auth_user_id, v_auth_user_id)
    returning * into v_result;
  end if;
  return public.workforce_recalculate_attendance(v_result.id);
end;
$$;

alter table public.payroll_records
  add column if not exists paid_leave_minutes integer not null default 0,
  add column if not exists paid_leave_pay numeric(14,2) not null default 0;

alter table public.payroll_items
  add constraint payroll_items_paid_leave_metadata_check check (
    item_code <> 'paid_leave_earnings'
    or (metadata ->> 'source') = 'approved_paid_leave'
  );

create or replace function public.payroll_apply_paid_leave_earnings()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_leave record;
  v_rate record;
  v_prepaid integer;
  v_minutes integer;
  v_amount numeric(14,2);
begin
  if new.calculated_at is null or new.status = 'void' then return new; end if;
  delete from public.payroll_items item
  where item.payroll_record_id = new.id and not item.is_manual and item.item_code = 'paid_leave_earnings';
  update public.payroll_records set paid_leave_minutes = 0, paid_leave_pay = 0 where id = new.id;

  for v_leave in
    select distinct on (schedule.shift_date) schedule.shift_date, schedule.id, schedule.leave_type, schedule.leave_request_id
    from public.work_schedules schedule
    where schedule.user_id = new.employee_id
      and schedule.status in ('published', 'changed', 'completed')
      and schedule.is_leave
      and public.workforce_is_paid_leave_type(schedule.leave_type)
      and schedule.shift_date between (select period_start from public.payroll_periods where id = new.payroll_period_id)
          and (select period_end from public.payroll_periods where id = new.payroll_period_id)
    order by schedule.shift_date, schedule.updated_at desc, schedule.id
  loop
    select coalesce(sum(prepaid.prepaid_minutes), 0)::integer into v_prepaid
    from public.payroll_prepaid_hours prepaid
    join public.payroll_schedule_snapshots snapshot on snapshot.id = prepaid.source_schedule_snapshot_id
    where prepaid.employee_id = new.employee_id and prepaid.voided_at is null and snapshot.work_date = v_leave.shift_date;
    v_minutes := greatest(480 - coalesce(v_prepaid, 0), 0);
    if v_minutes = 0 then continue; end if;
    select rate.* into v_rate from public.agent_rates rate
    where rate.employee_id = new.employee_id and rate.effective_date <= v_leave.shift_date
    order by rate.effective_date desc limit 1;
    if not found then continue; end if;
    v_amount := round(v_minutes::numeric / 60 * v_rate.hourly_rate, 2);
    insert into public.payroll_items (payroll_record_id, item_type, item_code, description, quantity, unit_rate, amount, rate_id, work_date, source_schedule_id, calculation_version, metadata, created_by)
    values (new.id, 'earning', 'paid_leave_earnings', 'Approved paid leave — worked hours are additional', v_minutes::numeric / 60, v_rate.hourly_rate, v_amount, v_rate.id, v_leave.shift_date, v_leave.id, new.calculation_version,
      jsonb_build_object('source', 'approved_paid_leave', 'leave_type', v_leave.leave_type, 'guaranteed_minutes', 480, 'prepaid_minutes_deducted', coalesce(v_prepaid, 0), 'premium_pay', false), new.calculated_by);
    update public.payroll_records set paid_leave_minutes = paid_leave_minutes + v_minutes, paid_leave_pay = paid_leave_pay + v_amount where id = new.id;
  end loop;
  return new;
end;
$$;

drop trigger if exists payroll_records_paid_leave_earnings on public.payroll_records;
create trigger payroll_records_paid_leave_earnings
after update of calculated_at on public.payroll_records
for each row when (new.calculated_at is distinct from old.calculated_at)
execute function public.payroll_apply_paid_leave_earnings();

revoke all on function public.payroll_apply_paid_leave_earnings() from public, anon, authenticated;

insert into public.workforce_audit_logs (actor_user_id, action, entity_type, after_data, reason)
values (null, 'paid_leave_attendance_coexistence_enabled', 'attendance_payroll',
  jsonb_build_object('paid_leave_types', jsonb_build_array('incentive_vl', 'birthday_vl'), 'paid_minutes_per_day', 480, 'attendance_additional', true, 'premium_pay', false),
  'Approved paid leave remains independently payable while same-day attendance remains additional work');

commit;
