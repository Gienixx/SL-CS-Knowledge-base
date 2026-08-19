-- Keep voided attendance rows for audit/history while removing them from every
-- operational attendance path. Function replacements start from the live
-- definitions and change only active-row predicates.

begin;

drop index if exists public.attendance_user_schedule_unique;
create unique index attendance_user_schedule_unique
  on public.attendance (user_id, schedule_id)
  where schedule_id is not null and voided_at is null;

drop index if exists public.attendance_one_open_session_per_user_idx;
create unique index attendance_one_open_session_per_user_idx
  on public.attendance (user_id)
  where clock_in is not null and clock_out is null and voided_at is null;

do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := pg_get_functiondef('public.workforce_clock_in(uuid)'::regprocedure);
  v_updated := replace(
    v_definition,
    'where a.user_id = v_profile_user_id',
    'where a.user_id = v_profile_user_id
      and a.voided_at is null'
  );
  if v_updated = v_definition then
    raise exception 'workforce_clock_in live definition did not contain its attendance predicates';
  end if;
  execute v_updated;
end;
$$;

create or replace function public.workforce_list_voided_team_attendance(
  p_start_date date,
  p_end_date date
)
returns table (
  attendance_id uuid,
  employee_user_id uuid,
  employee_name text,
  employee_id text,
  employee_email text,
  employee_timezone text,
  work_date date,
  schedule_id uuid,
  shift_sequence smallint,
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  schedule_timezone text,
  clock_in timestamptz,
  clock_out timestamptz,
  original_clock_in timestamptz,
  original_clock_out timestamptz,
  billed_clock_in timestamptz,
  billed_clock_out timestamptz,
  attendance_status text,
  review_status text,
  regular_minutes integer,
  total_overtime_minutes integer,
  total_worked_minutes integer,
  voided_at timestamptz,
  voided_by uuid,
  voided_by_name text,
  void_reason text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_is_admin()
     or not public.workforce_has_permission('view_team_attendance') then
    raise exception using errcode = '42501', message = 'Administrator Team Attendance access is required.';
  end if;
  if p_start_date is null or p_end_date is null then
    raise exception using errcode = '22004', message = 'Start date and end date are required.';
  end if;
  if p_end_date < p_start_date then
    raise exception using errcode = '22007', message = 'End date cannot be earlier than start date.';
  end if;
  if p_end_date - p_start_date > 366 then
    raise exception using errcode = '22023', message = 'Team attendance date ranges cannot exceed 367 calendar days.';
  end if;

  return query
  select
    attendance_row.id,
    attendance_row.user_id,
    employee.full_name,
    employee.employee_id,
    employee.email,
    employee.timezone,
    attendance_row.work_date,
    attendance_row.schedule_id,
    schedule.shift_sequence,
    schedule.shift_start,
    schedule.shift_end,
    schedule.timezone,
    attendance_row.clock_in,
    attendance_row.clock_out,
    attendance_row.original_clock_in,
    attendance_row.original_clock_out,
    attendance_row.billed_clock_in,
    attendance_row.billed_clock_out,
    attendance_row.attendance_status,
    attendance_row.review_status,
    attendance_row.regular_minutes,
    attendance_row.total_overtime_minutes,
    attendance_row.total_worked_minutes,
    attendance_row.voided_at,
    attendance_row.voided_by,
    voider.full_name,
    attendance_row.void_reason
  from public.attendance attendance_row
  join public.profiles employee on employee.user_id = attendance_row.user_id
  left join public.work_schedules schedule on schedule.id = attendance_row.schedule_id
  left join public.profiles voider on voider.user_id = attendance_row.voided_by
  where attendance_row.work_date between p_start_date and p_end_date
    and public.workforce_can_manage_user(
      attendance_row.user_id,
      'view_team_attendance'
    )
    and attendance_row.voided_at is not null
  order by attendance_row.work_date desc, attendance_row.voided_at desc;
end;
$$;

revoke all on function public.workforce_list_voided_team_attendance(date, date) from public, anon, authenticated;
grant execute on function public.workforce_list_voided_team_attendance(date, date) to authenticated, service_role;

create or replace function public.workforce_restore_attendance(
  p_attendance_id uuid,
  p_reason text
)
returns public.attendance
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_old public.attendance%rowtype;
  v_result public.attendance%rowtype;
  v_schedule public.work_schedules%rowtype;
  v_previous_review_status text;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if v_actor is null or not public.workforce_current_user_is_active()
     or not public.workforce_is_admin()
     or not (public.workforce_has_permission('manage_schedules')
       or public.workforce_has_permission('correct_attendance')) then
    raise exception 'You do not have permission to restore attendance records.';
  end if;
  if p_attendance_id is null then raise exception 'Attendance record is required.'; end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'A restore reason of at least 3 characters is required.';
  end if;

  select * into v_old
  from public.attendance
  where id = p_attendance_id
  for update;
  if not found then raise exception 'Attendance record not found.'; end if;
  perform pg_advisory_xact_lock(hashtext(v_old.user_id::text)::bigint);
  if v_old.voided_at is null then raise exception 'This attendance record is not voided.'; end if;
  if not public.workforce_can_manage_user(v_old.user_id, 'correct_attendance')
     and not public.workforce_can_manage_user(v_old.user_id, 'manage_schedules') then
    raise exception 'You do not have permission to manage this employee.';
  end if;
  if v_old.review_status = 'locked' then
    raise exception 'A finalized attendance record cannot be restored.';
  end if;
  if v_old.schedule_id is not null then
    select * into v_schedule
    from public.work_schedules
    where id = v_old.schedule_id
    for share;
    if not found then
      raise exception 'This attendance cannot be restored because its linked schedule no longer exists.';
    end if;
    if v_schedule.user_id <> v_old.user_id then
      raise exception 'This attendance cannot be restored because its linked schedule belongs to another employee.';
    end if;
    if v_schedule.shift_date not in (v_old.work_date, v_old.work_date - 1) then
      raise exception 'This attendance cannot be restored because its linked schedule is outside the allowed work-date relationship.';
    end if;
    if v_schedule.is_leave or v_schedule.is_absent then
      raise exception 'This attendance cannot be restored because its linked schedule is a leave or absence schedule.';
    end if;
    if v_schedule.status not in ('published', 'changed', 'completed') then
      raise exception 'This attendance cannot be restored because its linked schedule is no longer active.';
    end if;
  end if;
  if exists (
    select 1
    from public.payroll_attendance_snapshots snapshot
    join public.payroll_records record on record.id = snapshot.payroll_record_id
    where snapshot.attendance_id = v_old.id
      and record.status = 'finalized'
  ) or exists (
    select 1
    from public.payroll_periods period
    where v_old.work_date between period.period_start and period.period_end
      and period.status = 'finalized'
  ) then
    raise exception 'This attendance record cannot be restored because the affected payroll is finalized.';
  end if;
  if v_old.schedule_id is not null and exists (
    select 1
    from public.attendance other_attendance
    where other_attendance.id <> v_old.id
      and other_attendance.user_id = v_old.user_id
      and other_attendance.schedule_id = v_old.schedule_id
      and other_attendance.voided_at is null
  ) then
    raise exception 'This attendance cannot be restored because another active attendance already uses the same schedule.';
  end if;
  if exists (
    select 1
    from public.attendance other_attendance
    where other_attendance.id <> v_old.id
      and other_attendance.user_id = v_old.user_id
      and other_attendance.voided_at is null
      and coalesce(other_attendance.billed_clock_in, other_attendance.clock_in) is not null
      and coalesce(other_attendance.billed_clock_out, other_attendance.clock_out) is null
  ) then
    raise exception 'This attendance cannot be restored while another attendance session is open for the employee.';
  end if;

  select nullif(log.before_data->>'review_status', '')
    into v_previous_review_status
  from public.workforce_audit_logs log
  where log.entity_type = 'attendance'
    and log.entity_id = v_old.id
    and log.action = 'attendance_deleted'
  order by log.created_at desc
  limit 1;

  insert into public.workforce_audit_logs
    (actor_user_id, action, entity_type, entity_id, before_data, after_data, reason, metadata)
  values
    (v_actor, 'attendance_restored', 'attendance', v_old.id, to_jsonb(v_old),
     jsonb_build_object(
       'target_employee_id', v_old.user_id,
       'restored', true,
       'previous_void_reason', v_old.void_reason,
       'restore_reason', v_reason
     ), v_reason,
     jsonb_build_object('target_employee_id', v_old.user_id, 'attendance_id', v_old.id));

  update public.attendance
  set voided_at = null,
      voided_by = null,
      void_reason = null,
      review_status = case
        when v_previous_review_status in ('pending', 'approved', 'corrected', 'rejected')
          then v_previous_review_status
        else 'pending'
      end,
      updated_by = v_actor,
      updated_at = statement_timestamp()
  where id = v_old.id and voided_at is not null
  returning * into v_result;
  if not found then raise exception 'Attendance restore could not be completed.'; end if;

  v_result := public.workforce_recalculate_attendance(v_result.id);
  return v_result;
end;
$$;

revoke all on function public.workforce_restore_attendance(uuid, text) from public, anon, authenticated;
grant execute on function public.workforce_restore_attendance(uuid, text) to authenticated, service_role;
comment on function public.workforce_restore_attendance(uuid, text) is
  'Restores a voided attendance row only for an authorized manager, preserving the row and requiring conflict and finalized-payroll checks.';

do $$
declare
  v_signature text;
  v_definition text;
  v_updated text;
begin
  foreach v_signature in array array[
    'public.workforce_assign_attendance_schedule(uuid,uuid,text,text)',
    'public.workforce_correct_attendance(uuid,timestamptz,timestamptz,text,uuid,text,text,text)'
  ] loop
    if to_regprocedure(v_signature) is null then continue; end if;
    v_definition := pg_get_functiondef(v_signature::regprocedure);
    v_updated := replace(
      v_definition,
      'if not found then raise exception ''Attendance record not found.''; end if;',
      'if not found then raise exception ''Attendance record not found.''; end if;
  if v_old.voided_at is not null then raise exception ''Voided attendance must be restored before it can be changed.''; end if;'
    );
    if v_updated = v_definition then
      raise exception '% live definition was not guarded against changing voided attendance', v_signature;
    end if;
    execute v_updated;
  end loop;
end;
$$;

do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := pg_get_functiondef(
    'public.workforce_correct_attendance_legacy(uuid,timestamptz,timestamptz,text,uuid,text,text,text)'::regprocedure
  );
  v_updated := replace(
    v_definition,
    '  if p_schedule_id is not null then',
    '  if v_attendance.voided_at is not null then
    raise exception ''Voided attendance must be restored before it can be changed.'';
  end if;

  if p_schedule_id is not null then'
  );
  if v_updated = v_definition then
    raise exception 'workforce_correct_attendance_legacy live definition was not guarded against changing voided attendance';
  end if;
  execute v_updated;
end;
$$;

do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := pg_get_functiondef('public.workforce_clock_out(text,uuid,uuid)'::regprocedure);
  v_updated := replace(
    v_definition,
    'and attendance_row.clock_out is null',
    'and attendance_row.clock_out is null
    and attendance_row.voided_at is null'
  );
  if v_updated = v_definition then
    raise exception 'workforce_clock_out live definition did not contain its open-session predicate';
  end if;
  execute v_updated;
end;
$$;

do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := pg_get_functiondef('public.workforce_admin_assist_clock_out(uuid,text)'::regprocedure);
  v_updated := replace(
    v_definition,
    'where user_id = p_target_user_id and clock_in is not null and clock_out is null',
    'where user_id = p_target_user_id
    and clock_in is not null
    and clock_out is null
    and voided_at is null'
  );
  if v_updated = v_definition then
    raise exception 'workforce_admin_assist_clock_out live definition did not contain its open-session predicate';
  end if;
  execute v_updated;
end;
$$;

do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := pg_get_functiondef('public.workforce_reject_attended_leave_schedule()'::regprocedure);
  v_updated := replace(
    v_definition,
    'where attendance_row.schedule_id = new.id',
    'where attendance_row.schedule_id = new.id
         and attendance_row.voided_at is null'
  );
  if v_updated = v_definition then
    raise exception 'workforce_reject_attended_leave_schedule live definition did not contain its attendance predicate';
  end if;
  execute v_updated;
end;
$$;

do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := pg_get_functiondef('public.payroll_assert_ready_for_approval(uuid)'::regprocedure);
  v_updated := replace(
    v_definition,
    'on attendance_row.id = snapshot.attendance_id',
    'on attendance_row.id = snapshot.attendance_id
     and attendance_row.voided_at is null'
  );
  if v_updated = v_definition then
    raise exception 'payroll_assert_ready_for_approval live definition did not contain its attendance snapshot predicate';
  end if;
  execute v_updated;
end;
$$;

do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := pg_get_functiondef('public.payroll_get_period_attendance_import_status(uuid)'::regprocedure);
  v_updated := replace(
    v_definition,
    'on attendance_row.id = snapshot.attendance_id',
    'on attendance_row.id = snapshot.attendance_id
     and attendance_row.voided_at is null'
  );
  v_updated := replace(v_updated, 'count(distinct snapshot.attendance_id) filter (', 'count(distinct attendance_row.id) filter (');
  v_updated := replace(v_updated, 'count(distinct snapshot.attendance_id),', 'count(distinct attendance_row.id),');
  if v_updated = v_definition then
    raise exception 'payroll_get_period_attendance_import_status live definition did not contain its attendance snapshot predicate';
  end if;
  execute v_updated;
end;
$$;

do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := pg_get_functiondef('public.payroll_import_attendance(uuid,uuid)'::regprocedure);
  v_updated := replace(
    v_definition,
    'on attendance_row.user_id = record.employee_id
     and attendance_row.work_date',
    'on attendance_row.user_id = record.employee_id
     and attendance_row.voided_at is null
     and attendance_row.work_date'
  );
  v_updated := replace(
    v_updated,
    'on attendance_row.id = snapshot.attendance_id
   and attendance_row.attendance_version',
    'on attendance_row.id = snapshot.attendance_id
   and attendance_row.voided_at is null
   and attendance_row.attendance_version'
  );
  if v_updated = v_definition then
    raise exception 'payroll_import_attendance live definition did not contain an attendance source predicate';
  end if;
  execute v_updated;
end;
$$;

do $$
declare
  v_signature text;
  v_definition text;
  v_updated text;
begin
  foreach v_signature in array array[
    'public.payroll_approve_preplots(uuid,uuid[],text)',
    'public.payroll_get_period_employee_readiness(uuid)',
    'public.payroll_get_period_employee_readiness_base(uuid)',
    'public.payroll_get_period_missing_attendance_base(uuid)',
    'public.payroll_get_preplot_candidates(uuid)',
    'public.payroll_import_attendance(uuid,uuid)'
  ] loop
    v_definition := pg_get_functiondef(v_signature::regprocedure);
    v_updated := v_definition;
    if v_signature = 'public.payroll_get_period_employee_readiness(uuid)' then
      v_updated := replace(
        v_updated,
        'where attendance_row.user_id = snapshot.employee_id',
        'where attendance_row.user_id = snapshot.employee_id
          and attendance_row.voided_at is null'
      );
    elsif v_signature = 'public.payroll_get_period_employee_readiness_base(uuid)' then
      v_updated := replace(
        v_updated,
        'where attendance_row.user_id = profile.user_id
              and attendance_row.schedule_id = schedule.id',
        'where attendance_row.user_id = profile.user_id
              and attendance_row.schedule_id = schedule.id
              and attendance_row.voided_at is null'
      );
    else
      v_updated := replace(
        v_updated,
        'and attendance_row.schedule_id = schedule.id',
        'and attendance_row.schedule_id = schedule.id
          and attendance_row.voided_at is null'
      );
    end if;
    if v_updated = v_definition then
      raise exception '% live definition did not contain an attendance/schedule predicate', v_signature;
    end if;
    execute v_updated;
  end loop;
end;
$$;

do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := pg_get_functiondef(
    'public.payroll_save_and_approve_prepaid_schedule(uuid,uuid,date,time without time zone,time without time zone,text,text,boolean)'::regprocedure
  );
  v_updated := replace(
    v_definition,
    'where attendance_row.user_id = p_employee_id',
    'where attendance_row.user_id = p_employee_id
      and attendance_row.voided_at is null'
  );
  if v_updated = v_definition then
    raise exception 'payroll_save_and_approve_prepaid_schedule live definition did not contain its attendance predicate';
  end if;
  execute v_updated;
end;
$$;

do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := pg_get_functiondef('public.payroll_capture_snapshot_special_details()'::regprocedure);
  v_updated := replace(
    v_definition,
    'and attendance_row.attendance_version = new.attendance_version;',
    'and attendance_row.attendance_version = new.attendance_version
    and attendance_row.voided_at is null;'
  );
  if v_updated = v_definition then
    raise exception 'payroll_capture_snapshot_special_details live definition did not contain its attendance predicate';
  end if;
  execute v_updated;
end;
$$;

do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := pg_get_functiondef('public.payroll_get_period_exceptions_base(uuid)'::regprocedure);
  v_updated := replace(
    v_definition,
    'on attendance_row.user_id = record.employee_id',
    'on attendance_row.user_id = record.employee_id
     and attendance_row.voided_at is null'
  );
  v_updated := replace(
    v_updated,
    'on attendance_row.id = snapshot.attendance_id',
    'on attendance_row.id = snapshot.attendance_id
     and attendance_row.voided_at is null'
  );
  if v_updated = v_definition then
    raise exception 'payroll_get_period_exceptions_base live definition did not contain its attendance predicates';
  end if;
  execute v_updated;
end;
$$;

do $$
declare
  v_signature text;
  v_definition text;
  v_updated text;
begin
  foreach v_signature in array array[
    'public.workforce_admin_assist_clock_in(uuid,uuid,date,text,timestamptz)',
    'public.workforce_admin_assist_snapshot(uuid,date,date)'
  ] loop
    if to_regprocedure(v_signature) is null then continue; end if;
    v_definition := pg_get_functiondef(v_signature::regprocedure);
    v_updated := replace(
      v_definition,
      'where user_id = p_target_user_id',
      'where user_id = p_target_user_id
      and voided_at is null'
    );
    v_updated := replace(
      v_updated,
      'where attendance_row.user_id = p_target_user_id',
      'where attendance_row.user_id = p_target_user_id
        and attendance_row.voided_at is null'
    );
    if v_updated = v_definition then
      raise exception '% live definition did not contain its attendance predicates', v_signature;
    end if;
    execute v_updated;
  end loop;
end;
$$;

do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := pg_get_functiondef('public.workforce_list_my_attendance_log(date,date)'::regprocedure);
  v_updated := replace(
    v_definition,
    'where attendance_row.user_id = v_employee_id',
    'where attendance_row.user_id = v_employee_id
      and attendance_row.voided_at is null'
  );
  if v_updated = v_definition then
    raise exception 'workforce_list_my_attendance_log live definition did not contain its attendance predicates';
  end if;
  execute v_updated;
end;
$$;

do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := pg_get_functiondef('public.workforce_list_team_attendance_prepaid(date,date)'::regprocedure);
  v_updated := replace(
    v_definition,
    'where attendance_row.work_date between p_start_date and p_end_date',
    'where attendance_row.voided_at is null
    and attendance_row.work_date between p_start_date and p_end_date'
  );
  if v_updated = v_definition then
    raise exception 'workforce_list_team_attendance_prepaid live definition did not contain its attendance predicate';
  end if;
  execute v_updated;
end;
$$;

do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := pg_get_functiondef('public.workforce_recalculate_attendance(uuid)'::regprocedure);
  v_updated := replace(
    v_definition,
    '  v_clock_in := coalesce(v_attendance.billed_clock_in, v_attendance.clock_in);',
    '  if v_attendance.voided_at is not null then
    return v_attendance;
  end if;

  v_clock_in := coalesce(v_attendance.billed_clock_in, v_attendance.clock_in);'
  );
  v_updated := replace(
    v_updated,
    'and a.id <> v_attendance.id
      and coalesce(a.billed_clock_in, a.clock_in) is not null',
    'and a.id <> v_attendance.id
      and a.voided_at is null
      and coalesce(a.billed_clock_in, a.clock_in) is not null'
  );
  v_updated := replace(
    v_updated,
    'where a.user_id = v_attendance.user_id and a.work_date = v_attendance.work_date and a.id <> v_attendance.id;',
    'where a.user_id = v_attendance.user_id and a.work_date = v_attendance.work_date
    and a.id <> v_attendance.id
    and a.voided_at is null;'
  );
  if position('v_attendance.voided_at is not null' in v_updated) = 0
     or position('a.voided_at is null' in v_updated) = 0 then
    raise exception 'workforce_recalculate_attendance live definition was not safely updated';
  end if;
  execute v_updated;
end;
$$;

do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := pg_get_functiondef('public.workforce_recalculate_attendance_work_date(uuid,date)'::regprocedure);
  v_updated := replace(
    v_definition,
    'where user_id = p_user_id
    and work_date = p_work_date',
    'where user_id = p_user_id
    and work_date = p_work_date
    and voided_at is null'
  );
  v_updated := replace(
    v_updated,
    'where attendance_row.user_id = p_user_id
      and attendance_row.work_date = p_work_date',
    'where attendance_row.user_id = p_user_id
      and attendance_row.work_date = p_work_date
      and attendance_row.voided_at is null'
  );
  if v_updated = v_definition then
    raise exception 'workforce_recalculate_attendance_work_date live definition did not contain its attendance predicates';
  end if;
  execute v_updated;
end;
$$;

do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := pg_get_viewdef('public.workforce_attendance_payroll_readiness'::regclass, true);
  v_updated := regexp_replace(
    v_definition,
    '(left join[[:space:]]+work_schedules[[:space:]]+schedule_row[[:space:]]+on[[:space:]]+schedule_row[.]id[[:space:]]*=[[:space:]]*attendance_row[.]schedule_id)',
    E'\\1\n  where attendance_row.voided_at is null',
    1,
    1,
    'i'
  );
  if v_updated = v_definition then
    raise exception 'workforce_attendance_payroll_readiness view did not contain its attendance source';
  end if;
  execute 'create or replace view public.workforce_attendance_payroll_readiness with (security_invoker = true) as ' || v_updated;
end;
$$;

commit;
