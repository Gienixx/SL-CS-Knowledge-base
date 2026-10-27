-- Add Rest Day Change to the existing Schedule Request ledger and recurring
-- weekly-template workflow.  This migration is intentionally additive: leave
-- requests and the existing Open Schedule/Slide Shift API remain unchanged.

begin;

alter table public.leave_requests
  add column if not exists current_rest_weekdays smallint[],
  add column if not exists requested_rest_weekdays smallint[];

alter table public.leave_requests
  drop constraint if exists leave_requests_request_shape_check;

alter table public.leave_requests
  add constraint leave_requests_request_shape_check check (
    (request_category = 'leave'
      and request_type in ('leave', 'incentive_vl', 'birthday_vl', 'leave_without_pay', 'vacation', 'sick', 'emergency', 'unpaid', 'other')
      and target_schedule_id is null
      and requested_shift_start is null
      and requested_shift_end is null
      and requested_planned_paid_minutes is null
      and current_rest_weekdays is null
      and requested_rest_weekdays is null)
    or
    (request_category = 'schedule_change'
      and request_type in ('open_schedule', 'slide_shift', 'rest_day_change')
      and (
        (request_type = 'open_schedule'
          and requested_shift_start is null
          and requested_shift_end is null
          and requested_planned_paid_minutes between 15 and 1440
          and current_rest_weekdays is null
          and requested_rest_weekdays is null)
        or
        (request_type = 'slide_shift'
          and requested_shift_start is not null
          and requested_shift_end is not null
          and requested_shift_end > requested_shift_start
          and requested_planned_paid_minutes is null
          and current_rest_weekdays is null
          and requested_rest_weekdays is null)
        or
        (request_type = 'rest_day_change'
          and target_schedule_id is null
          and requested_shift_start is null
          and requested_shift_end is null
          and requested_planned_paid_minutes is null
          and current_rest_weekdays is not null
          and requested_rest_weekdays is not null
          and cardinality(current_rest_weekdays) between 1 and 6
          and cardinality(requested_rest_weekdays) between 1 and 6)
      ))
  );

comment on column public.leave_requests.current_rest_weekdays is
  'Server-captured recurring rest weekdays (Sunday=0 through Saturday=6) at request time.';
comment on column public.leave_requests.requested_rest_weekdays is
  'Requested recurring rest weekdays (Sunday=0 through Saturday=6), captured for audit.';

-- Resolve the same per-user/team assignment the weekly generator uses, but for
-- the actual effective date.  Inactive assignments with an explicit historical
-- end date remain eligible for deterministic regeneration of old weeks.
create or replace function public.workforce_effective_weekly_assignment(
  p_user_id uuid,
  p_work_date date
)
returns table (
  assignment_id uuid,
  assignment_user_id uuid,
  user_id uuid,
  team_id uuid,
  template_id uuid,
  timezone text,
  effective_from date
)
language sql
security definer
set search_path = ''
as $$
  select
    assignment.id,
    assignment.user_id,
    profile.user_id,
    profile.team_id,
    assignment.template_id,
    template.timezone,
    assignment.effective_from
  from public.profiles profile
  join public.work_schedule_template_assignments assignment
    on (assignment.user_id = profile.user_id
        or (assignment.user_id is null and assignment.team_id = profile.team_id))
  join public.work_schedule_templates template
    on template.id = assignment.template_id
   and template.is_active
  where profile.user_id = p_user_id
    and profile.employment_status = 'active'
    and profile.is_agent is true
    and (profile.base_role = 'agent' or assignment.allow_admin_agent)
    and (assignment.is_active or assignment.effective_until is not null)
    and assignment.effective_from <= p_work_date
    and (assignment.effective_until is null or assignment.effective_until >= p_work_date)
  order by
    (assignment.user_id is not null) desc,
    assignment.effective_from desc,
    assignment.created_at desc
  limit 1;
$$;

revoke all on function public.workforce_effective_weekly_assignment(uuid, date)
  from public, anon, authenticated;
