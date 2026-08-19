begin;

alter table public.work_schedules
  add column if not exists leave_request_id uuid;

alter table public.work_schedules
  add constraint work_schedules_leave_request_id_fkey
  foreign key (leave_request_id)
  references public.leave_requests(id)
  on delete restrict;

alter table public.work_schedules
  add constraint work_schedules_leave_request_type_check check (
    leave_request_id is null or (is_leave and not is_absent)
  );

create index if not exists work_schedules_leave_request_id_idx
  on public.work_schedules (leave_request_id)
  where leave_request_id is not null;

comment on column public.work_schedules.leave_request_id is
  'Approved leave request that created or converted this leave schedule.';

alter table public.leave_requests
  drop constraint if exists leave_requests_type_check;

alter table public.leave_requests
  add constraint leave_requests_type_check check (
    leave_type in (
      'incentive_vl',
      'birthday_vl',
      'leave_without_pay',
      'vacation',
      'sick',
      'emergency',
      'unpaid',
      'other'
    )
  );

create or replace function public.workforce_leave_request_schedule_type(
  p_leave_type text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case lower(trim(coalesce(p_leave_type, '')))
    when 'incentive_vl' then 'incentive_vl'
    when 'birthday_vl' then 'birthday_vl'
    when 'leave_without_pay' then 'leave_without_pay'
    when 'vacation' then 'incentive_vl'
    else 'leave_without_pay'
  end;
$$;

revoke all on function public.workforce_leave_request_schedule_type(text)
  from public, anon, authenticated;

create or replace function public.workforce_submit_leave_request(
  p_leave_type text,
  p_start_date date,
  p_end_date date,
  p_reason text
)
returns public.leave_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile_user_id uuid := public.workforce_current_profile_id();
  v_leave_type text := lower(trim(coalesce(p_leave_type, '')));
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_result public.leave_requests%rowtype;
begin
  if auth.uid() is null
     or v_profile_user_id is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_current_user_is_agent() then
    raise exception 'Authentication and an active workforce agent profile are required.';
  end if;

  if v_leave_type not in (
    'incentive_vl', 'birthday_vl', 'leave_without_pay'
  ) then
    raise exception 'Select a valid leave type.';
  end if;

  if p_start_date is null or p_end_date is null then
    raise exception 'Start date and end date are required.';
  end if;

  if p_end_date < p_start_date then
    raise exception 'End date cannot be earlier than start date.';
  end if;

  if v_reason is null then
    raise exception 'Explain the reason for this leave request.';
  end if;

  if exists (
    select 1
    from public.leave_requests request
    where request.user_id = v_profile_user_id
      and request.status in ('pending', 'approved')
      and daterange(request.start_date, request.end_date, '[]')
        && daterange(p_start_date, p_end_date, '[]')
  ) then
    raise exception 'A pending or approved leave request already overlaps these dates.';
  end if;

  insert into public.leave_requests (
    user_id,
    leave_type,
    start_date,
    end_date,
    reason,
    status
  ) values (
    v_profile_user_id,
    v_leave_type,
    p_start_date,
    p_end_date,
    v_reason,
    'pending'
  )
  returning * into v_result;

  return v_result;
end;
$$;

revoke all on function public.workforce_submit_leave_request(
  text, date, date, text
) from public, anon, authenticated;
grant execute on function public.workforce_submit_leave_request(
  text, date, date, text
) to authenticated, service_role;

comment on function public.workforce_submit_leave_request(
  text, date, date, text
) is
  'Submits an identity-safe agent leave request with controlled leave types and overlap validation.';

create or replace function public.workforce_cancel_leave_request(
  p_request_id uuid
)
returns public.leave_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile_user_id uuid := public.workforce_current_profile_id();
  v_result public.leave_requests%rowtype;
begin
  if auth.uid() is null
     or v_profile_user_id is null
     or not public.workforce_current_user_is_active() then
    raise exception 'Authentication and an active workforce profile are required.';
  end if;

  update public.leave_requests
  set status = 'cancelled',
      updated_at = now()
  where id = p_request_id
    and user_id = v_profile_user_id
    and status = 'pending'
  returning * into v_result;

  if not found then
    raise exception 'Only your own pending leave request can be cancelled.';
  end if;

  return v_result;
end;
$$;

revoke all on function public.workforce_cancel_leave_request(uuid)
  from public, anon, authenticated;
grant execute on function public.workforce_cancel_leave_request(uuid)
  to authenticated, service_role;

create or replace function public.workforce_sync_approved_leave_schedules()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_schedule_leave_type text;
  v_conflicting_attendance_count integer := 0;
  v_completed_schedule_count integer := 0;
begin
  if new.status <> 'approved' then
    return new;
  end if;

  v_schedule_leave_type := public.workforce_leave_request_schedule_type(
    new.leave_type
  );

  select *
  into v_profile
  from public.profiles profile
  where profile.user_id = new.user_id;

  if not found then
    raise exception 'Employee profile not found for the leave request.';
  end if;

  select count(*)
  into v_conflicting_attendance_count
  from public.attendance attendance_row
  where attendance_row.user_id = new.user_id
    and attendance_row.work_date between new.start_date and new.end_date;

  if v_conflicting_attendance_count > 0 then
    raise exception 'Leave overlaps recorded attendance. Resolve the attendance record before approving leave.';
  end if;

  select count(*)
  into v_completed_schedule_count
  from public.work_schedules schedule
  where schedule.user_id = new.user_id
    and schedule.shift_date between new.start_date and new.end_date
    and schedule.status = 'completed';

  if v_completed_schedule_count > 0 then
    raise exception 'Leave overlaps a completed schedule. Resolve the completed schedule before approving leave.';
  end if;

  update public.work_schedules schedule
  set shift_start = null,
      shift_end = null,
      status = case
        when schedule.status = 'scheduled' then 'published'
        else 'changed'
      end,
      is_rest_day = false,
      is_holiday = false,
      is_leave = true,
      is_absent = false,
      leave_type = v_schedule_leave_type,
      absence_type = null,
      holiday_name = null,
      notes = case v_schedule_leave_type
        when 'incentive_vl' then 'Approved Incentive VL'
        when 'birthday_vl' then 'Approved Birthday VL'
        else 'Approved Leave Without Pay'
      end,
      planned_paid_minutes = null,
      automation_leave_cancelled = false,
      leave_request_id = new.id,
      updated_by = v_actor,
      updated_at = now()
  where schedule.user_id = new.user_id
    and schedule.shift_date between new.start_date and new.end_date
    and schedule.status in ('scheduled', 'published', 'changed', 'cancelled')
    and not schedule.is_rest_day
    and not schedule.is_holiday
    and not schedule.is_absent;

  insert into public.work_schedules (
    user_id,
    team_id,
    shift_date,
    shift_sequence,
    shift_start,
    shift_end,
    timezone,
    status,
    is_rest_day,
    is_holiday,
    is_leave,
    is_absent,
    leave_type,
    absence_type,
    holiday_name,
    notes,
    planned_paid_minutes,
    leave_request_id,
    created_by,
    updated_by
  )
  select
    new.user_id,
    v_profile.team_id,
    requested_date.shift_date,
    1,
    null,
    null,
    coalesce(nullif(v_profile.timezone, ''), 'America/New_York'),
    'published',
    false,
    false,
    true,
    false,
    v_schedule_leave_type,
    null,
    null,
    case v_schedule_leave_type
      when 'incentive_vl' then 'Approved Incentive VL'
      when 'birthday_vl' then 'Approved Birthday VL'
      else 'Approved Leave Without Pay'
    end,
    null,
    new.id,
    v_actor,
    v_actor
  from (
    select generate_series(
      new.start_date::timestamp,
      new.end_date::timestamp,
      interval '1 day'
    )::date as shift_date
  ) requested_date
  where not exists (
    select 1
    from public.work_schedules existing_schedule
    where existing_schedule.user_id = new.user_id
      and existing_schedule.shift_date = requested_date.shift_date
  );

  return new;
end;
$$;

revoke all on function public.workforce_sync_approved_leave_schedules()
  from public, anon, authenticated;

drop trigger if exists leave_requests_sync_generated_schedules
  on public.leave_requests;
create trigger leave_requests_sync_generated_schedules
after insert or update of status, start_date, end_date, leave_type
on public.leave_requests
for each row execute function public.workforce_sync_approved_leave_schedules();

create or replace function public.workforce_apply_approved_leave_to_new_schedule()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.leave_requests%rowtype;
begin
  if new.is_rest_day or new.is_holiday or new.is_absent then
    return new;
  end if;

  select request.*
  into v_request
  from public.leave_requests request
  where request.user_id = new.user_id
    and request.status = 'approved'
    and new.shift_date between request.start_date and request.end_date
  order by request.reviewed_at desc nulls last, request.created_at desc
  limit 1;

  if not found then
    return new;
  end if;

  new.shift_start := null;
  new.shift_end := null;
  new.status := 'published';
  new.is_rest_day := false;
  new.is_holiday := false;
  new.is_leave := true;
  new.is_absent := false;
  new.leave_type := public.workforce_leave_request_schedule_type(
    v_request.leave_type
  );
  new.absence_type := null;
  new.holiday_name := null;
  new.planned_paid_minutes := null;
  new.automation_leave_cancelled := false;
  new.leave_request_id := v_request.id;
  new.notes := case new.leave_type
    when 'incentive_vl' then 'Approved Incentive VL'
    when 'birthday_vl' then 'Approved Birthday VL'
    else 'Approved Leave Without Pay'
  end;

  return new;
end;
$$;

revoke all on function public.workforce_apply_approved_leave_to_new_schedule()
  from public, anon, authenticated;

drop trigger if exists work_schedules_apply_approved_leave_request
  on public.work_schedules;
create trigger work_schedules_apply_approved_leave_request
before insert on public.work_schedules
for each row execute function public.workforce_apply_approved_leave_to_new_schedule();

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

  select *
  into v_request
  from public.leave_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception 'Leave request not found.';
  end if;

  if not public.workforce_can_manage_user(
    v_request.user_id,
    'approve_leave'
  ) then
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
    actor_user_id,
    action,
    entity_type,
    entity_id,
    before_data,
    after_data,
    reason
  ) values (
    v_actor,
    'leave_request_reviewed',
    'leave_request',
    v_request.id,
    jsonb_build_object('status', v_request.status),
    jsonb_build_object(
      'status', v_result.status,
      'review_notes', v_result.review_notes,
      'leave_schedules_linked', v_schedule_count
    ),
    case
      when v_status = 'rejected' then v_review_notes
      else 'Approved leave request and synchronized the employee schedule'
    end
  );

  return v_result;
