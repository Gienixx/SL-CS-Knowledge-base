begin;

-- Reuse the existing leave_requests workflow as the durable request ledger.
-- Existing rows remain leave requests; schedule changes use the additional
-- request metadata without introducing a parallel request table.
alter table public.leave_requests
  add column if not exists request_category text not null default 'leave',
  add column if not exists request_type text not null default 'leave',
  add column if not exists target_schedule_id uuid,
  add column if not exists requested_shift_start timestamptz,
  add column if not exists requested_shift_end timestamptz,
  add column if not exists requested_planned_paid_minutes integer;

update public.leave_requests
set request_category = case
      when request_category in ('leave', 'schedule_change') then request_category
      else 'leave'
    end,
    request_type = case
      when request_category = 'leave' then coalesce(nullif(request_type, ''), leave_type, 'leave')
      else request_type
    end
where request_category is null
   or request_category not in ('leave', 'schedule_change')
   or request_type is null
   or request_type = '';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'leave_requests_target_schedule_id_fkey'
      and conrelid = 'public.leave_requests'::regclass
  ) then
    alter table public.leave_requests
      add constraint leave_requests_target_schedule_id_fkey
      foreign key (target_schedule_id)
      references public.work_schedules(id)
      on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'leave_requests_request_shape_check'
      and conrelid = 'public.leave_requests'::regclass
  ) then
    alter table public.leave_requests
      add constraint leave_requests_request_shape_check check (
        (request_category = 'leave'
          and request_type in ('leave', 'incentive_vl', 'birthday_vl', 'leave_without_pay', 'vacation', 'sick', 'emergency', 'unpaid', 'other')
          and target_schedule_id is null
          and requested_shift_start is null
          and requested_shift_end is null
          and requested_planned_paid_minutes is null)
        or
        (request_category = 'schedule_change'
          and request_type in ('open_schedule', 'slide_shift')
          and (
            (request_type = 'open_schedule'
              and requested_shift_start is null
              and requested_shift_end is null
              and requested_planned_paid_minutes between 15 and 1440)
            or
            (request_type = 'slide_shift'
              and requested_shift_start is not null
              and requested_shift_end is not null
              and requested_shift_end > requested_shift_start
              and requested_planned_paid_minutes is null)
          ))
      );
  end if;
end;
$$;

create index if not exists leave_requests_category_status_date_idx
  on public.leave_requests (request_category, status, start_date desc, created_at desc);

create index if not exists leave_requests_target_schedule_idx
  on public.leave_requests (target_schedule_id)
  where target_schedule_id is not null;

comment on column public.leave_requests.request_category is
  'Unified request category: leave or schedule_change.';
comment on column public.leave_requests.request_type is
  'Unified request type. Leave rows retain the legacy leave marker or canonical leave type; schedule changes use open_schedule or slide_shift.';
comment on column public.leave_requests.target_schedule_id is
  'Existing schedule selected by the requester for a schedule change, when one exists.';
comment on column public.leave_requests.requested_shift_start is
  'Requested Slide Shift start, stored as an absolute timestamp in the schedule timezone.';
comment on column public.leave_requests.requested_shift_end is
  'Requested Slide Shift end, stored as an absolute timestamp in the schedule timezone.';
comment on column public.leave_requests.requested_planned_paid_minutes is
  'Requested Open Schedule paid plan, in minutes.';

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
  -- Schedule-change approvals are mutated by their review RPC.  They must
  -- never be interpreted as leave and must not create a leave schedule.
  if coalesce(new.request_category, 'leave') <> 'leave' then
    return new;
  end if;

  if new.status <> 'approved' then
    return new;
  end if;

  select * into v_profile from public.profiles where user_id = new.user_id;
  if not found then
    raise exception 'Employee profile not found for the leave request.';
  end if;

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

revoke all on function public.workforce_sync_approved_leave_schedules()
  from public, anon, authenticated;

create or replace function public.workforce_submit_schedule_request(
  p_request_type text,
  p_work_date date,
  p_target_schedule_id uuid,
  p_requested_shift_start timestamptz,
  p_requested_shift_end timestamptz,
  p_requested_planned_paid_minutes integer,
  p_reason text
)
returns public.leave_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := public.workforce_current_profile_id();
  v_type text := lower(trim(coalesce(p_request_type, '')));
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_target public.work_schedules%rowtype;
  v_profile public.profiles%rowtype;
  v_result public.leave_requests%rowtype;
  v_timezone text := 'America/New_York';
