begin;

-- Add one-date conversions to the existing Schedule Request ledger. The
-- recurring-template Rest Day Change request remains a separate request type
-- with its existing submission and approval implementation.
alter table public.leave_requests
  add column if not exists target_schedule_version bigint,
  add column if not exists target_schedule_updated_at timestamptz,
  add column if not exists original_shift_start timestamptz,
  add column if not exists original_shift_end timestamptz,
  add column if not exists original_planned_paid_minutes integer,
  add column if not exists original_schedule_status text;

alter table public.leave_requests
  drop constraint if exists leave_requests_request_shape_check;

alter table public.leave_requests
  add constraint leave_requests_request_shape_check check (
    (
      request_category = 'leave'
      and request_type in (
        'leave', 'incentive_vl', 'birthday_vl', 'leave_without_pay',
        'vacation', 'sick', 'emergency', 'unpaid', 'other'
      )
      and target_schedule_id is null
      and requested_shift_start is null
      and requested_shift_end is null
      and requested_planned_paid_minutes is null
      and current_rest_weekdays is null
      and requested_rest_weekdays is null
    )
    or
    (
      request_category = 'schedule_change'
      and request_type in (
        'open_schedule', 'slide_shift', 'rest_day_change',
        'rest_day', 'regular_shift'
      )
      and (
        (
          request_type = 'open_schedule'
          and requested_shift_start is null
          and requested_shift_end is null
          and requested_planned_paid_minutes between 15 and 1440
          and current_rest_weekdays is null
          and requested_rest_weekdays is null
        )
        or
        (
          request_type = 'slide_shift'
          and requested_shift_start is not null
          and requested_shift_end is not null
          and requested_shift_end > requested_shift_start
          and requested_planned_paid_minutes is null
          and current_rest_weekdays is null
          and requested_rest_weekdays is null
        )
        or
        (
          request_type = 'rest_day_change'
          and target_schedule_id is null
          and requested_shift_start is null
          and requested_shift_end is null
          and requested_planned_paid_minutes is null
          and current_rest_weekdays is not null
          and requested_rest_weekdays is not null
          and cardinality(current_rest_weekdays) between 1 and 6
          and cardinality(requested_rest_weekdays) between 1 and 6
        )
        or
        (
          request_type = 'rest_day'
          and target_schedule_id is not null
          and requested_shift_start is null
          and requested_shift_end is null
          and requested_planned_paid_minutes is null
          and current_rest_weekdays is null
          and requested_rest_weekdays is null
        )
        or
        (
          request_type = 'regular_shift'
          and target_schedule_id is not null
          and requested_shift_start is not null
          and requested_shift_end is not null
          and requested_shift_end > requested_shift_start
          and requested_shift_end - requested_shift_start <= interval '24 hours'
          and requested_planned_paid_minutes is null
          and current_rest_weekdays is null
          and requested_rest_weekdays is null
        )
      )
    )
  );

comment on column public.leave_requests.target_schedule_version is
  'Schedule version captured when an individual schedule conversion request is submitted.';
comment on column public.leave_requests.target_schedule_updated_at is
  'Schedule updated_at value captured when an individual schedule conversion request is submitted.';
comment on column public.leave_requests.original_schedule_status is
  'Original schedule status captured for an individual schedule conversion request.';

create or replace function public.workforce_submit_schedule_conversion_request(
  p_request_type text,
  p_work_date date,
  p_target_schedule_id uuid,
  p_requested_shift_start timestamptz,
  p_requested_shift_end timestamptz,
  p_reason text
)
returns public.leave_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_user_id uuid := public.workforce_current_profile_id();
  v_type text := lower(trim(coalesce(p_request_type, '')));
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_assignment record;
  v_assignment_row public.work_schedule_template_assignments%rowtype;
  v_template public.work_schedule_templates%rowtype;
  v_has_assignment boolean := false;
  v_target public.work_schedules%rowtype;
  v_active_schedule_count integer;
  v_timezone text;
  v_result public.leave_requests%rowtype;
