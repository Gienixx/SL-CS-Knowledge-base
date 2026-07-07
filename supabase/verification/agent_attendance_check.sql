-- Agent attendance verification
-- Run after 2026070801_agent_attendance_interface.sql.

-- 1. Required functions must exist.
select
  to_regprocedure('public.workforce_current_profile_id()') as current_profile_function,
  to_regprocedure('public.workforce_current_user_is_agent()') as current_agent_function,
  to_regprocedure('public.workforce_clock_in(uuid)') as clock_in_function,
  to_regprocedure('public.workforce_clock_out()') as clock_out_function;

-- 2. Every active agent with a site login must have at least one active identity link.
-- Must return 0 rows.
select
  profile.user_id,
  profile.full_name,
  profile.email
from public.profiles profile
join public.login login_user
  on lower(trim(login_user.email)) = lower(trim(profile.email))
where profile.is_agent is true
  and profile.employment_status in ('active', 'on_leave')
  and not exists (
    select 1
    from public.workforce_identity_links identity_link
    where identity_link.profile_user_id = profile.user_id
      and identity_link.is_active is true
  );

-- 3. Attendance rows must belong to a valid profile and a schedule owned by the
-- same profile or by another profile linked to the same Auth identity.
-- Must return 0 rows.
select attendance_row.*
from public.attendance attendance_row
left join public.profiles profile
  on profile.user_id = attendance_row.user_id
left join public.work_schedules schedule
  on schedule.id = attendance_row.schedule_id
where profile.user_id is null
   or (
     attendance_row.schedule_id is not null
     and schedule.user_id <> attendance_row.user_id
     and not exists (
       select 1
       from public.workforce_identity_links attendance_link
       join public.workforce_identity_links schedule_link
         on schedule_link.auth_user_id = attendance_link.auth_user_id
        and schedule_link.is_active is true
       where attendance_link.profile_user_id = attendance_row.user_id
         and attendance_link.is_active is true
         and schedule_link.profile_user_id = schedule.user_id
     )
   );

-- 4. Open attendance rows should have a clock-in and no clock-out.
select
  attendance_row.user_id,
  attendance_row.work_date,
  attendance_row.clock_in,
  attendance_row.clock_out,
  attendance_row.attendance_status
from public.attendance attendance_row
where attendance_row.clock_in is not null
  and attendance_row.clock_out is null
order by attendance_row.work_date desc;

-- 5. Confirm the migration audit entry exists.
select action, entity_type, after_data, created_at
from public.workforce_audit_logs
where action = 'agent_attendance_interface_enabled'
order by created_at desc
limit 5;
