-- Phase 1, Step 10: Team Attendance verification.
-- Run after 2026070902_team_attendance_page.sql in the internal Supabase project.

-- ---------------------------------------------------------------------------
-- 1. Required function
-- ---------------------------------------------------------------------------

select
  to_regprocedure('public.workforce_list_team_attendance(date,date)') is not null
    as team_attendance_function_exists;

-- ---------------------------------------------------------------------------
-- 2. Browser-role privileges
-- ---------------------------------------------------------------------------

select
  has_function_privilege(
    'authenticated',
    'public.workforce_list_team_attendance(date,date)',
    'EXECUTE'
  ) as authenticated_can_execute,
  has_function_privilege(
    'anon',
    'public.workforce_list_team_attendance(date,date)',
    'EXECUTE'
  ) as anon_can_execute_should_be_false;

-- ---------------------------------------------------------------------------
-- 3. Permission and supervisor-scope enforcement
-- ---------------------------------------------------------------------------

select
  position(
    'workforce_has_permission(''view_team_attendance'')'
    in pg_get_functiondef(
      'public.workforce_list_team_attendance(date,date)'::regprocedure
    )
  ) > 0 as permission_check_exists,
  position(
    'workforce_can_manage_user'
    in pg_get_functiondef(
      'public.workforce_list_team_attendance(date,date)'::regprocedure
    )
  ) > 0 as employee_scope_check_exists;

-- ---------------------------------------------------------------------------
-- 4. Required Step 8 and Step 9 columns
-- ---------------------------------------------------------------------------

select required.column_name,
       existing.column_name is not null as column_exists
from (
  values
    ('pre_shift_overtime_minutes'::text),
    ('regular_minutes'::text),
    ('post_shift_overtime_minutes'::text),
    ('total_overtime_minutes'::text),
    ('total_worked_minutes'::text),
    ('is_corrected'::text),
    ('review_status'::text),
    ('corrected_by'::text),
    ('corrected_at'::text)
) required(column_name)
left join information_schema.columns existing
  on existing.table_schema = 'public'
 and existing.table_name = 'attendance'
 and existing.column_name = required.column_name
order by required.column_name;

-- ---------------------------------------------------------------------------
-- 5. Blocker queries
-- Every blocker query in section 5 must return zero rows.
-- ---------------------------------------------------------------------------

-- Attendance records must retain a valid employee profile.
select attendance_row.id, attendance_row.user_id
from public.attendance attendance_row
left join public.profiles employee
  on employee.user_id = attendance_row.user_id
where employee.user_id is null;

-- Linked schedules must belong to the same employee and work date.
select
  attendance_row.id,
  attendance_row.user_id,
  attendance_row.work_date,
  schedule.user_id as schedule_user_id,
  schedule.shift_date
from public.attendance attendance_row
join public.work_schedules schedule
  on schedule.id = attendance_row.schedule_id
where schedule.user_id <> attendance_row.user_id
   or schedule.shift_date <> attendance_row.work_date;

-- Completed, scheduled attendance should have structured calculations.
select
  attendance_row.id,
  attendance_row.user_id,
  attendance_row.work_date
from public.attendance attendance_row
where attendance_row.schedule_id is not null
  and attendance_row.clock_in is not null
  and attendance_row.clock_out is not null
  and (
    attendance_row.pre_shift_overtime_minutes is null
    or attendance_row.regular_minutes is null
    or attendance_row.post_shift_overtime_minutes is null
  );

-- Overtime remains capped at 1,200 credited minutes per employee work date.
select
  attendance_row.user_id,
  attendance_row.work_date,
  sum(attendance_row.total_overtime_minutes) as credited_overtime_minutes
from public.attendance attendance_row
group by attendance_row.user_id, attendance_row.work_date
having sum(attendance_row.total_overtime_minutes) > 1200;