end;
$$;

revoke all on function public.workforce_review_leave_request(
  uuid, text, text
) from public, anon, authenticated;
grant execute on function public.workforce_review_leave_request(
  uuid, text, text
) to authenticated, service_role;

comment on function public.workforce_review_leave_request(
  uuid, text, text
) is
  'Lets a scoped administrator approve or deny a pending leave request; approval transactionally creates linked leave schedules and denial requires a reason.';

drop policy if exists "Admins can view leave requests"
  on public.leave_requests;
drop policy if exists "Authorized users can update leave requests"
  on public.leave_requests;
drop policy if exists "Users can submit their own leave requests"
  on public.leave_requests;
drop policy if exists "Workforce admins can delete leave requests"
  on public.leave_requests;
drop policy if exists "Users can view their own leave requests"
  on public.leave_requests;
drop policy if exists "Approvers can view scoped leave requests"
  on public.leave_requests;

create policy "Users can view their own leave requests"
on public.leave_requests
for select
to authenticated
using (public.workforce_is_current_identity(user_id));

create policy "Approvers can view scoped leave requests"
on public.leave_requests
for select
to authenticated
using (
  public.workforce_is_admin()
  and public.workforce_can_manage_user(user_id, 'approve_leave')
);

revoke insert, update, delete on table public.leave_requests
  from authenticated;
grant select on table public.leave_requests
  to authenticated;

insert into public.workforce_audit_logs (
  actor_user_id,
  action,
  entity_type,
  after_data,
  reason
) values (
  null,
  'leave_request_schedule_approval_enabled',
  'leave_requests',
  jsonb_build_object(
    'agent_submission_rpc', true,
    'admin_approval_page', true,
    'approval_updates_schedule', true,
    'denial_reason_required', true,
    'linked_schedule_column', 'leave_request_id'
  ),
  'Separated agent submission from administrator approval and linked approved leave to schedules'
);

commit;
