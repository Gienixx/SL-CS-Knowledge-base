begin;
-- Server-captured provenance for schedule-change requests.  These fields are
-- deliberately nullable so the existing leave ledger remains compatible with
-- ordinary leave rows and no historical request rows are rewritten.
alter table public.leave_requests
  add column if not exists target_schedule_version bigint,
  add column if not exists target_schedule_updated_at timestamptz,
  add column if not exists original_shift_start timestamptz,
  add column if not exists original_shift_end timestamptz,
  add column if not exists original_planned_paid_minutes integer,
  add column if not exists original_schedule_status text,
  add column if not exists recurring_assignment_id uuid,
  add column if not exists recurring_template_id uuid,
  add column if not exists recurring_assignment_effective_from date,
  add column if not exists recurring_assignment_effective_until date,
  add column if not exists recurring_template_updated_at timestamptz;
comment on column public.leave_requests.target_schedule_version is
  'Schedule version captured by the server when an Open Schedule or Slide Shift request targets an existing schedule.';
comment on column public.leave_requests.target_schedule_updated_at is
  'Schedule updated_at captured by the server when a schedule-change request is submitted.';
comment on column public.leave_requests.recurring_assignment_id is
  'Effective recurring assignment captured by the server for a Rest Day Change request.';
comment on column public.leave_requests.recurring_template_id is
  'Effective recurring template captured by the server for a Rest Day Change request.';
-- Keep the current implementations private under stable internal names.  The
-- public signatures below become guarded wrappers and preserve the existing
-- client API, grants, return types, and mutation paths.
alter function public.workforce_submit_schedule_request(
  text, date, uuid, timestamptz, timestamptz, integer, text
) rename to workforce_submit_schedule_request_without_stale_snapshot;
alter function public.workforce_submit_rest_day_change_request(
  date, smallint[], text
) rename to workforce_submit_rest_day_change_request_without_stale_snapshot;
alter function public.workforce_review_schedule_request(
  uuid, text, text
) rename to workforce_review_schedule_request_without_stale_guard;
revoke all on function public.workforce_submit_schedule_request_without_stale_snapshot(
  text, date, uuid, timestamptz, timestamptz, integer, text
) from public, anon, authenticated;
revoke all on function public.workforce_submit_rest_day_change_request_without_stale_snapshot(
  date, smallint[], text
) from public, anon, authenticated;
revoke all on function public.workforce_review_schedule_request_without_stale_guard(
  uuid, text, text
) from public, anon, authenticated;
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
  v_target public.work_schedules%rowtype;
  v_result public.leave_requests%rowtype;
begin
  -- Lock the target before invoking the existing validation/insertion path.
  -- Snapshot values are read from this row, never accepted from the browser.
  if p_target_schedule_id is not null then
    select * into v_target
    from public.work_schedules
    where id = p_target_schedule_id
      and user_id = v_user_id
    for update;
  end if;

  v_result := public.workforce_submit_schedule_request_without_stale_snapshot(
    p_request_type, p_work_date, p_target_schedule_id,
    p_requested_shift_start, p_requested_shift_end,
    p_requested_planned_paid_minutes, p_reason
  );

  if v_target.id is not null then
    update public.leave_requests
    set target_schedule_version = v_target.schedule_version,
        target_schedule_updated_at = v_target.updated_at,
        original_shift_start = v_target.shift_start,
        original_shift_end = v_target.shift_end,
        original_planned_paid_minutes = v_target.planned_paid_minutes,
        original_schedule_status = v_target.status
    where id = v_result.id
    returning * into v_result;
  end if;

  return v_result;
end;
$$;
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
  v_assignment record;
  v_assignment_row public.work_schedule_template_assignments%rowtype;
  v_template public.work_schedule_templates%rowtype;
  v_result public.leave_requests%rowtype;
begin
  -- Resolve and lock the exact recurring source before the existing submit
  -- function validates and inserts the request.
  select * into v_assignment
  from public.workforce_effective_weekly_assignment(v_user_id, p_effective_date);

  if v_assignment.assignment_id is not null then
    select * into v_assignment_row
    from public.work_schedule_template_assignments
    where id = v_assignment.assignment_id
    for update;

    select * into v_template
    from public.work_schedule_templates
    where id = v_assignment.template_id
    for update;
  end if;

  v_result := public.workforce_submit_rest_day_change_request_without_stale_snapshot(
    p_effective_date, p_requested_rest_weekdays, p_reason
  );

  update public.leave_requests
  set recurring_assignment_id = v_assignment_row.id,
      recurring_template_id = v_template.id,
      recurring_assignment_effective_from = v_assignment_row.effective_from,
      recurring_assignment_effective_until = v_assignment_row.effective_until,
      recurring_template_updated_at = v_template.updated_at
  where id = v_result.id
  returning * into v_result;

  return v_result;