begin
  if auth.uid() is null
     or v_user_id is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_current_user_is_agent() then
    raise exception 'Authentication and an active workforce agent profile are required.';
  end if;

  if v_type not in ('open_schedule', 'slide_shift') then
    raise exception 'Select a valid schedule-change request type.';
  end if;

  if p_work_date is null or v_reason is null then
    raise exception 'Work date and request reason are required.';
  end if;

  if length(v_reason) > 1000 then
    raise exception 'The request reason cannot exceed 1000 characters.';
  end if;

  select * into v_profile from public.profiles where user_id = v_user_id;
  if not found then
    raise exception 'Employee profile not found.';
  end if;

  if p_target_schedule_id is not null then
    select * into v_target
    from public.work_schedules
    where id = p_target_schedule_id
      and user_id = v_user_id
    for update;

    if not found then
      raise exception 'The selected schedule does not belong to you.';
    end if;

    if v_target.shift_date <> p_work_date then
      raise exception 'The selected schedule does not match the requested work date.';
    end if;

    if v_target.status in ('cancelled', 'completed') then
      raise exception 'Cancelled or completed schedules cannot be requested for change.';
    end if;

    if v_target.is_leave or v_target.is_absent or v_target.is_rest_day or v_target.is_holiday then
      raise exception 'Leave, absence, rest-day, and holiday schedules cannot be changed through this request.';
    end if;

    v_timezone := coalesce(nullif(v_target.timezone, ''), v_timezone);
  else
    if v_type = 'slide_shift' then
      raise exception 'Slide Shift requires an existing schedule.';
    end if;
    v_timezone := coalesce(nullif(v_profile.timezone, ''), v_timezone);
  end if;

  if v_timezone <> 'America/New_York' then
    raise exception 'The selected schedule timezone is not supported.';
  end if;

  if v_type = 'open_schedule' then
    if p_requested_shift_start is not null or p_requested_shift_end is not null then
      raise exception 'Open Schedule does not accept shift times.';
    end if;
    if p_requested_planned_paid_minutes is null
       or p_requested_planned_paid_minutes < 15
       or p_requested_planned_paid_minutes > 1440 then
      raise exception 'Open Schedule planned paid minutes must be between 15 and 1440.';
    end if;
  else
    if p_requested_shift_start is null or p_requested_shift_end is null then
      raise exception 'Slide Shift start and end times are required.';
    end if;
    if p_requested_shift_end <= p_requested_shift_start
       or p_requested_shift_end - p_requested_shift_start > interval '24 hours' then
      raise exception 'Slide Shift must be positive and no longer than 24 hours.';
    end if;
    if (p_requested_shift_start at time zone v_timezone)::date <> p_work_date then
      raise exception 'Slide Shift start must fall on the requested work date.';
    end if;
    if p_requested_planned_paid_minutes is not null then
      raise exception 'Slide Shift does not accept planned paid minutes.';
    end if;
  end if;

  if exists (
    select 1 from public.work_schedules schedule
    where schedule.user_id = v_user_id
      and schedule.shift_date = p_work_date
      and schedule.is_absent
  ) then
    raise exception 'An absence schedule prevents a schedule-change request on this date.';
  end if;

  if exists (
    select 1 from public.leave_requests request
    where request.user_id = v_user_id
      and request.request_category = 'schedule_change'
      and request.status = 'pending'
      and request.start_date = p_work_date
  ) then
    raise exception 'A pending schedule-change request already exists for this date.';
  end if;

  insert into public.leave_requests (
    user_id, leave_type, start_date, end_date, reason, status,
    request_category, request_type, target_schedule_id,
    requested_shift_start, requested_shift_end,
    requested_planned_paid_minutes
  ) values (
    v_user_id, 'other', p_work_date, p_work_date, v_reason, 'pending',
    'schedule_change', v_type, p_target_schedule_id,
    p_requested_shift_start, p_requested_shift_end,
    p_requested_planned_paid_minutes
  )
  returning * into v_result;

  return v_result;
end;
$$;

revoke all on function public.workforce_submit_schedule_request(
  text, date, uuid, timestamptz, timestamptz, integer, text
) from public, anon, authenticated;
grant execute on function public.workforce_submit_schedule_request(
  text, date, uuid, timestamptz, timestamptz, integer, text
) to authenticated, service_role;

comment on function public.workforce_submit_schedule_request(
  text, date, uuid, timestamptz, timestamptz, integer, text
) is
  'Submits an identity-safe Open Schedule or Slide Shift request into the existing request ledger.';

