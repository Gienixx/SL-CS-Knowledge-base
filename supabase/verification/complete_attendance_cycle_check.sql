-- Phase 1 Step 17: complete attendance-cycle verification.
--
-- This script is safe for the live internal workforce database. It creates
-- one-off Test-account records inside a PL/pgSQL subtransaction, captures the
-- results, and deliberately rolls the subtransaction back. Existing schedules
-- and recurring automation are checksummed before and after the cycle.

begin;

create or replace function pg_temp.run_complete_attendance_cycle()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_test public.profiles%rowtype;
  v_admin public.profiles%rowtype;
  v_supervisor public.profiles%rowtype;
  v_primary_schedule public.work_schedules%rowtype;
  v_secondary_schedule public.work_schedules%rowtype;
  v_multi_schedule_one public.work_schedules%rowtype;
  v_multi_schedule_two public.work_schedules%rowtype;
  v_leave_schedule public.work_schedules%rowtype;
  v_attendance public.attendance%rowtype;
  v_multi_attendance_one public.attendance%rowtype;
  v_multi_attendance_two public.attendance%rowtype;
  v_leave public.leave_requests%rowtype;
  v_calc record;
  v_report jsonb := '{}'::jsonb;
  v_work_date date;
  v_multi_date date;
  v_leave_date date;
  v_shift_start timestamptz;
  v_shift_end timestamptz;
  v_overlap_rejected boolean := false;
  v_missing_clock_out_seen boolean := false;
  v_correction_logged boolean := false;
  v_payroll_ready boolean := false;
  v_visible_team_rows integer := 0;
  v_out_of_scope_rows integer := 0;
  v_multi_count integer := 0;
  v_multi_regular_minutes integer := 0;
  v_templates_before text;
  v_template_days_before text;
  v_assignments_before text;
  v_templates_after text;
  v_template_days_after text;
  v_assignments_after text;