end;
$$;
-- Active-session exception for requests submitted before clock-in.  This is
-- intentionally private and is called only after the public wrapper has
-- completed its stale-snapshot checks.  It reuses the existing audited
-- schedule-save RPCs; it does not write attendance clock fields or bypass
-- payroll/finalization protections.
create or replace function public.workforce_review_schedule_request_active_session(
  p_request_id uuid,
  p_review_notes text default null
)
returns public.leave_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_request public.leave_requests%rowtype;
  v_target public.work_schedules%rowtype;
  v_saved public.work_schedules%rowtype;
  v_attendance public.attendance%rowtype;
  v_attendance_count integer := 0;
  v_timezone text := 'America/New_York';
  v_sequence integer := 1;
  v_notes text;
  v_review_notes text := nullif(trim(coalesce(p_review_notes, '')), '');
begin
  select * into v_request
  from public.leave_requests
  where id = p_request_id
  for update;

  if not found
     or v_request.status <> 'pending'
     or v_request.request_category <> 'schedule_change'
     or v_request.request_type not in ('open_schedule', 'slide_shift') then
    return null;
  end if;

  select count(*)::integer into v_attendance_count
  from public.attendance attendance_row
  where attendance_row.user_id = v_request.user_id
    and attendance_row.work_date = v_request.start_date
    and attendance_row.voided_at is null;

  if v_attendance_count = 0 then
    return null;
  end if;

  if exists (
    select 1
    from public.attendance attendance_row
    where attendance_row.user_id = v_request.user_id
      and attendance_row.work_date = v_request.start_date
      and attendance_row.voided_at is null
      and attendance_row.clock_in is not null
      and v_request.created_at > attendance_row.clock_in
  ) then
    raise exception 'This request was submitted after attendance started and cannot be approved automatically. Use Workforce Management if an audited correction is required.';
  end if;

  if v_actor is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_is_admin()
     or not public.workforce_can_manage_user(v_request.user_id, 'approve_leave')
     or not public.workforce_can_manage_user(v_request.user_id, 'manage_schedules') then
    raise exception 'You do not have permission to review and apply this schedule request.';
  end if;

  if v_request.target_schedule_id is null then
    raise exception 'This request cannot be approved automatically because attendance for this date has progressed beyond the safe approval window.';
  end if;

  select * into v_target
  from public.work_schedules
  where id = v_request.target_schedule_id
  for update;

  if not found
     or v_target.user_id <> v_request.user_id
     or v_target.shift_date <> v_request.start_date
     or v_target.status in ('cancelled', 'completed')
     or v_target.is_leave or v_target.is_absent or v_target.is_rest_day or v_target.is_holiday then
    raise exception 'This request cannot be approved automatically because attendance for this date has progressed beyond the safe approval window.';
  end if;

  select * into v_attendance
  from public.attendance attendance_row
  where attendance_row.user_id = v_request.user_id
    and attendance_row.work_date = v_request.start_date
    and attendance_row.schedule_id = v_request.target_schedule_id
    and attendance_row.voided_at is null
    and attendance_row.clock_in is not null
    and attendance_row.clock_out is null
    and attendance_row.billed_clock_out is null
    and attendance_row.review_status in ('pending', 'corrected')
  for update;

  if not found or v_attendance_count <> 1
     or v_request.created_at > v_attendance.clock_in then
    raise exception 'This request cannot be approved automatically because attendance for this date has progressed beyond the safe approval window.';
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

  v_sequence := v_target.shift_sequence;
  v_timezone := coalesce(nullif(v_target.timezone, ''), v_timezone);
  if v_timezone <> 'America/New_York' then
    raise exception 'The selected schedule timezone is not supported.';
  end if;

  v_notes := format('Approved Schedule Request %s: %s', v_request.id, v_request.reason);
  if v_request.request_type = 'open_schedule' then
    v_saved := public.workforce_admin_save_open_schedule(
      v_request.target_schedule_id, v_request.user_id, v_request.start_date,
      v_sequence, v_timezone, 'published', v_notes,
      v_request.requested_planned_paid_minutes
    );
  else
    v_saved := public.workforce_admin_save_schedule(
      v_request.target_schedule_id, v_request.user_id, v_request.start_date,
      v_sequence, v_request.requested_shift_start, v_request.requested_shift_end,
      v_timezone, 'published', false, false, null, v_notes
    );
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
    jsonb_build_object(
      'status', 'approved', 'request_type', v_request.request_type,
      'schedule_id', v_saved.id, 'schedule_version', v_saved.schedule_version,
      'review_notes', v_review_notes
    ),
    coalesce(v_review_notes, 'Approved schedule request and synchronized Schedule Management')
  );

  return v_request;
