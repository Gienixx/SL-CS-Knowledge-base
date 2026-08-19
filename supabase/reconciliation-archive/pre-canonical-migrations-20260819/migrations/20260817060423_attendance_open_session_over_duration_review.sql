begin;

-- Keep the normal attendance review lifecycle as the source of truth. This
-- supplemental reason records why an otherwise-pending row needs attention;
-- it does not change timestamps, calculations, or review_status.
alter table public.attendance
  add column if not exists manager_review_reason text;

alter table public.attendance
  drop constraint if exists attendance_manager_review_reason_check;

alter table public.attendance
  add constraint attendance_manager_review_reason_check
  check (manager_review_reason is null or manager_review_reason in ('open_session_over_20_hours'));

comment on column public.attendance.manager_review_reason is
  'Durable supplemental manager-review reason. open_session_over_20_hours is set once when an open session exceeds 1,200 elapsed minutes.';

create or replace function public.workforce_flag_current_open_attendance_over_duration()
returns public.attendance
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile_user_id uuid := public.workforce_current_profile_id();
  v_result public.attendance%rowtype;
  v_now timestamptz := statement_timestamp();
begin
  if auth.uid() is null or not public.workforce_current_user_is_agent() then
    raise exception using errcode = '42501', message = 'Authentication and an active agent profile are required.';
  end if;
  if v_profile_user_id is null then
    raise exception using errcode = '42501', message = 'No workforce profile is linked to the current account.';
  end if;

  update public.attendance
  set manager_review_reason = 'open_session_over_20_hours'
  where public.workforce_is_current_identity(user_id)
    and clock_in is not null
    and clock_out is null
    and manager_review_reason is null
    and voided_at is null
    and clock_in < v_now - interval '20 hours'
  returning * into v_result;

  if v_result.id is null then
    select attendance_row.* into v_result
    from public.attendance attendance_row
    where public.workforce_is_current_identity(attendance_row.user_id)
      and attendance_row.clock_in is not null
      and attendance_row.clock_out is null
    order by attendance_row.clock_in desc
    limit 1;
  end if;

  if v_result.id is null then
    raise exception using errcode = 'P0002', message = 'No open attendance record was found.';
  end if;
  return v_result;
end;
$$;

revoke all on function public.workforce_flag_current_open_attendance_over_duration() from public, anon;
grant execute on function public.workforce_flag_current_open_attendance_over_duration() to authenticated, service_role;

-- A review-only flag must not make imported payroll look stale. The normal
-- attendance version/update triggers still run, but this trigger ignores an
-- update whose only business-field change is manager_review_reason.
create or replace function public.payroll_flag_changed_attendance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := coalesce(
    public.workforce_current_profile_id(),
    new.updated_by,
    old.updated_by
  );
  v_target record;
  v_before public.payroll_records%rowtype;
  v_after public.payroll_records%rowtype;
  v_reason text := format(
    'Attendance changed after import for %s.',
    to_char(new.work_date, 'YYYY-MM-DD')
  );
begin
  if new.manager_review_reason is distinct from old.manager_review_reason
     and (to_jsonb(new) - array['manager_review_reason', 'attendance_version', 'updated_at'])
       = (to_jsonb(old) - array['manager_review_reason', 'attendance_version', 'updated_at']) then
    return new;
  end if;

  for v_target in
    select distinct
      record.id as payroll_record_id,
      record.payroll_period_id
    from public.payroll_attendance_snapshots as snapshot
    join public.payroll_records as record
      on record.id = snapshot.payroll_record_id
    join public.payroll_periods as period
      on period.id = record.payroll_period_id
    where snapshot.attendance_id = new.id
      and snapshot.attendance_version < new.attendance_version
      and period.status not in ('finalized', 'void')
      and record.status not in ('finalized', 'void')
  loop
    select record.*
    into v_before
    from public.payroll_records as record
    where record.id = v_target.payroll_record_id
    for update;

    if not found
       or v_before.status in ('finalized', 'void') then
      continue;
    end if;

    update public.payroll_records
    set
      requires_recalculation = true,
      recalculation_reason = v_reason,
      updated_at = now()
    where id = v_before.id
    returning * into v_after;

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
      'payroll_attendance_changed_after_import',
      'payroll_record',
      v_after.id,
      v_after.payroll_period_id,
      v_after.id,
      jsonb_build_object(
        'requires_recalculation', v_before.requires_recalculation,
        'recalculation_reason', v_before.recalculation_reason
      ),
      jsonb_build_object(
        'requires_recalculation', v_after.requires_recalculation,
        'recalculation_reason', v_after.recalculation_reason
      ),
      v_reason,
      jsonb_build_object(
        'attendance_id', new.id,
        'employee_id', new.user_id,
        'work_date', new.work_date,
        'previous_attendance_version', old.attendance_version,
        'new_attendance_version', new.attendance_version
      )
    );
  end loop;

  return new;
end;
$$;

-- The return shape needs the durable reason so Team Attendance can render the
-- same server-backed result after refresh/reload. The null guard below makes
-- repeated reads idempotent.
drop function if exists public.workforce_list_team_attendance(date, date);