begin
  select md5(coalesce(string_agg(to_jsonb(item)::text, '|' order by to_jsonb(item)::text), ''))
  into v_templates_before
  from public.work_schedule_templates item;

  select md5(coalesce(string_agg(to_jsonb(item)::text, '|' order by to_jsonb(item)::text), ''))
  into v_template_days_before
  from public.work_schedule_template_days item;

  select md5(coalesce(string_agg(to_jsonb(item)::text, '|' order by to_jsonb(item)::text), ''))
  into v_assignments_before
  from public.work_schedule_template_assignments item;

  select * into strict v_test
  from public.profiles
  where full_name = 'Test'
    and base_role = 'agent'
    and is_agent is true
    and employment_status in ('active', 'on_leave')
    and onboarding_status = 'active'
    and account_deleted_at is null;

  select * into strict v_admin
  from public.profiles
  where full_name = 'Almar Contreras'
    and base_role = 'admin'
    and is_agent is true
    and employment_status in ('active', 'on_leave')
    and onboarding_status = 'active'
    and account_deleted_at is null;

  select profile.* into strict v_supervisor
  from public.profiles profile
  join public.teams team on team.supervisor_id = profile.user_id
  where profile.full_name = 'Arby Jann Benito'
    and team.name = 'Test Team'
    and team.is_active is true;

  if v_test.team_id is null then
    raise exception 'The Test identity must belong to Test Team.';
  end if;

  -- All data-changing checks run in this subtransaction. The P1700 exception
  -- at the end rolls them back while retaining the report variables.
  begin
    v_shift_start := now() + interval '3 hours';
    v_shift_end := v_shift_start + interval '8 hours';
    v_work_date := (v_shift_start at time zone 'America/New_York')::date;
    v_leave_date := v_work_date + 30;
    v_multi_date := v_work_date + 60;

    insert into public.work_schedules (
      user_id, team_id, shift_date, shift_sequence, shift_start, shift_end,
      timezone, status, notes, created_by, updated_by,
      generated_by_automation, admin_override
    ) values (
      v_test.user_id, v_test.team_id, v_work_date, 1, v_shift_start, v_shift_end,
      'America/New_York', 'published', 'Rollback-only Step 17 primary shift',
      v_admin.user_id, v_admin.user_id, false, false
    ) returning * into v_primary_schedule;

    insert into public.work_schedules (
      user_id, team_id, shift_date, shift_sequence, shift_start, shift_end,
      timezone, status, notes, created_by, updated_by,
      generated_by_automation, admin_override
    ) values (
      v_test.user_id, v_test.team_id, v_work_date, 2,
      v_shift_end + interval '1 hour', v_shift_end + interval '5 hours',
      'America/New_York', 'published', 'Rollback-only Step 17 second shift',
      v_admin.user_id, v_admin.user_id, false, false
    ) returning * into v_secondary_schedule;

    perform set_config(
      'request.jwt.claims',
      jsonb_build_object('sub', v_test.user_id, 'role', 'authenticated')::text,
      true
    );
    perform set_config('request.jwt.claim.sub', v_test.user_id::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);

    select * into v_attendance
    from public.workforce_clock_in(v_primary_schedule.id);

    v_missing_clock_out_seen := v_attendance.clock_in is not null
      and v_attendance.clock_out is null;

    if not v_missing_clock_out_seen then
      raise exception 'Clock-in did not create the expected open attendance record.';
    end if;

    begin
      perform public.workforce_clock_in(v_secondary_schedule.id);
      raise exception 'A second overlapping attendance session was unexpectedly allowed.';
    exception
      when others then
        if sqlerrm not like '%already clocked in%' then
          raise;
        end if;
        v_overlap_rejected := true;
    end;

    select * into v_attendance
    from public.workforce_clock_out();

    perform set_config(
      'request.jwt.claims',
      jsonb_build_object('sub', v_admin.user_id, 'role', 'authenticated')::text,
      true
    );
    perform set_config('request.jwt.claim.sub', v_admin.user_id::text, true);

    select * into v_attendance
    from public.workforce_correct_attendance(
      v_attendance.id,
      v_shift_start - interval '3 hours',
      v_shift_end + interval '2 hours',
      'present',
      v_primary_schedule.id,
      'Rollback-only Step 17 correction',
      'manager_confirmed',
      'Verified clock-in and clock-out correction together'
    );

    if v_attendance.pre_shift_overtime_minutes <> 180
       or v_attendance.regular_minutes <> 480
       or v_attendance.post_shift_overtime_minutes <> 120
       or v_attendance.total_overtime_minutes <> 300 then
      raise exception 'Correction recalculation did not produce the expected totals.';
    end if;

    select exists (
      select 1
      from public.attendance_corrections correction
      where correction.attendance_id = v_attendance.id
        and correction.reason_code = 'manager_confirmed'
        and correction.previous_clock_in is not null
        and correction.new_clock_in = v_attendance.clock_in
        and correction.new_clock_out = v_attendance.clock_out
    ) into v_correction_logged;

    if not v_correction_logged then
      raise exception 'Structured correction history was not recorded.';
    end if;

    select * into v_attendance
    from public.workforce_review_attendance(
      v_attendance.id,
      'approved',
      'Rollback-only Step 17 attendance approval'
    );

    select readiness.is_payroll_ready
    into v_payroll_ready
    from public.workforce_attendance_payroll_readiness readiness
    where readiness.id = v_attendance.id;

    if v_attendance.review_status <> 'approved' or not coalesce(v_payroll_ready, false) then
      raise exception 'Approved attendance was not payroll-ready.';
    end if;

    -- Normal shift.
    select * into v_calc
    from public.workforce_calculate_attendance(
      timestamptz '2035-01-15 10:00 America/New_York',
      timestamptz '2035-01-15 18:00 America/New_York',
      timestamptz '2035-01-15 10:00 America/New_York',
      timestamptz '2035-01-15 18:00 America/New_York',
      date '2035-01-15', 'America/New_York', 1200, false, false
    );
    if v_calc.regular_minutes <> 480 or v_calc.total_overtime_minutes <> 0 then
      raise exception 'Normal-shift calculation failed.';
    end if;

    -- Several-hours-early clock-in crossing automatically into regular time.
    select * into v_calc
    from public.workforce_calculate_attendance(
      timestamptz '2035-01-15 10:00 America/New_York',
      timestamptz '2035-01-15 18:00 America/New_York',
      timestamptz '2035-01-15 07:00 America/New_York',
      timestamptz '2035-01-15 12:00 America/New_York',
      date '2035-01-15', 'America/New_York', 1200, false, false
    );
    if v_calc.pre_shift_overtime_minutes <> 180
       or v_calc.regular_minutes <> 120
       or v_calc.post_shift_overtime_minutes <> 0 then
      raise exception 'Early-to-regular automatic transition failed.';
    end if;

    -- Post-shift overtime.
    select * into v_calc
    from public.workforce_calculate_attendance(
      timestamptz '2035-01-15 10:00 America/New_York',
      timestamptz '2035-01-15 18:00 America/New_York',
      timestamptz '2035-01-15 10:00 America/New_York',
      timestamptz '2035-01-15 20:00 America/New_York',
      date '2035-01-15', 'America/New_York', 1200, false, false
    );
    if v_calc.regular_minutes <> 480 or v_calc.post_shift_overtime_minutes <> 120 then
      raise exception 'Post-shift overtime calculation failed.';
    end if;

    -- Combined pre-shift and post-shift overtime.
    select * into v_calc
    from public.workforce_calculate_attendance(
      timestamptz '2035-01-15 10:00 America/New_York',
      timestamptz '2035-01-15 18:00 America/New_York',
      timestamptz '2035-01-15 07:00 America/New_York',
      timestamptz '2035-01-15 20:00 America/New_York',
      date '2035-01-15', 'America/New_York', 1200, false, false
    );
    if v_calc.pre_shift_overtime_minutes <> 180
       or v_calc.regular_minutes <> 480
       or v_calc.post_shift_overtime_minutes <> 120
       or v_calc.total_overtime_minutes <> 300 then
      raise exception 'Combined overtime calculation failed.';
    end if;

    -- Overnight shift.
    select * into v_calc
    from public.workforce_calculate_attendance(
      timestamptz '2035-01-15 22:00 America/New_York',
      timestamptz '2035-01-16 06:00 America/New_York',
      timestamptz '2035-01-15 21:00 America/New_York',
      timestamptz '2035-01-16 07:00 America/New_York',
      date '2035-01-15', 'America/New_York', 1200, false, false
    );
    if v_calc.pre_shift_overtime_minutes <> 60
       or v_calc.regular_minutes <> 480
       or v_calc.post_shift_overtime_minutes <> 60 then
      raise exception 'Overnight-shift calculation failed.';
    end if;

    -- Overtime approaching and exceeding the 20-hour ceiling.
    select * into v_calc
    from public.workforce_calculate_attendance(
      timestamptz '2035-01-15 10:00 America/New_York',
      timestamptz '2035-01-15 18:00 America/New_York',
      timestamptz '2035-01-14 15:00 America/New_York',
      timestamptz '2035-01-15 18:00 America/New_York',
      date '2035-01-15', 'America/New_York', 1200, false, false
    );
    if v_calc.total_overtime_minutes <> 1140 then
      raise exception 'The near-limit overtime calculation failed.';
    end if;

    select * into v_calc
    from public.workforce_calculate_attendance(
      timestamptz '2035-01-15 10:00 America/New_York',
      timestamptz '2035-01-15 18:00 America/New_York',
      timestamptz '2035-01-14 13:00 America/New_York',
      timestamptz '2035-01-15 18:00 America/New_York',
      date '2035-01-15', 'America/New_York', 1200, false, false
    );
    if v_calc.total_overtime_minutes <> 1200 then
      raise exception 'Over-limit overtime was not capped at 20 hours.';
    end if;

    -- Two non-overlapping shifts on one work date.
    insert into public.work_schedules (
      user_id, team_id, shift_date, shift_sequence, shift_start, shift_end,
      timezone, status, notes, created_by, updated_by
    ) values (
      v_test.user_id, v_test.team_id, v_multi_date, 1,
      make_timestamptz(extract(year from v_multi_date)::int, extract(month from v_multi_date)::int, extract(day from v_multi_date)::int, 8, 0, 0, 'America/New_York'),
      make_timestamptz(extract(year from v_multi_date)::int, extract(month from v_multi_date)::int, extract(day from v_multi_date)::int, 12, 0, 0, 'America/New_York'),
      'America/New_York', 'published', 'Rollback-only Step 17 multi-shift A',
      v_admin.user_id, v_admin.user_id
    ) returning * into v_multi_schedule_one;

    insert into public.work_schedules (
      user_id, team_id, shift_date, shift_sequence, shift_start, shift_end,
      timezone, status, notes, created_by, updated_by
    ) values (
      v_test.user_id, v_test.team_id, v_multi_date, 2,
      make_timestamptz(extract(year from v_multi_date)::int, extract(month from v_multi_date)::int, extract(day from v_multi_date)::int, 13, 0, 0, 'America/New_York'),
      make_timestamptz(extract(year from v_multi_date)::int, extract(month from v_multi_date)::int, extract(day from v_multi_date)::int, 17, 0, 0, 'America/New_York'),
      'America/New_York', 'published', 'Rollback-only Step 17 multi-shift B',
      v_admin.user_id, v_admin.user_id
    ) returning * into v_multi_schedule_two;

    insert into public.attendance (
      user_id, schedule_id, work_date, clock_in, clock_out,
      attendance_status, created_by, updated_by
    ) values (
      v_test.user_id, v_multi_schedule_one.id, v_multi_date,
      v_multi_schedule_one.shift_start, v_multi_schedule_one.shift_end,
      'present', v_test.user_id, v_test.user_id
    ) returning * into v_multi_attendance_one;
    v_multi_attendance_one := public.workforce_recalculate_attendance(v_multi_attendance_one.id);

    insert into public.attendance (
      user_id, schedule_id, work_date, clock_in, clock_out,
      attendance_status, created_by, updated_by
    ) values (
      v_test.user_id, v_multi_schedule_two.id, v_multi_date,
      v_multi_schedule_two.shift_start, v_multi_schedule_two.shift_end,
      'present', v_test.user_id, v_test.user_id
    ) returning * into v_multi_attendance_two;
    v_multi_attendance_two := public.workforce_recalculate_attendance(v_multi_attendance_two.id);

    select count(*)::integer, sum(regular_minutes)::integer
    into v_multi_count, v_multi_regular_minutes
    from public.attendance
    where user_id = v_test.user_id and work_date = v_multi_date;

    if v_multi_count <> 2 or v_multi_regular_minutes <> 480 then
      raise exception 'Multiple shifts on one work date were not calculated independently.';
    end if;

    -- Leave submission and approval against a one-off working shift.
    insert into public.work_schedules (
      user_id, team_id, shift_date, shift_sequence, shift_start, shift_end,
      timezone, status, notes, created_by, updated_by
    ) values (
      v_test.user_id, v_test.team_id, v_leave_date, 1,
      make_timestamptz(extract(year from v_leave_date)::int, extract(month from v_leave_date)::int, extract(day from v_leave_date)::int, 10, 0, 0, 'America/New_York'),
      make_timestamptz(extract(year from v_leave_date)::int, extract(month from v_leave_date)::int, extract(day from v_leave_date)::int, 18, 0, 0, 'America/New_York'),
      'America/New_York', 'published', 'Rollback-only Step 17 leave shift',
      v_admin.user_id, v_admin.user_id
    ) returning * into v_leave_schedule;

    perform set_config(
      'request.jwt.claims',
      jsonb_build_object('sub', v_test.user_id, 'role', 'authenticated')::text,
      true
    );
    perform set_config('request.jwt.claim.sub', v_test.user_id::text, true);

    insert into public.leave_requests (
      user_id, leave_type, start_date, end_date, reason
    ) values (
      v_test.user_id, 'vacation', v_leave_date, v_leave_date,
      'Rollback-only Step 17 leave request'
    ) returning * into v_leave;

    perform set_config(
      'request.jwt.claims',
      jsonb_build_object('sub', v_admin.user_id, 'role', 'authenticated')::text,
      true
    );
    perform set_config('request.jwt.claim.sub', v_admin.user_id::text, true);

    select * into v_leave
    from public.workforce_review_leave_request(
      v_leave.id, 'approved', 'Rollback-only Step 17 leave approval'
    );

    if v_leave.status <> 'approved' or not exists (
      select 1 from public.attendance
      where user_id = v_test.user_id
        and schedule_id = v_leave_schedule.id
        and attendance_status = 'on_leave'
        and review_status = 'approved'
    ) then
      raise exception 'Leave approval did not create approved leave attendance.';
    end if;

    -- Scoped supervisor must see Test Team and no other team.
    perform set_config(
      'request.jwt.claims',
      jsonb_build_object('sub', v_supervisor.user_id, 'role', 'authenticated')::text,
      true
    );
    perform set_config('request.jwt.claim.sub', v_supervisor.user_id::text, true);

    select
      count(*)::integer,
      count(*) filter (where team_id is distinct from v_test.team_id)::integer
    into v_visible_team_rows, v_out_of_scope_rows
    from public.workforce_list_team_attendance(v_work_date, v_leave_date);

    if v_visible_team_rows < 2 or v_out_of_scope_rows <> 0 then
      raise exception 'Supervisor attendance scope is incorrect.';
    end if;

    v_report := jsonb_build_object(
      'normal_shift', true,
      'several_hours_early', true,
      'automatic_overtime_to_regular_transition', true,
      'post_shift_overtime', true,
      'combined_overtime', true,
      'overnight_shift', true,
      'multiple_shifts_one_work_date', true,
      'overlapping_session_rejected', v_overlap_rejected,
      'missing_clock_out_detected', v_missing_clock_out_seen,
      'clock_in_correction', true,
      'clock_out_correction', true,
      'correction_reason_logged', v_correction_logged,
      'recalculation_after_correction', true,
      'attendance_approved', true,
      'approved_attendance_payroll_ready', v_payroll_ready,
      'leave_submitted_and_approved', true,
      'supervisor_team_visibility', v_out_of_scope_rows = 0,
      'overtime_near_20_hours', true,
      'overtime_over_20_hours_capped', true,
      'recurring_schedule_changes_requested', false
    );

    raise exception using errcode = 'P1700', message = 'step17_rollback';
  exception
    when sqlstate 'P1700' then
      if sqlerrm <> 'step17_rollback' then
        raise;
      end if;
  end;

  select md5(coalesce(string_agg(to_jsonb(item)::text, '|' order by to_jsonb(item)::text), ''))
  into v_templates_after
  from public.work_schedule_templates item;

  select md5(coalesce(string_agg(to_jsonb(item)::text, '|' order by to_jsonb(item)::text), ''))
  into v_template_days_after
  from public.work_schedule_template_days item;

  select md5(coalesce(string_agg(to_jsonb(item)::text, '|' order by to_jsonb(item)::text), ''))
  into v_assignments_after
  from public.work_schedule_template_assignments item;

  if v_templates_before is distinct from v_templates_after
     or v_template_days_before is distinct from v_template_days_after
     or v_assignments_before is distinct from v_assignments_after then
    raise exception 'Recurring schedule automation changed during Step 17.';
  end if;

  return v_report || jsonb_build_object(
    'rollback_only', true,
    'recurring_schedule_automation_preserved', true
  );
end;
$$;

select set_config(
  'step17.report',
  pg_temp.run_complete_attendance_cycle()::text,
  false
);

select set_config(
  'step17.test_user_id',
  (
    select user_id::text
    from public.profiles
    where full_name = 'Test'
      and base_role = 'agent'
      and is_agent is true
      and onboarding_status = 'active'
      and account_deleted_at is null
  ),
  false
);

set local role authenticated;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', current_setting('step17.test_user_id'),
    'role', 'authenticated'
  )::text,
  true
);

select set_config(
  'request.jwt.claim.sub',
  current_setting('step17.test_user_id'),
  true
);

select set_config(
  'step17.agent_out_of_scope_rows',
  (
    select count(*)::text
    from public.attendance
    where user_id <> current_setting('step17.test_user_id')::uuid
  ),
  false
);

reset role;
commit;

select
  current_setting('step17.report')::jsonb
  || jsonb_build_object(
    'agent_self_record_isolation',
    current_setting('step17.agent_out_of_scope_rows')::integer = 0
  ) as step17_report;