end;
$$;
revoke all on function public.workforce_review_schedule_request_active_session(
  uuid, text
) from public, anon, authenticated;
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
  v_request public.leave_requests%rowtype;
  v_target public.work_schedules%rowtype;
  v_assignment record;
  v_assignment_row public.work_schedule_template_assignments%rowtype;
  v_template public.work_schedule_templates%rowtype;
  v_current_rest smallint[];
  v_status text := lower(trim(coalesce(p_status, '')));
  v_stale_message constant text :=
    'Schedule request is stale because the target schedule changed after submission. Review the current schedule and submit a new request.';
begin
  if v_status = 'approved' then
    select * into v_request
    from public.leave_requests
    where id = p_request_id
    for update;

    if v_request.id is not null and v_request.status = 'pending'
       and v_request.request_category = 'schedule_change' then
      if v_request.request_type in ('open_schedule', 'slide_shift') then
        if v_request.target_schedule_id is null then
          -- A no-target Open Schedule request may create a row only if the
          -- originally empty date is still empty.
          if exists (
            select 1 from public.work_schedules schedule_row
            where schedule_row.user_id = v_request.user_id
              and schedule_row.shift_date = v_request.start_date
          ) then
            raise exception '%', v_stale_message;
          end if;
        else
          select * into v_target
          from public.work_schedules
          where id = v_request.target_schedule_id
          for update;

          if not found
             or v_request.target_schedule_version is null
             or v_request.target_schedule_updated_at is null
             or v_target.schedule_version is distinct from v_request.target_schedule_version
             or v_target.updated_at is distinct from v_request.target_schedule_updated_at
             or v_target.shift_start is distinct from v_request.original_shift_start
             or v_target.shift_end is distinct from v_request.original_shift_end
             or v_target.planned_paid_minutes is distinct from v_request.original_planned_paid_minutes
             or v_target.status is distinct from v_request.original_schedule_status then
            raise exception '%', v_stale_message;
          end if;
        end if;
      elsif v_request.request_type = 'rest_day_change' then
        select * into v_assignment
        from public.workforce_effective_weekly_assignment(
          v_request.user_id, v_request.start_date
        );

        if not found then
          raise exception '%', v_stale_message;
        end if;

        select * into v_assignment_row
        from public.work_schedule_template_assignments
        where id = v_assignment.assignment_id
        for update;

        select * into v_template
        from public.work_schedule_templates
        where id = v_assignment.template_id
        for update;

        select coalesce(array_agg(day_row.weekday order by day_row.weekday)
                        filter (where day_row.is_rest_day), '{}'::smallint[])
        into v_current_rest
        from public.work_schedule_template_days day_row
        where day_row.template_id = v_assignment.template_id;

        if not found
           or v_request.recurring_assignment_id is null
           or v_request.recurring_template_id is null
           or v_assignment_row.id is distinct from v_request.recurring_assignment_id
           or v_template.id is distinct from v_request.recurring_template_id
           or v_assignment_row.effective_from is distinct from v_request.recurring_assignment_effective_from
           or v_assignment_row.effective_until is distinct from v_request.recurring_assignment_effective_until
           or v_template.updated_at is distinct from v_request.recurring_template_updated_at
           or v_current_rest is distinct from v_request.current_rest_weekdays then
          raise exception '%', v_stale_message;
        end if;
      end if;
    end if;

    if found and v_request.status = 'pending'
       and v_request.request_category = 'schedule_change'
       and v_request.request_type in ('open_schedule', 'slide_shift') then
      -- A non-null result means the safe pre-clock-in exception handled the
      -- approval.  A null result means there was no active attendance row and
      -- the original workflow should continue unchanged.
      declare
        v_active_result public.leave_requests;
      begin
        v_active_result := public.workforce_review_schedule_request_active_session(
          p_request_id, p_review_notes
        );
        if v_active_result.id is not null then
          return v_active_result;
        end if;
      end;
    end if;
  end if;

  -- This invokes the original, audited, permission-checked transactional
  -- implementation only after the guarded source-state checks succeed.
  return public.workforce_review_schedule_request_without_stale_guard(
    p_request_id, p_status, p_review_notes
  );
end;
$$;
revoke all on function public.workforce_submit_schedule_request(
  text, date, uuid, timestamptz, timestamptz, integer, text
) from public, anon, authenticated;
grant execute on function public.workforce_submit_schedule_request(
  text, date, uuid, timestamptz, timestamptz, integer, text
) to authenticated, service_role;
revoke all on function public.workforce_submit_rest_day_change_request(
  date, smallint[], text
) from public, anon, authenticated;
grant execute on function public.workforce_submit_rest_day_change_request(
  date, smallint[], text
) to authenticated, service_role;
revoke all on function public.workforce_review_schedule_request(
  uuid, text, text
) from public, anon, authenticated;
grant execute on function public.workforce_review_schedule_request(
  uuid, text, text
) to authenticated, service_role;
comment on function public.workforce_review_schedule_request(uuid, text, text) is
  'Rejects stale schedule-change requests before delegating to the existing audited transactional approval workflow.';
commit;