begin
  if v_actor is null
     or v_user_id is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_current_user_is_agent() then
    raise exception 'Authentication and an active workforce agent profile are required.'
      using errcode = '42501';
  end if;

  if v_type not in ('rest_day', 'regular_shift') then
    raise exception 'Select Rest Day or Regular Shift.';
  end if;
  if p_work_date is null or p_target_schedule_id is null or v_reason is null then
    raise exception 'A target date, eligible schedule, and request reason are required.';
  end if;
  if length(v_reason) > 1000 then
    raise exception 'The request reason cannot exceed 1000 characters.';
  end if;

  if v_type = 'rest_day' then
    if p_requested_shift_start is not null or p_requested_shift_end is not null then
      raise exception 'Rest Day does not accept start or end times.';
    end if;
  else
    if p_requested_shift_start is null or p_requested_shift_end is null then
      raise exception 'Regular Shift start and end times are required.';
    end if;
    if p_requested_shift_end <= p_requested_shift_start
       or p_requested_shift_end - p_requested_shift_start > interval '24 hours' then
      raise exception 'Regular Shift must be positive and no longer than 24 hours.';
    end if;
  end if;

  -- Lock recurring source rows in the same order as the existing Rest Day
  -- Change workflow, before locking a generated date-specific schedule.
  select * into v_assignment
  from public.workforce_effective_weekly_assignment(v_user_id, p_work_date);
  v_has_assignment := found;
  if v_has_assignment and v_assignment.assignment_id is not null then
    select * into v_assignment_row
    from public.work_schedule_template_assignments
    where id = v_assignment.assignment_id
    for update;
    if not found then
      raise exception 'The recurring schedule assignment changed. Refresh and try again.';
    end if;

    select * into v_template
    from public.work_schedule_templates
    where id = v_assignment.template_id
    for update;
    if not found then
      raise exception 'The recurring schedule template changed. Refresh and try again.';
    end if;
  end if;

  select * into v_target
  from public.work_schedules
  where id = p_target_schedule_id
    and user_id = v_user_id
  for update;
  if not found then
    raise exception 'The selected schedule does not belong to you.';
  end if;
  if v_target.shift_date <> p_work_date then
    raise exception 'The selected schedule does not match the requested date.';
  end if;
  if v_target.status not in ('published', 'changed') then
    raise exception 'Only published schedules can be changed through this request.';
  end if;
  if v_target.is_holiday or v_target.is_leave or v_target.is_absent then
    raise exception 'Holiday, leave, and absence schedules cannot be converted.';
  end if;
  if v_target.schedule_template_id is not null
     and (not v_has_assignment
       or v_assignment.assignment_id is distinct from v_assignment_row.id
       or v_assignment.template_id is distinct from v_target.schedule_template_id) then
    raise exception 'The selected generated schedule no longer matches its active recurring assignment.';
  end if;

  select count(*)::integer into v_active_schedule_count
  from public.work_schedules schedule_row
  where schedule_row.user_id = v_user_id
    and schedule_row.shift_date = p_work_date
    and schedule_row.status in ('published', 'changed', 'scheduled');
  if v_active_schedule_count <> 1 then
    raise exception 'This date must have exactly one active schedule to be converted.';
  end if;

  if v_type = 'rest_day' then
    if v_target.is_rest_day
       or v_target.shift_start is null
       or v_target.shift_end is null then
      raise exception 'Rest Day requires one existing regular timed shift.';
    end if;
  else
    if not v_target.is_rest_day
       or v_target.shift_start is not null
       or v_target.shift_end is not null then
      raise exception 'Regular Shift requires one existing Rest Day schedule.';
    end if;
    if (p_requested_shift_start at time zone coalesce(nullif(v_target.timezone, ''), 'America/New_York'))::date <> p_work_date then
      raise exception 'Regular Shift start must fall on the selected work date.';
    end if;
  end if;

  v_timezone := coalesce(nullif(v_target.timezone, ''), 'America/New_York');

  if exists (
    select 1 from public.attendance attendance_row
    where attendance_row.user_id = v_user_id
      and (attendance_row.work_date = p_work_date
        or attendance_row.schedule_id = v_target.id)
      and (attendance_row.voided_at is null
        or attendance_row.payroll_approved_at is not null)
  ) then
    raise exception 'Attendance exists for this work date. Resolve it before submitting a schedule conversion request.';
  end if;

  if exists (
    select 1
    from public.payroll_periods period_row
    left join public.payroll_records record_row
      on record_row.payroll_period_id = period_row.id
     and record_row.employee_id = v_user_id
    where p_work_date between period_row.period_start and period_row.period_end
      and (period_row.status = 'finalized' or record_row.status = 'finalized')
  ) then
    raise exception 'The payroll period containing this date is finalized.';
  end if;

  if exists (
    select 1 from public.leave_requests request_row
    where request_row.user_id = v_user_id
      and coalesce(request_row.request_category, 'leave') = 'leave'
      and request_row.status in ('pending', 'approved')
      and request_row.start_date <= p_work_date
      and request_row.end_date >= p_work_date
  ) then
    raise exception 'A pending or approved leave request conflicts with this schedule date.';
  end if;

  if exists (
    select 1 from public.leave_requests request_row
    where request_row.user_id = v_user_id
      and request_row.request_category = 'schedule_change'
      and request_row.status = 'pending'
      and (request_row.start_date = p_work_date
        or (request_row.request_type = 'rest_day_change'
          and request_row.start_date <= p_work_date))
  ) then
    raise exception 'A pending schedule change conflicts with this date.';
  end if;

  insert into public.leave_requests (
    user_id, leave_type, start_date, end_date, reason, status,
    request_category, request_type, target_schedule_id,
    target_schedule_version, target_schedule_updated_at,
    original_shift_start, original_shift_end,
    original_planned_paid_minutes, original_schedule_status,
    requested_shift_start, requested_shift_end,
    requested_planned_paid_minutes
  ) values (
    v_user_id, 'other', p_work_date, p_work_date, v_reason, 'pending',
    'schedule_change', v_type, v_target.id,
    v_target.schedule_version, v_target.updated_at,
    v_target.shift_start, v_target.shift_end,
    v_target.planned_paid_minutes, v_target.status,
    p_requested_shift_start, p_requested_shift_end, null
  ) returning * into v_result;

  return v_result;