create function public.workforce_list_team_attendance(
  p_start_date date,
  p_end_date date
)
returns table (
  attendance_id uuid, employee_user_id uuid, employee_name text,
  employee_email text, employee_id text, employee_timezone text,
  team_id uuid, team_name text, work_date date, schedule_id uuid,
  shift_sequence smallint, scheduled_start timestamptz, scheduled_end timestamptz,
  schedule_timezone text, schedule_status text, clock_in timestamptz,
  clock_out timestamptz, original_clock_in timestamptz,
  original_clock_out timestamptz, billed_clock_in timestamptz,
  billed_clock_out timestamptz, regular_minutes integer,
  pre_shift_overtime_minutes integer, post_shift_overtime_minutes integer,
  total_overtime_minutes integer, total_worked_minutes integer,
  minutes_late integer, undertime_minutes integer, attendance_status text,
  is_corrected boolean, review_status text, corrected_by uuid,
  corrected_by_name text, corrected_at timestamptz, correction_reason text,
  admin_notes text, is_open boolean, is_missing_clock_out boolean,
  manager_review_reason text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current_profile public.profiles%rowtype;
  v_is_admin boolean := false;
  v_now timestamptz := statement_timestamp();
begin
  if auth.uid() is null or public.workforce_current_profile_id() is null
     or not public.workforce_current_user_is_active() then
    raise exception using errcode = '42501', message = 'Authentication and an active workforce profile are required.';
  end if;
  select profile.* into v_current_profile from public.profiles profile
  where profile.user_id = public.workforce_current_profile_id();
  if not found then raise exception using errcode = '42501', message = 'An active workforce profile is required.'; end if;
  v_is_admin := public.workforce_is_admin();
  if v_is_admin and not public.workforce_has_permission('view_team_attendance') then
    raise exception using errcode = '42501', message = 'You do not have permission to view team attendance.';
  end if;
  if not v_is_admin and v_current_profile.is_agent is not true then
    raise exception using errcode = '42501', message = 'Team attendance is available only to administrators and active agents.';
  end if;
  if p_start_date is null or p_end_date is null then raise exception using errcode = '22004', message = 'Start date and end date are required.'; end if;
  if p_end_date < p_start_date then raise exception using errcode = '22007', message = 'End date cannot be earlier than start date.'; end if;
  if p_end_date - p_start_date > 366 then raise exception using errcode = '22023', message = 'Team attendance date ranges cannot exceed 367 calendar days.'; end if;

  update public.attendance
  set manager_review_reason = 'open_session_over_20_hours'
  where clock_in is not null
    and clock_out is null
    and manager_review_reason is null
    and voided_at is null
    and clock_in < v_now - interval '20 hours';

  return query
  select attendance_row.id, attendance_row.user_id, employee.full_name,
    case when v_is_admin then employee.email else null end,
    case when v_is_admin then employee.employee_id else null end,
    employee.timezone, employee.team_id, employee_team.name,
    attendance_row.work_date, attendance_row.schedule_id, schedule.shift_sequence,
    schedule.shift_start, schedule.shift_end, schedule.timezone, schedule.status,
    attendance_row.clock_in, attendance_row.clock_out,
    case when v_is_admin then attendance_row.original_clock_in else null end,
    case when v_is_admin then attendance_row.original_clock_out else null end,
    case when v_is_admin then attendance_row.billed_clock_in else null end,
    case when v_is_admin then attendance_row.billed_clock_out else null end,
    case when v_is_admin then attendance_row.regular_minutes else null end,
    case when v_is_admin then attendance_row.pre_shift_overtime_minutes else null end,
    case when v_is_admin then attendance_row.post_shift_overtime_minutes else null end,
    case when v_is_admin then attendance_row.total_overtime_minutes else null end,
    case when v_is_admin then attendance_row.total_worked_minutes else null end,
    case when v_is_admin then attendance_row.minutes_late else null end,
    case when v_is_admin then attendance_row.undertime_minutes else null end,
    attendance_row.attendance_status,
    case when v_is_admin then attendance_row.is_corrected else false end,
    case when v_is_admin then attendance_row.review_status else 'pending' end,
    case when v_is_admin then attendance_row.corrected_by else null end,
    case when not v_is_admin or attendance_row.corrected_by is null then null
      when corrector.full_name is not null then corrector.full_name else 'Former workforce user' end,
    case when v_is_admin then attendance_row.corrected_at else null end,
    case when v_is_admin then attendance_row.correction_reason else null end,
    case when v_is_admin then attendance_row.admin_notes else null end,
    attendance_row.clock_in is not null and attendance_row.clock_out is null,
    attendance_row.clock_in is not null and attendance_row.clock_out is null
      and ((schedule.shift_end is not null and schedule.shift_end < v_now)
        or attendance_row.work_date < (v_now at time zone coalesce(nullif(employee.timezone, ''), 'America/New_York'))::date),
    case when v_is_admin then attendance_row.manager_review_reason else null end
  from public.attendance attendance_row
  join public.profiles employee on employee.user_id = attendance_row.user_id
  left join public.teams employee_team on employee_team.id = employee.team_id
  left join public.work_schedules schedule on schedule.id = attendance_row.schedule_id
  left join public.profiles corrector on corrector.user_id = attendance_row.corrected_by
  where attendance_row.work_date between p_start_date and p_end_date
    and attendance_row.voided_at is null
  order by attendance_row.work_date desc, schedule.shift_start desc nulls last,
    attendance_row.clock_in desc nulls last, attendance_row.created_at desc;
end;
$$;

revoke all on function public.workforce_list_team_attendance(date, date) from public, anon, authenticated;
grant execute on function public.workforce_list_team_attendance(date, date) to authenticated, service_role;

comment on function public.workforce_list_team_attendance(date, date) is
  'Returns permission-scoped team attendance and idempotently persists the open-session-over-20-hours manager-review reason.';

commit;
