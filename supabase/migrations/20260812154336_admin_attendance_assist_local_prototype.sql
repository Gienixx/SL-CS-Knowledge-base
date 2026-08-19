-- Local-only Admin Assist prototype for Attendance.
-- Do not apply this migration to production until the prototype is approved.

begin;

create or replace function public.workforce_admin_assist_list_employees()
returns table (
  user_id uuid,
  full_name text,
  team_name text,
  timezone text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.workforce_is_authorized_attendance_admin('correct_attendance') then
    raise exception 'Admin attendance permission is required.';
  end if;

  return query
  select profile.user_id, profile.full_name, team.name, profile.timezone
  from public.profiles profile
  left join public.teams team on team.id = profile.team_id
  where profile.is_agent is true
    and profile.employment_status in ('active', 'on_leave')
  order by profile.full_name, profile.user_id;
end;
$$;

create or replace function public.workforce_admin_assist_snapshot(
  p_target_user_id uuid,
  p_start_date date,
  p_end_date date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_result jsonb;
begin
  if not public.workforce_is_authorized_attendance_admin('correct_attendance') then
    raise exception 'Admin attendance permission is required.';
  end if;
  if p_target_user_id is null then
    raise exception 'Target employee is required.';
  end if;
  if p_start_date is null or p_end_date is null or p_end_date < p_start_date then
    raise exception 'A valid attendance date range is required.';
  end if;
  if p_end_date - p_start_date > 366 then
    raise exception 'Attendance date ranges cannot exceed 367 calendar days.';
  end if;

  select * into v_profile
  from public.profiles
  where user_id = p_target_user_id
    and is_agent is true
    and employment_status in ('active', 'on_leave');
  if not found then
    raise exception 'Target employee was not found or is not an agent.';
  end if;

  select jsonb_build_object(
    'employee', jsonb_build_object(
      'user_id', v_profile.user_id,
      'full_name', v_profile.full_name,
      'timezone', v_profile.timezone
    ),
    'schedules', coalesce((
      select jsonb_agg(to_jsonb(schedule) order by schedule.shift_date, schedule.shift_sequence)
      from public.work_schedules schedule
      where schedule.user_id = p_target_user_id
        and schedule.shift_date between p_start_date and p_end_date
        and schedule.status in ('published', 'changed')
    ), '[]'::jsonb),
    'attendance', coalesce((
      select jsonb_agg(
        to_jsonb(attendance_row) || jsonb_build_object(
          'work_schedules', case when schedule.id is null then null else to_jsonb(schedule) end
        ) order by attendance_row.work_date desc, attendance_row.created_at desc
      )
      from public.attendance attendance_row
      left join public.work_schedules schedule on schedule.id = attendance_row.schedule_id
      where attendance_row.user_id = p_target_user_id
        and attendance_row.work_date between p_start_date and p_end_date
    ), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(row_to_json(history_row)::jsonb order by history_row.work_date desc, history_row.schedule_start desc nulls last, history_row.clock_in desc nulls last)
      from (
        select
          attendance_row.id as attendance_id,
          attendance_row.schedule_id,
          attendance_row.work_date,
          attendance_row.clock_in,
          attendance_row.clock_out,
          attendance_row.attendance_status,
          attendance_row.review_status,
          attendance_row.is_late,
          attendance_row.minutes_late,
          attendance_row.overtime_minutes,
          attendance_row.regular_minutes,
          attendance_row.pre_shift_overtime_minutes,
          attendance_row.post_shift_overtime_minutes,
          attendance_row.rest_day_overtime_minutes,
          attendance_row.holiday_overtime_minutes,
          attendance_row.total_overtime_minutes,
          attendance_row.total_worked_minutes,
          attendance_row.undertime_minutes,
          attendance_row.correction_reason,
          attendance_row.corrected_at,
          attendance_row.created_at,
          attendance_row.updated_at,
          schedule.shift_start as schedule_start,
          schedule.shift_end as schedule_end,
          schedule.timezone as schedule_timezone,
          schedule.status as schedule_status,
          coalesce(schedule.is_rest_day, false) as schedule_is_rest_day,
          coalesce(schedule.is_holiday, false) as schedule_is_holiday,
          schedule.holiday_name,
          false as is_prepaid_schedule,
          null::integer as prepaid_minutes,
          coalesce(allocation_totals.fulfilled_minutes, 0)::integer as fulfilled_prepaid_minutes,
          greatest(
            case when attendance_row.review_status in ('approved', 'locked')
              and attendance_row.clock_out is not null
              then greatest(coalesce(attendance_row.regular_minutes, 0), 0)
                + greatest(coalesce(attendance_row.pre_shift_overtime_minutes, 0), 0)
                + greatest(coalesce(attendance_row.post_shift_overtime_minutes, 0), 0)
              else 0 end - coalesce(allocation_totals.fulfilled_minutes, 0),
            0
          )::integer as regular_payable_minutes,
          null::text as prepaid_status
        from public.attendance attendance_row
        left join public.work_schedules schedule on schedule.id = attendance_row.schedule_id
        left join lateral (
          select sum(case when allocation.allocation_type = 'settlement'
                          then allocation.allocated_minutes else -allocation.allocated_minutes end)::integer as fulfilled_minutes
          from public.payroll_attendance_snapshots snapshot
          join public.payroll_hour_allocations allocation
            on allocation.attendance_snapshot_id = snapshot.id
           and allocation.employee_id = snapshot.employee_id
          where snapshot.attendance_id = attendance_row.id
            and snapshot.employee_id = p_target_user_id
        ) allocation_totals on true
        where attendance_row.user_id = p_target_user_id
          and attendance_row.work_date between p_start_date and p_end_date
      ) history_row
    ), '[]'::jsonb),
    'prepaid_balances', coalesce((
      select jsonb_agg(jsonb_build_object(
        'work_date', snapshot.work_date,
        'prepaid_clock_in', snapshot.shift_start,
        'prepaid_clock_out', snapshot.shift_end,
        'timezone', snapshot.timezone,
        'prepaid_minutes', prepaid.prepaid_minutes,
        'settled_minutes', prepaid.settled_minutes,
        'remaining_minutes', prepaid.remaining_minutes,
        'prepaid_status', prepaid.status
      ) order by snapshot.work_date desc, snapshot.shift_start desc nulls last)
      from public.payroll_prepaid_hours prepaid
      join public.payroll_schedule_snapshots snapshot
        on snapshot.id = prepaid.source_schedule_snapshot_id
       and snapshot.employee_id = prepaid.employee_id
      where prepaid.employee_id = p_target_user_id
        and prepaid.voided_at is null
        and prepaid.remaining_minutes > 0
        and snapshot.work_date between p_start_date and p_end_date
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

create or replace function public.workforce_admin_assist_clock_in(
  p_target_user_id uuid,
  p_schedule_id uuid,
  p_work_date date,
  p_reason text
)
returns public.attendance
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_schedule public.work_schedules%rowtype;
  v_existing public.attendance%rowtype;
  v_result public.attendance%rowtype;
begin
  if not public.workforce_is_authorized_attendance_admin('correct_attendance') then
    raise exception 'Admin attendance permission is required.';
  end if;
  if p_target_user_id is null or p_work_date is null then
    raise exception 'Target employee and work date are required.';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then
    raise exception 'A reason is required for Admin Assist.';
  end if;
  perform 1 from public.profiles where user_id = p_target_user_id and is_agent is true and employment_status in ('active', 'on_leave');
  if not found then raise exception 'Target employee was not found.'; end if;
  if p_schedule_id is not null then
    select * into v_schedule from public.work_schedules where id = p_schedule_id and user_id = p_target_user_id;
    if not found or v_schedule.shift_date <> p_work_date or v_schedule.status not in ('published', 'changed') then
      raise exception 'Selected schedule does not belong to the target employee.';
    end if;
  end if;
  select * into v_existing from public.attendance
  where user_id = p_target_user_id and clock_in is not null and clock_out is null
  order by clock_in desc limit 1 for update;
  if found then raise exception 'The target employee already has an open attendance session.'; end if;

  insert into public.attendance(user_id, schedule_id, work_date, clock_in, attendance_status, created_by, updated_by)
  values (p_target_user_id, p_schedule_id, p_work_date, now(), 'present', v_actor, v_actor)
  returning * into v_result;
  v_result := public.workforce_recalculate_attendance(v_result.id);
  insert into public.workforce_audit_logs(actor_user_id, action, entity_type, entity_id, after_data, reason)
  values (v_actor, 'admin_assisted_clock_in', 'attendance', v_result.id,
    jsonb_build_object('target_employee_id', p_target_user_id, 'action', 'clock-in', 'timestamp', v_result.clock_in, 'schedule_id', p_schedule_id, 'work_date', p_work_date, 'audit_source', 'admin_assisted_clock_in'), trim(p_reason));
  return v_result;
end;
$$;

create or replace function public.workforce_admin_assist_clock_out(
  p_target_user_id uuid,
  p_reason text
)
returns public.attendance
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_existing public.attendance%rowtype;
  v_result public.attendance%rowtype;
begin
  if not public.workforce_is_authorized_attendance_admin('correct_attendance') then
    raise exception 'Admin attendance permission is required.';
  end if;
  if p_target_user_id is null or length(trim(coalesce(p_reason, ''))) < 5 then
    raise exception 'Target employee and reason are required for Admin Assist.';
  end if;
  select * into v_existing from public.attendance
  where user_id = p_target_user_id and clock_in is not null and clock_out is null
  order by clock_in desc limit 1 for update;
  if not found then raise exception 'No open attendance record was found for the target employee.'; end if;
  update public.attendance set clock_out = now(), updated_by = v_actor where id = v_existing.id returning * into v_result;
  v_result := public.workforce_recalculate_attendance(v_result.id);
  insert into public.workforce_audit_logs(actor_user_id, action, entity_type, entity_id, before_data, after_data, reason)
  values (v_actor, 'admin_assisted_clock_out', 'attendance', v_result.id, to_jsonb(v_existing),
    jsonb_build_object('target_employee_id', p_target_user_id, 'action', 'clock-out', 'timestamp', v_result.clock_out, 'audit_source', 'admin_assisted_clock_out'), trim(p_reason));
  return v_result;
end;
$$;

revoke all on function public.workforce_admin_assist_list_employees() from public, anon, authenticated;

revoke all on function public.workforce_admin_assist_snapshot(uuid, date, date) from public, anon, authenticated;

revoke all on function public.workforce_admin_assist_clock_in(uuid, uuid, date, text) from public, anon, authenticated;

revoke all on function public.workforce_admin_assist_clock_out(uuid, text) from public, anon, authenticated;

grant execute on function public.workforce_admin_assist_list_employees() to authenticated;

grant execute on function public.workforce_admin_assist_snapshot(uuid, date, date) to authenticated;

grant execute on function public.workforce_admin_assist_clock_in(uuid, uuid, date, text) to authenticated;

grant execute on function public.workforce_admin_assist_clock_out(uuid, text) to authenticated;

comment on function public.workforce_admin_assist_list_employees() is 'Local Admin Assist prototype: lists active employees only for authorized attendance administrators.';

comment on function public.workforce_admin_assist_snapshot(uuid, date, date) is 'Local Admin Assist prototype: employee-scoped Attendance snapshot for authorized administrators.';

comment on function public.workforce_admin_assist_clock_in(uuid, uuid, date, text) is 'Local Admin Assist prototype: audited target clock-in; does not impersonate the employee.';

comment on function public.workforce_admin_assist_clock_out(uuid, text) is 'Local Admin Assist prototype: audited target clock-out; does not change correction behavior.';

commit;
