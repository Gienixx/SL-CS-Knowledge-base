-- Narrow payroll exception approval metadata and optimistic single-row review.
-- The existing exception RPC and approval RPC remain available unchanged.

begin;
create or replace function public.payroll_get_period_exceptions_for_approval(
  p_payroll_period_id uuid
)
returns table (
  exception_key text,
  exception_code text,
  exception_label text,
  severity text,
  is_blocking boolean,
  employee_user_id uuid,
  employee_name text,
  employee_number text,
  work_date date,
  attendance_id uuid,
  schedule_id uuid,
  payroll_record_id uuid,
  message text,
  details jsonb,
  attendance_version bigint,
  attendance_review_status text,
  attendance_readiness_blockers text[],
  total_billed_minutes integer,
  approval_eligible boolean
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
    raise exception using
      errcode = '42501',
      message = 'You do not have permission to review payroll exceptions.';
  end if;

  return query
  with issues as materialized (
    select issue.*
    from public.payroll_get_period_exceptions(p_payroll_period_id) as issue
  ),
  enriched as materialized (
    select
      issue.*,
      attendance_row.attendance_version,
      attendance_row.review_status as attendance_review_status,
      readiness.payroll_readiness_blockers as attendance_readiness_blockers,
      public.workforce_canonical_billed_minutes(
        coalesce(attendance_row.billed_clock_in, attendance_row.clock_in),
        coalesce(attendance_row.billed_clock_out, attendance_row.clock_out)
      ) as total_billed_minutes,
      attendance_row.voided_at,
      readiness.is_payroll_ready,
      exists (
        select 1
        from issues as conflicting_issue
        where conflicting_issue.attendance_id = issue.attendance_id
          and conflicting_issue.exception_code not in (
            'incomplete_attendance',
            'unapproved_attendance'
          )
      ) as has_other_exception,
      exists (
        select 1
        from public.payroll_attendance_snapshots as snapshot
        where snapshot.attendance_id = issue.attendance_id
      ) as has_payroll_snapshot
    from issues as issue
    left join public.attendance as attendance_row
      on attendance_row.id = issue.attendance_id
    left join public.workforce_attendance_payroll_readiness as readiness
      on readiness.id = issue.attendance_id
  )
  select
    issue.exception_key,
    issue.exception_code,
    issue.exception_label,
    issue.severity,
    issue.is_blocking,
    issue.employee_user_id,
    issue.employee_name,
    issue.employee_number,
    issue.work_date,
    issue.attendance_id,
    issue.schedule_id,
    issue.payroll_record_id,
    issue.message,
    issue.details,
    issue.attendance_version,
    issue.attendance_review_status,
    issue.attendance_readiness_blockers,
    issue.total_billed_minutes,
    (
      issue.attendance_id is not null
      and issue.voided_at is null
      and issue.attendance_review_status in ('pending', 'corrected')
      and issue.is_payroll_ready is false
      and coalesce(cardinality(issue.attendance_readiness_blockers), 0) = 1
      and issue.attendance_readiness_blockers[1] = 'review_required'
      and issue.total_billed_minutes is not null
      and not issue.has_other_exception
      and not issue.has_payroll_snapshot
    ) as approval_eligible
  from enriched as issue
  order by
    issue.is_blocking desc,
    issue.work_date nulls first,
    issue.employee_name nulls first,
    issue.exception_label,
    issue.exception_key;
end;
$$;
revoke all on function public.payroll_get_period_exceptions_for_approval(uuid)
  from public, anon;
grant execute on function public.payroll_get_period_exceptions_for_approval(uuid)
  to authenticated, service_role;
comment on function public.payroll_get_period_exceptions_for_approval(uuid) is
  'Returns the existing payroll exceptions with authoritative attendance approval metadata; approval eligibility is computed from the current readiness state and excludes payroll artifacts.';
create or replace function public.workforce_review_attendance_guarded(
  p_attendance_id uuid,
  p_expected_attendance_version bigint,
  p_review_notes text default null
)
returns public.attendance
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attendance public.attendance%rowtype;
  v_readiness record;
begin
  if auth.uid() is null
     or public.workforce_current_profile_id() is null
     or not public.workforce_current_user_is_active() then
    raise exception using
      errcode = '42501',
      message = 'Authenticated workforce profile is required.';
  end if;

  if p_attendance_id is null then
    raise exception 'Attendance record is required.';
  end if;

  if p_expected_attendance_version is null then
    raise exception 'Expected attendance version is required.';
  end if;

  select attendance_row.*
  into v_attendance
  from public.attendance as attendance_row
  where attendance_row.id = p_attendance_id
  for update;

  if not found then
    raise exception 'Attendance record not found.';
  end if;

  if not public.workforce_can_approve_attendance(v_attendance.user_id) then
    raise exception 'You do not have permission to approve this attendance record.';
  end if;

  if v_attendance.attendance_version is distinct from p_expected_attendance_version then
    raise exception using
      errcode = '40001',
      message = 'Attendance changed since it was loaded. Refresh and try again.';
  end if;

  if v_attendance.voided_at is not null then
    raise exception 'Voided attendance cannot be approved.';
  end if;

  if v_attendance.review_status not in ('pending', 'corrected') then
    raise exception 'Only pending or corrected attendance can be approved through the guarded path.';
  end if;

  select
    readiness.is_payroll_ready,
    readiness.payroll_readiness_blockers
  into v_readiness
  from public.workforce_attendance_payroll_readiness as readiness
  where readiness.id = v_attendance.id;

  if not found then
    raise exception 'Attendance readiness could not be verified.';
  end if;

  if v_readiness.is_payroll_ready is not false
     or coalesce(cardinality(v_readiness.payroll_readiness_blockers), 0) <> 1
     or v_readiness.payroll_readiness_blockers[1] is distinct from 'review_required' then
    raise exception 'Attendance is not eligible for guarded approval.';
  end if;

  if public.workforce_canonical_billed_minutes(
       coalesce(v_attendance.billed_clock_in, v_attendance.clock_in),
       coalesce(v_attendance.billed_clock_out, v_attendance.clock_out)
     ) is null then
    raise exception 'Completed billed clock-in and billed clock-out values are required before approval.';
  end if;

  if exists (
    select 1
    from public.payroll_attendance_snapshots as snapshot
    where snapshot.attendance_id = v_attendance.id
  ) then
    raise exception 'Attendance already has a payroll snapshot and must be revalidated through payroll.';
  end if;

  -- The existing RPC retains all permission, canonical-total, trigger, and
  -- audit behavior. The row lock above makes the version/readiness check and
  -- this approval one transactionally guarded operation.
  return public.workforce_review_attendance(
    p_attendance_id,
    'approved',
    p_review_notes
  );
end;
$$;
revoke all on function public.workforce_review_attendance_guarded(uuid, bigint, text)
  from public, anon;
grant execute on function public.workforce_review_attendance_guarded(uuid, bigint, text)
  to authenticated, service_role;
comment on function public.workforce_review_attendance_guarded(uuid, bigint, text) is
  'Approves one attendance row only when its expected version and current approval-only readiness state still match; delegates the mutation and audit to workforce_review_attendance.';
commit;