alter function public.workforce_effective_weekly_assignment(uuid, date) owner to postgres;

-- Make generation honor an assignment boundary inside a Monday-Sunday range.
-- Existing generated rows remain idempotent; only new future rows use the
-- assignment that covers their own work date.
create or replace function public.workforce_generate_weekly_schedules(
  p_week_start date default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_local_today date := (now() at time zone 'America/New_York')::date;
  v_week_start date;
  v_profile record;
  v_assignment record;
  v_day record;
  v_shift_date date;
  v_shift_start timestamptz;
  v_shift_end timestamptz;
  v_leave_approved boolean;
  v_inserted integer := 0;
begin
  v_week_start := coalesce(
    p_week_start,
    v_local_today + (8 - extract(isodow from v_local_today)::integer)
  );

  if extract(isodow from v_week_start)::integer <> 1 then
    raise exception 'Weekly schedule generation must start on a Monday.';
  end if;

  for v_profile in
    select profile.user_id
    from public.profiles profile
    where profile.employment_status = 'active'
      and profile.is_agent is true
  loop
    for v_shift_date in
      select v_week_start + offset_value
      from generate_series(0, 6) as offset_value
    loop
      select * into v_assignment
      from public.workforce_effective_weekly_assignment(v_profile.user_id, v_shift_date);

      if not found then
        continue;
      end if;

      for v_day in
        select template_day.*
        from public.work_schedule_template_days template_day
        where template_day.template_id = v_assignment.template_id
          and template_day.weekday = extract(dow from v_shift_date)::smallint
        order by template_day.shift_sequence
      loop
        v_leave_approved := exists (
          select 1
          from public.leave_requests leave_request
          where leave_request.user_id = v_assignment.user_id
            and leave_request.status = 'approved'
            and v_shift_date between leave_request.start_date and leave_request.end_date
        );

        if v_day.is_rest_day then
          v_shift_start := null;
          v_shift_end := null;
        else
          v_shift_start := make_timestamptz(
            extract(year from v_shift_date)::integer,
            extract(month from v_shift_date)::integer,
            extract(day from v_shift_date)::integer,
            extract(hour from v_day.start_time)::integer,
            extract(minute from v_day.start_time)::integer,
            0,
            v_assignment.timezone
          );
          v_shift_end := make_timestamptz(
            extract(year from v_shift_date + v_day.end_day_offset)::integer,
            extract(month from v_shift_date + v_day.end_day_offset)::integer,
            extract(day from v_shift_date + v_day.end_day_offset)::integer,
            extract(hour from v_day.end_time)::integer,
            extract(minute from v_day.end_time)::integer,
            0,
            v_assignment.timezone
          );
        end if;

        insert into public.work_schedules (
          user_id, team_id, shift_date, shift_sequence, shift_start, shift_end,
          timezone, status, is_rest_day, is_holiday, holiday_name, notes,
          schedule_template_id, generated_by_automation, admin_override,
          automation_leave_cancelled
        ) values (
          v_assignment.user_id, v_assignment.team_id, v_shift_date,
          v_day.shift_sequence, v_shift_start, v_shift_end, v_assignment.timezone,
          case when v_leave_approved and not v_day.is_rest_day then 'cancelled' else 'published' end,
          v_day.is_rest_day, false, null, 'Generated from weekly schedule template',
          v_assignment.template_id, true, false,
          v_leave_approved and not v_day.is_rest_day
        )
        on conflict (user_id, shift_date, shift_sequence) do nothing;

        if found then
          v_inserted := v_inserted + 1;
        end if;
      end loop;
    end loop;
  end loop;

  return v_inserted;
end;
$$;

revoke all on function public.workforce_generate_weekly_schedules(date)
  from public, anon, authenticated;

create or replace function public.workforce_get_my_recurring_schedule(
  p_effective_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := public.workforce_current_profile_id();
  v_effective_date date := coalesce(p_effective_date, (now() at time zone 'America/New_York')::date);
  v_assignment record;
  v_rest_days smallint[];
begin
  if auth.uid() is null
     or v_user_id is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_current_user_is_agent() then
    raise exception 'Authentication and an active workforce agent profile are required.';
  end if;

  select * into v_assignment
  from public.workforce_effective_weekly_assignment(v_user_id, v_effective_date);

  if not found then
    return jsonb_build_object(
      'template_id', null,
      'effective_from', null,
      'timezone', null,
      'current_rest_weekdays', null
    );
  end if;

  if (
    select count(*) from public.work_schedule_template_days day_row
    where day_row.template_id = v_assignment.template_id
  ) <> 7
  or exists (
    select 1
    from public.work_schedule_template_days day_row
    where day_row.template_id = v_assignment.template_id
      and day_row.shift_sequence <> 1
  ) then
    raise exception 'The recurring schedule must contain exactly one entry for each weekday.';
  end if;

  select coalesce(array_agg(day_row.weekday order by day_row.weekday)
                  filter (where day_row.is_rest_day), '{}'::smallint[])
  into v_rest_days
  from public.work_schedule_template_days day_row
  where day_row.template_id = v_assignment.template_id;

  return jsonb_build_object(
    'template_id', v_assignment.template_id,
    'effective_from', v_assignment.effective_from,
    'timezone', v_assignment.timezone,
    'current_rest_weekdays', to_jsonb(v_rest_days)
  );
end;
$$;

revoke all on function public.workforce_get_my_recurring_schedule(date)
  from public, anon, authenticated;
grant execute on function public.workforce_get_my_recurring_schedule(date)
  to authenticated, service_role;
alter function public.workforce_get_my_recurring_schedule(date) owner to postgres;

create or replace function public.workforce_submit_rest_day_change_request(
  p_effective_date date,
  p_requested_rest_weekdays smallint[],
  p_reason text
)
returns public.leave_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := public.workforce_current_profile_id();
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_assignment record;
  v_current_rest smallint[];
  v_requested_rest smallint[];
  v_result public.leave_requests%rowtype;
begin
  if auth.uid() is null
     or v_user_id is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_current_user_is_agent() then
    raise exception 'Authentication and an active workforce agent profile are required.';
  end if;

  if p_effective_date is null or v_reason is null then
    raise exception 'Effective date and request reason are required.';
  end if;
  if length(v_reason) > 1000 then
    raise exception 'The request reason cannot exceed 1000 characters.';
  end if;
  if p_requested_rest_weekdays is null
     or cardinality(p_requested_rest_weekdays) not between 1 and 6 then
    raise exception 'Select between 1 and 6 requested rest weekdays.';
  end if;
  if exists (
    select 1 from unnest(p_requested_rest_weekdays) weekday_value
    where weekday_value is null or weekday_value < 0 or weekday_value > 6
  ) then
    raise exception 'Rest weekdays must be unique values from 0 (Sunday) through 6 (Saturday).';
  end if;
  if (select count(*) from unnest(p_requested_rest_weekdays))
     <> (select count(distinct weekday_value) from unnest(p_requested_rest_weekdays) weekday_value) then
    raise exception 'Rest weekdays cannot contain duplicates.';
  end if;

  select * into v_assignment
  from public.workforce_effective_weekly_assignment(v_user_id, p_effective_date);
  if not found then
    raise exception 'No active recurring schedule covers the effective date.';
  end if;
  if v_assignment.timezone <> 'America/New_York' then
    raise exception 'The recurring schedule timezone is not supported.';
  end if;
  if p_effective_date < v_assignment.effective_from then
    raise exception 'The effective date cannot precede the current recurring schedule.';
  end if;

  if (
    select count(*) from public.work_schedule_template_days day_row
    where day_row.template_id = v_assignment.template_id
  ) <> 7
  or exists (
    select 1 from public.work_schedule_template_days day_row
    where day_row.template_id = v_assignment.template_id
      and day_row.shift_sequence <> 1
  ) then
    raise exception 'The recurring schedule must contain exactly one entry for each weekday.';
  end if;

  select coalesce(array_agg(day_row.weekday order by day_row.weekday)
                  filter (where day_row.is_rest_day), '{}'::smallint[])
  into v_current_rest
  from public.work_schedule_template_days day_row
  where day_row.template_id = v_assignment.template_id;

  if cardinality(v_current_rest) not between 1 and 6 then
    raise exception 'The current recurring schedule must contain between 1 and 6 rest weekdays.';
  end if;

  select coalesce(array_agg(weekday_value order by weekday_value), '{}'::smallint[])
  into v_requested_rest
  from (select distinct weekday_value from unnest(p_requested_rest_weekdays) weekday_value) values_set;

  if v_requested_rest = v_current_rest then
    raise exception 'The requested rest-day pattern is unchanged.';
  end if;

  if exists (
    select 1
    from public.work_schedule_template_assignments future_assignment
    where future_assignment.user_id = v_user_id
      and future_assignment.id <> v_assignment.assignment_id
      and future_assignment.effective_from >= p_effective_date
      and (future_assignment.effective_until is null or future_assignment.effective_until >= p_effective_date)
  ) then
    raise exception 'A future recurring schedule assignment already conflicts with this effective date.';
  end if;

  if exists (
    select 1
    from public.leave_requests request_row
    where request_row.user_id = v_user_id
      and request_row.request_category = 'schedule_change'
      and request_row.status = 'pending'
      and request_row.start_date >= p_effective_date
  ) then
    raise exception 'A pending future schedule change already conflicts with this effective date.';
  end if;

  if exists (
    select 1
    from public.attendance attendance_row
    join public.work_schedules schedule_row
      on schedule_row.id = attendance_row.schedule_id
    where attendance_row.user_id = v_user_id
      and attendance_row.work_date >= p_effective_date
      and attendance_row.voided_at is null
      and schedule_row.schedule_template_id = v_assignment.template_id
  ) then
    raise exception 'Existing attendance after the effective date must be reconciled before changing the recurring pattern.';
  end if;

  if exists (
    select 1
    from public.payroll_periods period_row
    left join public.payroll_records record_row
      on record_row.payroll_period_id = period_row.id
     and record_row.employee_id = v_user_id
    where p_effective_date between period_row.period_start and period_row.period_end
      and (period_row.status = 'finalized' or record_row.status = 'finalized')
  ) then
    raise exception 'The payroll period containing the effective date is finalized.';
  end if;

  insert into public.leave_requests (
    user_id, leave_type, start_date, end_date, reason, status,
    request_category, request_type, current_rest_weekdays, requested_rest_weekdays
  ) values (
    v_user_id, 'other', p_effective_date, p_effective_date, v_reason, 'pending',
    'schedule_change', 'rest_day_change', v_current_rest, v_requested_rest
  )
  returning * into v_result;

  return v_result;
end;
$$;

revoke all on function public.workforce_submit_rest_day_change_request(date, smallint[], text)
  from public, anon, authenticated;
grant execute on function public.workforce_submit_rest_day_change_request(date, smallint[], text)
  to authenticated, service_role;
alter function public.workforce_submit_rest_day_change_request(date, smallint[], text) owner to postgres;

comment on function public.workforce_submit_rest_day_change_request(date, smallint[], text) is
  'Submits a Rest Day Change into the existing leave_requests Schedule Request ledger.';

-- Extend the existing review RPC.  The Open Schedule and Slide Shift paths
-- below remain the existing audited Schedule Management paths.
create or replace function public.workforce_review_schedule_request(
  p_request_id uuid,
  p_status text,
  p_review_notes text default null
)
returns public.leave_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_status text := lower(trim(coalesce(p_status, '')));
  v_review_notes text := nullif(trim(coalesce(p_review_notes, '')), '');
  v_request public.leave_requests%rowtype;
  v_target public.work_schedules%rowtype;
  v_saved public.work_schedules%rowtype;
  v_profile public.profiles%rowtype;
  v_assignment record;
  v_template public.work_schedule_templates%rowtype;
  v_new_template_id uuid;
  v_current_rest smallint[];
  v_representative record;
  v_future record;
  v_timezone text := 'America/New_York';
  v_sequence integer := 1;
  v_notes text;
begin
  if v_actor is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_is_admin() then
    raise exception 'Active administrator access is required.';
  end if;
  if v_status not in ('approved', 'rejected') then
    raise exception 'Review status must be approved or rejected.';
  end if;
  if v_status = 'rejected' and v_review_notes is null then
    raise exception 'A denial reason is required.';
  end if;

  select * into v_request
  from public.leave_requests
  where id = p_request_id
  for update;
  if not found then
    raise exception 'Schedule request not found.';
  end if;
  if v_request.request_category <> 'schedule_change' then
    raise exception 'This is a leave request; use the leave review action.';
  end if;
  if not public.workforce_can_manage_user(v_request.user_id, 'approve_leave')
     or not public.workforce_can_manage_user(v_request.user_id, 'manage_schedules') then
    raise exception 'You do not have permission to review and apply this schedule request.';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'Only pending schedule requests can be reviewed.';
  end if;

  if v_status = 'rejected' then
    update public.leave_requests
    set status = 'rejected', review_notes = v_review_notes,
        reviewed_by = v_actor, reviewed_at = now(), updated_at = now()
    where id = v_request.id
    returning * into v_request;

    insert into public.workforce_audit_logs (
      actor_user_id, action, entity_type, entity_id, before_data, after_data, reason
    ) values (
      v_actor, 'schedule_request_denied', 'leave_request', v_request.id,
      jsonb_build_object('status', 'pending', 'request_type', v_request.request_type),
      jsonb_build_object('status', 'rejected', 'request_type', v_request.request_type,
                         'current_rest_weekdays', v_request.current_rest_weekdays,
                         'requested_rest_weekdays', v_request.requested_rest_weekdays,
                         'review_notes', v_review_notes),
      v_review_notes
    );
    return v_request;
  end if;

  select * into v_profile from public.profiles where user_id = v_request.user_id;
  if not found then
    raise exception 'Employee profile not found.';
  end if;

  if v_request.request_type = 'rest_day_change' then
    select * into v_assignment
    from public.workforce_effective_weekly_assignment(v_request.user_id, v_request.start_date);
    if not found then
      raise exception 'No active recurring schedule covers the effective date.';
    end if;
    if v_assignment.timezone <> 'America/New_York' then
      raise exception 'The recurring schedule timezone is not supported.';
    end if;
    if v_request.requested_rest_weekdays is null
       or cardinality(v_request.requested_rest_weekdays) not between 1 and 6 then
      raise exception 'The requested rest-day pattern is invalid.';
    end if;
    if exists (
      select 1 from unnest(v_request.requested_rest_weekdays) weekday_value
      where weekday_value is null or weekday_value < 0 or weekday_value > 6
    )
    or (select count(*) from unnest(v_request.requested_rest_weekdays))
       <> (select count(distinct weekday_value) from unnest(v_request.requested_rest_weekdays) weekday_value) then
      raise exception 'The requested rest-day pattern contains invalid or duplicate weekdays.';
    end if;

    select coalesce(array_agg(day_row.weekday order by day_row.weekday)
                    filter (where day_row.is_rest_day), '{}'::smallint[])
    into v_current_rest
    from public.work_schedule_template_days day_row
    where day_row.template_id = v_assignment.template_id;

    if v_current_rest is distinct from v_request.current_rest_weekdays then
      raise exception 'The recurring schedule changed after this request was submitted. Reconcile and resubmit.';
    end if;
    if cardinality(v_current_rest) not between 1 and 6 then
      raise exception 'The current recurring schedule must contain between 1 and 6 rest weekdays.';
    end if;
    if v_request.requested_rest_weekdays = v_current_rest then
      raise exception 'The requested rest-day pattern is unchanged.';
    end if;
    if (
      select count(*) from public.work_schedule_template_days day_row
      where day_row.template_id = v_assignment.template_id
    ) <> 7
    or exists (
      select 1 from public.work_schedule_template_days day_row
      where day_row.template_id = v_assignment.template_id
        and day_row.shift_sequence <> 1
    ) then
      raise exception 'The recurring schedule must contain exactly one entry for each weekday.';
    end if;
    if exists (
      select 1
      from public.work_schedule_template_assignments future_assignment
      where future_assignment.user_id = v_request.user_id
        and future_assignment.id <> v_assignment.assignment_id
        and future_assignment.effective_from >= v_request.start_date
        and (future_assignment.effective_until is null or future_assignment.effective_until >= v_request.start_date)
    ) then
      raise exception 'A future recurring schedule assignment conflicts with this approval.';
    end if;
    if exists (
      select 1
      from public.leave_requests request_row
      where request_row.id <> v_request.id
        and request_row.user_id = v_request.user_id
        and request_row.request_category = 'schedule_change'
        and request_row.status = 'pending'
        and request_row.start_date >= v_request.start_date
    ) then
      raise exception 'A pending future schedule change conflicts with this approval.';
    end if;
    if exists (
      select 1
      from public.attendance attendance_row
      join public.work_schedules schedule_row on schedule_row.id = attendance_row.schedule_id
      where attendance_row.user_id = v_request.user_id
        and attendance_row.work_date >= v_request.start_date
        and attendance_row.voided_at is null
        and schedule_row.schedule_template_id = v_assignment.template_id
    ) then
      raise exception 'Existing attendance after the effective date must be reconciled before approval.';
    end if;
    if exists (
      select 1
      from public.payroll_periods period_row
      left join public.payroll_records record_row
        on record_row.payroll_period_id = period_row.id
       and record_row.employee_id = v_request.user_id
      where v_request.start_date between period_row.period_start and period_row.period_end
        and (period_row.status = 'finalized' or record_row.status = 'finalized')
    ) then
      raise exception 'The payroll period containing the effective date is finalized.';
    end if;

    select * into v_template
    from public.work_schedule_templates
    where id = v_assignment.template_id
    for update;
    select day_row.* into v_representative
    from public.work_schedule_template_days day_row
    where day_row.template_id = v_assignment.template_id
      and not day_row.is_rest_day
    order by day_row.weekday, day_row.shift_sequence
    limit 1;
    if not found then
      raise exception 'At least one timed recurring workday is required.';
    end if;
    if exists (
      select 1
      from public.work_schedule_template_days day_row
      where day_row.template_id = v_assignment.template_id
        and day_row.is_rest_day
        and not (day_row.weekday = any(v_request.requested_rest_weekdays))
        and exists (
          select 1
          from public.work_schedule_template_days work_day
          where work_day.template_id = v_assignment.template_id
            and not work_day.is_rest_day
            and (work_day.start_time, work_day.end_time, work_day.end_day_offset)
              is distinct from (v_representative.start_time, v_representative.end_time, v_representative.end_day_offset)
        )
    ) then
      raise exception 'The recurring workday hours are not uniform; the new workday hours must be resolved before changing rest days.';
    end if;

    insert into public.work_schedule_templates (
      name, timezone, is_active, created_by, updated_by
    ) values (
      v_template.name || ' · Rest Day Change ' || v_request.id::text,
      v_template.timezone, true, v_actor, v_actor
    ) returning id into v_new_template_id;

    insert into public.work_schedule_template_days (
      template_id, weekday, shift_sequence, start_time, end_time,
      end_day_offset, is_rest_day
    )
    select
      v_new_template_id,
      day_row.weekday,
      day_row.shift_sequence,
      case when day_row.weekday = any(v_request.requested_rest_weekdays) then null
           when day_row.is_rest_day then v_representative.start_time
           else day_row.start_time end,
      case when day_row.weekday = any(v_request.requested_rest_weekdays) then null
           when day_row.is_rest_day then v_representative.end_time
           else day_row.end_time end,
      case when day_row.weekday = any(v_request.requested_rest_weekdays) then 0
           when day_row.is_rest_day then v_representative.end_day_offset
           else day_row.end_day_offset end,
      day_row.weekday = any(v_request.requested_rest_weekdays)
    from public.work_schedule_template_days day_row
    where day_row.template_id = v_assignment.template_id;

    if v_assignment.assignment_user_id is not null
       and v_assignment.effective_from < v_request.start_date then
      update public.work_schedule_template_assignments
      set is_active = false,
          effective_until = v_request.start_date - 1,
          updated_at = now()
      where id = v_assignment.assignment_id;
    elsif v_assignment.assignment_user_id is not null then
      update public.work_schedule_template_assignments
      set template_id = v_new_template_id,
          is_active = true,
          updated_at = now()
      where id = v_assignment.assignment_id;
    end if;

    if v_assignment.assignment_user_id is not null
       and v_assignment.effective_from >= v_request.start_date then
      null;
    else
      insert into public.work_schedule_template_assignments (
        template_id, user_id, team_id, is_active, effective_from,
        effective_until, allow_admin_agent, created_by
      ) values (
        v_new_template_id, v_request.user_id, null, true, v_request.start_date,
        null, false, v_actor
      );
    end if;

    for v_future in
      select schedule_row.id, schedule_row.shift_date, schedule_row.shift_sequence,
             day_row.start_time, day_row.end_time, day_row.end_day_offset, day_row.is_rest_day
      from public.work_schedules schedule_row
      join public.work_schedule_template_days day_row
        on day_row.template_id = v_new_template_id
       and day_row.weekday = extract(dow from schedule_row.shift_date)::smallint
       and day_row.shift_sequence = schedule_row.shift_sequence
      where schedule_row.user_id = v_request.user_id
        and schedule_row.shift_date >= v_request.start_date
        and schedule_row.schedule_template_id = v_assignment.template_id
        and schedule_row.generated_by_automation
        and not schedule_row.admin_override
        and not exists (
          select 1 from public.attendance attendance_row
          where attendance_row.schedule_id = schedule_row.id
            and attendance_row.voided_at is null
        )
      for update of schedule_row
    loop
      if v_future.is_rest_day then
        update public.work_schedules
        set shift_start = null, shift_end = null, is_rest_day = true,
            schedule_template_id = v_new_template_id, updated_by = v_actor, updated_at = now()
        where id = v_future.id;
      else
        update public.work_schedules
        set shift_start = make_timestamptz(
              extract(year from v_future.shift_date)::integer,
              extract(month from v_future.shift_date)::integer,
              extract(day from v_future.shift_date)::integer,
              extract(hour from v_future.start_time)::integer,
              extract(minute from v_future.start_time)::integer,
              0, v_template.timezone
            ),
            shift_end = make_timestamptz(
              extract(year from v_future.shift_date + v_future.end_day_offset)::integer,
              extract(month from v_future.shift_date + v_future.end_day_offset)::integer,
              extract(day from v_future.shift_date + v_future.end_day_offset)::integer,
              extract(hour from v_future.end_time)::integer,
              extract(minute from v_future.end_time)::integer,
              0, v_template.timezone
            ),
            is_rest_day = false,
            schedule_template_id = v_new_template_id,
            updated_by = v_actor, updated_at = now()
        where id = v_future.id;
      end if;
    end loop;
  else
    if v_request.target_schedule_id is not null then
      select * into v_target
      from public.work_schedules
      where id = v_request.target_schedule_id
      for update;
      if not found or v_target.user_id <> v_request.user_id then
        raise exception 'The target schedule no longer belongs to the requesting employee.';
      end if;
      if v_target.shift_date <> v_request.start_date then
        raise exception 'The target schedule no longer matches the requested work date.';
      end if;
      if v_target.status in ('cancelled', 'completed') then
        raise exception 'Cancelled or completed schedules cannot be changed.';
      end if;
      if v_target.is_leave or v_target.is_absent or v_target.is_rest_day or v_target.is_holiday then
        raise exception 'Leave, absence, rest-day, and holiday schedules cannot be changed through this request.';
      end if;
      v_sequence := v_target.shift_sequence;
      v_timezone := coalesce(nullif(v_target.timezone, ''), v_timezone);
    else
      v_timezone := coalesce(nullif(v_profile.timezone, ''), v_timezone);
    end if;
    if v_timezone <> 'America/New_York' then
      raise exception 'The selected schedule timezone is not supported.';
    end if;
    if exists (
      select 1 from public.attendance attendance_row
      where attendance_row.user_id = v_request.user_id
        and attendance_row.work_date = v_request.start_date
        and attendance_row.voided_at is null
    ) then
      raise exception 'Attendance already exists for this work date. Resolve it before applying the schedule request.';
    end if;
    if exists (
      select 1
      from public.payroll_periods period_row
      left join public.payroll_records record_row
        on record_row.payroll_period_id = period_row.id
       and record_row.employee_id = v_request.user_id
      where v_request.start_date between period_row.period_start and period_row.period_end
        and (period_row.status = 'finalized' or record_row.status = 'finalized')
    ) then
      raise exception 'The payroll period is finalized. Schedule changes are no longer allowed for this date.';
    end if;

    v_notes := format('Approved Schedule Request %s: %s', v_request.id, v_request.reason);
    if v_request.request_type = 'open_schedule' then
      v_saved := public.workforce_admin_save_open_schedule(
        v_request.target_schedule_id, v_request.user_id, v_request.start_date,
        v_sequence, v_timezone, 'published', v_notes,
        v_request.requested_planned_paid_minutes
      );
    elsif v_request.request_type = 'slide_shift' then
      v_saved := public.workforce_admin_save_schedule(
        v_request.target_schedule_id, v_request.user_id, v_request.start_date,
        v_sequence, v_request.requested_shift_start, v_request.requested_shift_end,
        v_timezone, 'published', false, false, null, v_notes
      );
    else
      raise exception 'Unsupported schedule request type.';
    end if;
  end if;

  update public.leave_requests
  set status = 'approved', review_notes = v_review_notes,
      reviewed_by = v_actor, reviewed_at = now(), updated_at = now()
  where id = v_request.id
  returning * into v_request;

  insert into public.workforce_audit_logs (
    actor_user_id, action, entity_type, entity_id, before_data, after_data, reason
  ) values (
    v_actor, 'schedule_request_approved', 'leave_request', v_request.id,
    jsonb_build_object('status', 'pending', 'request_type', v_request.request_type),
    case when v_request.request_type = 'rest_day_change' then
      jsonb_build_object(
        'status', 'approved', 'request_type', v_request.request_type,
        'current_rest_weekdays', v_request.current_rest_weekdays,
        'requested_rest_weekdays', v_request.requested_rest_weekdays,
        'effective_from', v_request.start_date,
        'new_template_id', v_new_template_id,
        'review_notes', v_review_notes
      )
    else
      jsonb_build_object(
        'status', 'approved', 'request_type', v_request.request_type,
        'schedule_id', v_saved.id, 'schedule_version', v_saved.schedule_version,
        'review_notes', v_review_notes
      )
    end,
    coalesce(v_review_notes, 'Approved schedule request and synchronized Schedule Management')
  );

  return v_request;
end;
$$;

revoke all on function public.workforce_review_schedule_request(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.workforce_review_schedule_request(uuid, text, text)
  to authenticated, service_role;
alter function public.workforce_review_schedule_request(uuid, text, text) owner to postgres;

comment on function public.workforce_review_schedule_request(uuid, text, text) is
  'Atomically denies or applies pending Open Schedule, Slide Shift, or Rest Day Change requests through the existing audited workflow.';

commit;

;