create or replace function public.workforce_review_leave_request(
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
  v_result public.leave_requests%rowtype;
  v_schedule_count integer := 0;
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
    raise exception 'Leave request not found.';
  end if;

  if coalesce(v_request.request_category, 'leave') <> 'leave' then
    raise exception 'This is a schedule-change request; use the schedule request review action.';
  end if;

  if not public.workforce_can_manage_user(v_request.user_id, 'approve_leave') then
    raise exception 'You do not have permission to review this leave request.';
  end if;

  if v_request.status <> 'pending' then
    raise exception 'Only pending leave requests can be reviewed.';
  end if;

  update public.leave_requests
  set status = v_status,
      review_notes = v_review_notes,
      reviewed_by = v_actor,
      reviewed_at = now(),
      updated_at = now()
  where id = p_request_id
  returning * into v_result;

  if v_status = 'approved' then
    select count(*)
    into v_schedule_count
    from public.work_schedules schedule
    where schedule.leave_request_id = v_request.id;
  end if;

  insert into public.workforce_audit_logs (
    actor_user_id, action, entity_type, entity_id,
    before_data, after_data, reason
  ) values (
    v_actor, 'leave_request_reviewed', 'leave_request', v_request.id,
    jsonb_build_object('status', v_request.status),
    jsonb_build_object(
      'status', v_result.status,
      'review_notes', v_result.review_notes,
      'leave_schedules_linked', v_schedule_count
    ),
    case when v_status = 'rejected' then v_review_notes
         else 'Approved leave request and synchronized the employee schedule' end
  );

  return v_result;
end;
$$;

revoke all on function public.workforce_review_leave_request(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.workforce_review_leave_request(uuid, text, text)
  to authenticated, service_role;

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
    set status = 'rejected',
        review_notes = v_review_notes,
        reviewed_by = v_actor,
        reviewed_at = now(),
        updated_at = now()
    where id = v_request.id
    returning * into v_request;

    insert into public.workforce_audit_logs (
      actor_user_id, action, entity_type, entity_id,
      before_data, after_data, reason
    ) values (
      v_actor, 'schedule_request_denied', 'leave_request', v_request.id,
      jsonb_build_object('status', 'pending'),
      jsonb_build_object('status', 'rejected', 'review_notes', v_review_notes),
      v_review_notes
    );

    return v_request;
  end if;

  select * into v_profile from public.profiles where user_id = v_request.user_id;
  if not found then
    raise exception 'Employee profile not found.';
  end if;

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

  -- A schedule request must never rewrite a rendered session or finalized
  -- payroll source. Voided attendance is historical and does not block a
  -- safe change; any live or locked attendance does.
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
    from public.payroll_periods period
    left join public.payroll_records record
      on record.payroll_period_id = period.id
     and record.employee_id = v_request.user_id
    where v_request.start_date between period.period_start and period.period_end
      and (period.status = 'finalized' or record.status = 'finalized')
  ) then
    raise exception 'The payroll period is finalized. Schedule changes are no longer allowed for this date.';
  end if;

  v_notes := format(
    'Approved Schedule Request %s: %s',
    v_request.id,
    v_request.reason
  );

  if v_request.request_type = 'open_schedule' then
    v_saved := public.workforce_admin_save_open_schedule(
      v_request.target_schedule_id,
      v_request.user_id,
      v_request.start_date,
      v_sequence,
      v_timezone,
      'published',
      v_notes,
      v_request.requested_planned_paid_minutes
    );
  elsif v_request.request_type = 'slide_shift' then
    v_saved := public.workforce_admin_save_schedule(
      v_request.target_schedule_id,
      v_request.user_id,
      v_request.start_date,
      v_sequence,
      v_request.requested_shift_start,
      v_request.requested_shift_end,
      v_timezone,
      'published',
      false,
      false,
      null,
      v_notes
    );
  else
    raise exception 'Unsupported schedule request type.';
  end if;

  update public.leave_requests
  set status = 'approved',
      review_notes = v_review_notes,
      reviewed_by = v_actor,
      reviewed_at = now(),
      updated_at = now()
  where id = v_request.id
  returning * into v_request;

  insert into public.workforce_audit_logs (
    actor_user_id, action, entity_type, entity_id,
    before_data, after_data, reason
  ) values (
    v_actor, 'schedule_request_approved', 'leave_request', v_request.id,
    jsonb_build_object('status', 'pending'),
    jsonb_build_object(
      'status', 'approved',
      'request_type', v_request.request_type,
      'schedule_id', v_saved.id,
      'schedule_version', v_saved.schedule_version,
      'review_notes', v_review_notes
    ),
    coalesce(v_review_notes, 'Approved schedule request and synchronized Schedule Management')
  );

  return v_request;
end;
$$;

revoke all on function public.workforce_review_schedule_request(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.workforce_review_schedule_request(uuid, text, text)
  to authenticated, service_role;

comment on function public.workforce_review_schedule_request(uuid, text, text) is
  'Atomically denies or applies a pending Open Schedule or Slide Shift request through the existing Schedule Management RPCs.';

commit;
