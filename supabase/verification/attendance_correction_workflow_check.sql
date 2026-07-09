-- Phase 1, Step 12: attendance correction workflow verification.
-- Run after:
--   2026070904_attendance_correction_workflow.sql
--   2026070905_attendance_original_timestamp_guard.sql

-- ---------------------------------------------------------------------------
-- 1. Required functions
-- ---------------------------------------------------------------------------

select
  to_regprocedure('public.workforce_list_attendance_correction_schedules(uuid)') is not null
    as correction_schedule_function_exists,
  to_regprocedure(
    'public.workforce_correct_attendance(uuid,timestamp without time zone,timestamp without time zone,text,uuid,text,text,text)'
  ) is not null as correction_function_exists;

-- ---------------------------------------------------------------------------
-- 2. Function privileges
-- ---------------------------------------------------------------------------

select
  has_function_privilege(
    'authenticated',
    'public.workforce_list_attendance_correction_schedules(uuid)',
    'EXECUTE'
  ) as authenticated_can_list_correction_schedules,
  has_function_privilege(
    'authenticated',
    'public.workforce_correct_attendance(uuid,timestamp without time zone,timestamp without time zone,text,uuid,text,text,text)',
    'EXECUTE'
  ) as authenticated_can_call_correction_rpc,
  has_function_privilege(
    'anon',
    'public.workforce_list_attendance_correction_schedules(uuid)',
    'EXECUTE'
  ) as anon_can_list_correction_schedules_should_be_false,
  has_function_privilege(
    'anon',
    'public.workforce_correct_attendance(uuid,timestamp without time zone,timestamp without time zone,text,uuid,text,text,text)',
    'EXECUTE'
  ) as anon_can_call_correction_rpc_should_be_false;

-- ---------------------------------------------------------------------------
-- 3. Direct table-mutation boundary
-- ---------------------------------------------------------------------------

select
  has_table_privilege('authenticated', 'public.attendance', 'SELECT')
    as authenticated_can_select_attendance,
  has_table_privilege('authenticated', 'public.attendance', 'INSERT')
    as authenticated_can_insert_attendance_should_be_false,
  has_table_privilege('authenticated', 'public.attendance', 'UPDATE')
    as authenticated_can_update_attendance_should_be_false,
  has_table_privilege('authenticated', 'public.attendance', 'DELETE')
    as authenticated_can_delete_attendance_should_be_false;

-- ---------------------------------------------------------------------------
-- 4. Required correction controls
-- ---------------------------------------------------------------------------

with correction_definition as (
  select pg_get_functiondef(
    'public.workforce_correct_attendance(uuid,timestamp without time zone,timestamp without time zone,text,uuid,text,text,text)'::regprocedure
  ) as definition
)
select
  position('workforce_can_correct_attendance(v_target_user_id)' in definition) > 0
    as explicit_correction_permission_required,
  position('workforce_can_approve_attendance(v_attendance.user_id)' in definition) > 0
    as explicit_approval_permission_controls_auto_approval,
  position('v_attendance.review_status = ''locked''' in definition) > 0
    as locked_records_are_rejected,
  position('Selected schedule must preserve the attendance work date.' in definition) > 0
    as work_date_is_preserved,
  position('Corrected attendance cannot overlap another attendance session.' in definition) > 0
    as overlapping_sessions_are_rejected,
  position('workforce_recalculate_attendance_work_date' in definition) > 0
    as work_date_recalculation_exists,
  position('attendance_corrected' in definition) > 0
    as explicit_audit_event_exists,
  position('reason_code' in definition) > 0
    as structured_reason_code_is_logged,
  position('reason_notes' in definition) > 0
    as structured_reason_notes_are_logged
from correction_definition;

-- ---------------------------------------------------------------------------
-- 5. Original timestamp protection
-- ---------------------------------------------------------------------------

with storage_definition as (
  select pg_get_functiondef(
    'public.workforce_prepare_attendance_storage()'::regprocedure
  ) as definition
)
select
  position('v_is_correction' in definition) > 0
    as correction_detection_exists,
  position('and not v_is_correction' in definition) > 0
    as corrected_missing_timestamps_do_not_become_originals,
  position('original_clock_in is immutable after capture.' in definition) > 0
    as original_clock_in_remains_immutable,
  position('original_clock_out is immutable after capture.' in definition) > 0
    as original_clock_out_remains_immutable
from storage_definition;

-- ---------------------------------------------------------------------------
-- 6. Blocker queries
-- Every blocker query in section 6 must return zero rows.
-- ---------------------------------------------------------------------------

-- Authenticated users must not retain direct attendance write privileges.
select privilege_type
from information_schema.role_table_grants
where grantee = 'authenticated'
  and table_schema = 'public'
  and table_name = 'attendance'
  and privilege_type in ('INSERT', 'UPDATE', 'DELETE');

-- No authenticated write policy should remain on attendance.
select policyname, cmd
from pg_policies
where schemaname = 'public'
  and tablename = 'attendance'
  and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL');

-- Anonymous users must not be able to execute either correction function.
select routine_name
from information_schema.routine_privileges
where grantee = 'anon'
  and specific_schema = 'public'
  and routine_name in (
    'workforce_list_attendance_correction_schedules',
    'workforce_correct_attendance'
  )
  and privilege_type = 'EXECUTE';

-- Non-admin profiles must not hold active correction or approval grants.
select
  profile.user_id,
  profile.full_name,
  permission.permission_key
from public.user_permissions permission
join public.profiles profile
  on profile.user_id = permission.user_id
where permission.permission_key in ('correct_attendance', 'approve_attendance')
  and permission.is_granted is true
  and profile.base_role <> 'admin'
  and profile.is_system_admin is not true;

-- Uncorrected captured timestamps should have matching immutable originals.
select
  attendance_row.id,
  attendance_row.user_id,
  attendance_row.work_date
from public.attendance attendance_row
where attendance_row.is_corrected is false
  and (
    (attendance_row.clock_in is not null and attendance_row.original_clock_in is distinct from attendance_row.clock_in)
    or (attendance_row.clock_out is not null and attendance_row.original_clock_out is distinct from attendance_row.clock_out)
  );