end;
$$;

revoke all on function public.workforce_submit_schedule_conversion_request(
  text, date, uuid, timestamptz, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.workforce_submit_schedule_conversion_request(
  text, date, uuid, timestamptz, timestamptz, text
) to authenticated;

comment on function public.workforce_submit_schedule_conversion_request(
  text, date, uuid, timestamptz, timestamptz, text
) is 'Submits a pending one-date Rest Day or Regular Shift conversion into the existing schedule request ledger.';

create or replace function public.workforce_apply_schedule_conversion_request(
  p_request_id uuid,
  p_review_notes text default null
)
returns public.leave_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_request public.leave_requests%rowtype;
  v_target public.work_schedules%rowtype;
  v_saved public.work_schedules%rowtype;
  v_assignment record;
  v_assignment_row public.work_schedule_template_assignments%rowtype;
  v_template public.work_schedule_templates%rowtype;
  v_has_assignment boolean := false;
  v_active_schedule_count integer;
  v_review_notes text := nullif(trim(coalesce(p_review_notes, '')), '');
  v_timezone text;
  v_notes text;
begin
  if v_actor is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_is_admin() then
    raise exception 'Active administrator access is required.' using errcode = '42501';
  end if;

  select * into v_request
  from public.leave_requests
  where id = p_request_id
  for update;
  if not found then
    raise exception 'Schedule request not found.';
  end if;
  if v_request.request_category <> 'schedule_change'
     or v_request.request_type not in ('rest_day', 'regular_shift') then
    raise exception 'This helper only approves Rest Day and Regular Shift requests.';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'Only pending schedule requests can be approved.';
  end if;
  if not public.workforce_can_manage_user(v_request.user_id, 'approve_leave')
     or not public.workforce_can_manage_user(v_request.user_id, 'manage_schedules') then
    raise exception 'You do not have permission to review and apply this schedule request.'
      using errcode = '42501';
  end if;
  if v_request.target_schedule_id is null
     or v_request.target_schedule_version is null
     or v_request.target_schedule_updated_at is null
     or v_request.original_schedule_status is null then
    raise exception 'The schedule snapshot is incomplete. Cancel and resubmit the request.';
  end if;

  -- Serialize date-level schedule changes with the existing Committed Hours
  -- editor, which takes this same employee/date advisory lock before changing
  -- an active target. Payroll-period locks follow it; V1/V2 lifecycle RPCs
  -- lock their parent period before payroll records and schedule rows.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      v_request.user_id::text || ':' || v_request.start_date::text,
      0
    )
  );

  -- Match the existing Rest Day Change order before taking payroll locks. This
  -- keeps its assignment/template/schedule path from waiting behind payroll
  -- locks held by this conversion while its save trigger updates payroll rows.
  select * into v_assignment
  from public.workforce_effective_weekly_assignment(v_request.user_id, v_request.start_date);
  v_has_assignment := found;
  if v_has_assignment and v_assignment.assignment_id is not null then
    select * into v_assignment_row
    from public.work_schedule_template_assignments
    where id = v_assignment.assignment_id
    for update;
    if not found then
      raise exception 'The recurring schedule assignment changed after submission.';
    end if;
    select * into v_template
    from public.work_schedule_templates
    where id = v_assignment.template_id
    for update;
    if not found then
      raise exception 'The recurring schedule template changed after submission.';
    end if;
  end if;

  -- Match the legacy payroll lock order (period, then employee record). These
  -- parent-period locks serialize those operations with their child record and
  -- schedule rows and remain held through the authoritative save. Do not lock
  -- payroll records here: schedule-save triggers update them after the target
  -- schedule lock, and the existing recurring request path takes templates first.
  perform 1
  from public.payroll_periods period_row
  where v_request.start_date between period_row.period_start and period_row.period_end
  order by period_row.id
  for share;

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

  -- Payroll V2 lifecycle operations use period -> employee-record row locks.
  -- Block its authoritative persisted states and any non-void calculation
  -- snapshot tied to this date/schedule so historical payroll evidence cannot
  -- become stale when the schedule is converted.
  perform 1
  from public.payroll_v2_periods period_row
  where v_request.start_date between period_row.period_start and period_row.period_end
  order by period_row.id
  for share;

  if exists (
    select 1
    from public.payroll_v2_periods period_row
    where v_request.start_date between period_row.period_start and period_row.period_end
      and period_row.status in ('approved', 'finalized', 'closed')
  ) or exists (
    select 1
    from public.payroll_v2_records record_row
    join public.payroll_v2_periods period_row
      on period_row.id = record_row.payroll_v2_period_id
    where record_row.employee_user_id = v_request.user_id
      and v_request.start_date between period_row.period_start and period_row.period_end
      and record_row.status in ('approved', 'finalized')
  ) or exists (
    select 1
    from public.payroll_v2_attendance_snapshots snapshot_row
    join public.payroll_v2_records record_row
      on record_row.id = snapshot_row.payroll_v2_record_id
    where record_row.employee_user_id = v_request.user_id
      and record_row.status <> 'void'
      and (snapshot_row.work_date = v_request.start_date
        or v_request.target_schedule_id = any(snapshot_row.source_schedule_ids))
  ) or exists (
    select 1
    from public.payroll_v2_committed_hours_snapshots snapshot_row
    join public.payroll_v2_records record_row
      on record_row.id = snapshot_row.payroll_v2_record_id
    where record_row.employee_user_id = v_request.user_id
      and record_row.status <> 'void'
      and snapshot_row.work_date = v_request.start_date
  ) then
    raise exception 'This date is protected by Payroll V2 approval, finalization, closure, or a persisted payroll snapshot.';
  end if;

  -- Existing Committed Hours rules freeze only targets already represented in
  -- a non-void V2/V1 result (or a finalized V1 record). Preserve that same
  -- snapshot/cutoff boundary for schedule classification changes.
  if exists (
    select 1
    from public.payroll_prepaid_commitments commitment
    where commitment.employee_id = v_request.user_id
      and commitment.work_date = v_request.start_date
      and commitment.superseded_at is null
      and (
        exists (
          select 1
          from public.payroll_v2_committed_hours_snapshots snapshot_row
          join public.payroll_v2_records record_row
            on record_row.id = snapshot_row.payroll_v2_record_id
          where snapshot_row.commitment_source_id = commitment.id
            and record_row.status <> 'void'
        )
        or exists (
          select 1
          from public.payroll_items item_row
          join public.payroll_records record_row
            on record_row.id = item_row.payroll_record_id
          where item_row.metadata ->> 'commitment_id' = commitment.id::text
            and record_row.status <> 'void'
        )
        or (commitment.payroll_record_id is not null and exists (
          select 1 from public.payroll_records record_row
          where record_row.id = commitment.payroll_record_id
            and record_row.status = 'finalized'
        ))
      )
  ) then
    raise exception 'This date is protected by a Committed Hours snapshot or finalized payroll cutoff.';
  end if;

  -- Revalidate the submission-time invariant after the employee/date advisory
  -- lock and payroll parent locks are held. The INSERT trigger below makes the
  -- actual schedule creation path take the same employee/date lock, so a new
  -- schedule cannot appear between this count and the authoritative save.
  select count(*)::integer into v_active_schedule_count
  from public.work_schedules schedule_row
  where schedule_row.user_id = v_request.user_id
    and schedule_row.shift_date = v_request.start_date
    and schedule_row.status in ('published', 'changed', 'scheduled');
  if v_active_schedule_count <> 1 then
    raise exception 'This date must have exactly one active schedule to be converted.';
  end if;

  select * into v_target
  from public.work_schedules
  where id = v_request.target_schedule_id
  for update;
  if not found
     or v_target.user_id is distinct from v_request.user_id
     or v_target.shift_date is distinct from v_request.start_date then
    raise exception 'The target schedule no longer matches this request.';
  end if;
  if v_target.schedule_version is distinct from v_request.target_schedule_version
     or v_target.updated_at is distinct from v_request.target_schedule_updated_at
     or v_target.status is distinct from v_request.original_schedule_status
     or v_target.shift_start is distinct from v_request.original_shift_start
     or v_target.shift_end is distinct from v_request.original_shift_end
     or v_target.planned_paid_minutes is distinct from v_request.original_planned_paid_minutes then
    raise exception 'The schedule changed after submission. Review the current schedule and submit a new request.';
  end if;
  if v_target.status not in ('published', 'changed')
     or v_target.is_holiday or v_target.is_leave or v_target.is_absent then
    raise exception 'The target is no longer an eligible published schedule.';
  end if;
  if v_target.schedule_template_id is not null
     and (not v_has_assignment
       or v_assignment.template_id is distinct from v_target.schedule_template_id) then
    raise exception 'The target no longer matches its active recurring schedule.';
  end if;

  if v_request.request_type = 'rest_day' then
    if v_target.is_rest_day
       or v_target.shift_start is null
       or v_target.shift_end is null
       or v_request.requested_shift_start is not null
       or v_request.requested_shift_end is not null then
      raise exception 'The request no longer targets one regular timed shift.';
    end if;
  else
    if not v_target.is_rest_day
       or v_target.shift_start is not null
       or v_target.shift_end is not null
       or v_request.requested_shift_start is null
       or v_request.requested_shift_end is null
       or v_request.requested_shift_end <= v_request.requested_shift_start
       or v_request.requested_shift_end - v_request.requested_shift_start > interval '24 hours' then
      raise exception 'The request no longer targets an eligible Rest Day or has invalid times.';
    end if;
  end if;

  if exists (
    select 1 from public.leave_requests request_row
    where request_row.id <> v_request.id
      and request_row.user_id = v_request.user_id
      and request_row.request_category = 'schedule_change'
      and request_row.status = 'pending'
      and (request_row.start_date = v_request.start_date
        or (request_row.request_type = 'rest_day_change'
          and request_row.start_date <= v_request.start_date))
  ) then
    raise exception 'Another pending schedule change conflicts with this date.';
  end if;
  if exists (
    select 1 from public.leave_requests request_row
    where request_row.id <> v_request.id
      and request_row.user_id = v_request.user_id
      and coalesce(request_row.request_category, 'leave') = 'leave'
      and request_row.status in ('pending', 'approved')
      and request_row.start_date <= v_request.start_date
      and request_row.end_date >= v_request.start_date
  ) then
    raise exception 'A pending or approved leave request conflicts with this schedule date.';
  end if;
  if exists (
    select 1 from public.attendance attendance_row
    where attendance_row.user_id = v_request.user_id
      and (attendance_row.work_date = v_request.start_date
        or attendance_row.schedule_id = v_target.id)
      and (attendance_row.voided_at is null
        or attendance_row.payroll_approved_at is not null)
  ) then
    raise exception 'Attendance exists for this work date. Resolve it before applying the schedule request.';
  end if;
  v_timezone := coalesce(nullif(v_target.timezone, ''), 'America/New_York');
  v_notes := format('Approved Schedule Request %s: %s', v_request.id, v_request.reason);
  if v_request.request_type = 'rest_day' then
    v_saved := public.workforce_admin_save_schedule(
      v_target.id, v_request.user_id, v_request.start_date,
      v_target.shift_sequence, null, null, v_timezone, 'published',
      true, false, null, v_notes
    );
  else
    if (v_request.requested_shift_start at time zone v_timezone)::date <> v_request.start_date then
      raise exception 'Regular Shift start must fall on the requested work date.';
    end if;
    v_saved := public.workforce_admin_save_schedule(
      v_target.id, v_request.user_id, v_request.start_date,
      v_target.shift_sequence, v_request.requested_shift_start,
      v_request.requested_shift_end, v_timezone, 'published',
      false, false, null, v_notes
    );
  end if;

  update public.leave_requests
  set status = 'approved', review_notes = v_review_notes,
      reviewed_by = v_actor, reviewed_at = now(), updated_at = now()
  where id = v_request.id
  returning * into v_request;

  insert into public.workforce_audit_logs (
    actor_user_id, action, entity_type, entity_id,
    before_data, after_data, reason
  ) values (
    v_actor, 'schedule_request_approved', 'leave_request', v_request.id,
    jsonb_build_object(
      'status', 'pending', 'request_type', v_request.request_type,
      'schedule_id', v_target.id, 'original_schedule', to_jsonb(v_target),
      'requested_shift_start', v_request.requested_shift_start,
      'requested_shift_end', v_request.requested_shift_end
    ),
    jsonb_build_object(
      'status', 'approved', 'request_type', v_request.request_type,
      'schedule_id', v_saved.id, 'resulting_schedule', to_jsonb(v_saved),
      'review_notes', v_review_notes
    ),
    coalesce(v_review_notes, 'Approved schedule conversion request')
  );

  return v_request;
end;
$$;

revoke all on function public.workforce_apply_schedule_conversion_request(uuid, text)
  from public, anon, authenticated;
grant execute on function public.workforce_apply_schedule_conversion_request(uuid, text)
  to authenticated;

comment on function public.workforce_apply_schedule_conversion_request(uuid, text) is
  'Atomically approves one-date Rest Day and Regular Shift requests through Schedule Management.';

-- Row locks on the submitted schedule do not prevent another schedule with a
-- different sequence from being inserted for the same employee/date. Serialize
-- every schedule insert with conversion approval using its date-level lock.
create or replace function private.workforce_schedule_insert_date_lock()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.user_id::text || ':' || new.shift_date::text, 0)
  );
  return new;
end;
$$;

revoke all on function private.workforce_schedule_insert_date_lock()
  from public, anon, authenticated, service_role;

drop trigger if exists a_work_schedules_conversion_insert_lock
  on public.work_schedules;
create trigger a_work_schedules_conversion_insert_lock
before insert on public.work_schedules
for each row execute function private.workforce_schedule_insert_date_lock();

comment on function private.workforce_schedule_insert_date_lock() is
  'Serializes new schedule rows with Schedule Request date conversions for the same employee and date.';

create or replace function private.workforce_schedule_active_transition_lock()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status in ('published', 'changed', 'scheduled')
     and (
       old.status not in ('published', 'changed', 'scheduled')
       or old.user_id is distinct from new.user_id
       or old.shift_date is distinct from new.shift_date
     )
     and not pg_catalog.pg_try_advisory_xact_lock(
       pg_catalog.hashtextextended(new.user_id::text || ':' || new.shift_date::text, 0)
     ) then
    raise exception 'An active schedule request is being approved for this employee and date. Retry the schedule change.'
      using errcode = '55P03';
  end if;
  return new;
end;
$$;

revoke all on function private.workforce_schedule_active_transition_lock()
  from public, anon, authenticated, service_role;

drop trigger if exists a_work_schedules_conversion_transition_lock
  on public.work_schedules;
create trigger a_work_schedules_conversion_transition_lock
before update of user_id, shift_date, status on public.work_schedules
for each row execute function private.workforce_schedule_active_transition_lock();

comment on function private.workforce_schedule_active_transition_lock() is
  'Serializes activation or reassignment of schedule rows with Schedule Request date conversions without waiting on a row lock cycle.';

commit;
