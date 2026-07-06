-- Phase 1 Workforce Foundation verification
-- Run after 2026070601_workforce_foundation.sql in the target Supabase project.
-- Every query should return the expected result described in its comment.

-- 1. Expected tables: should return 7 rows.
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'profiles',
    'teams',
    'user_permissions',
    'work_schedules',
    'attendance',
    'leave_requests',
    'workforce_audit_logs'
  )
order by table_name;

-- 2. RLS: all rows should show row_security_enabled = true.
select
  c.relname as table_name,
  c.relrowsecurity as row_security_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in (
    'profiles',
    'teams',
    'user_permissions',
    'work_schedules',
    'attendance',
    'leave_requests',
    'workforce_audit_logs'
  )
order by c.relname;

-- 3. Approved Auth users without a workforce profile: should return 0 rows.
select
  auth_user.id,
  auth_user.email
from auth.users auth_user
join public.login login_user
  on lower(login_user.email) = lower(auth_user.email)
left join public.profiles profile
  on profile.user_id = auth_user.id
where profile.user_id is null;

-- 4. Workforce profiles without a matching login record: review manually.
-- Existing approved users should normally return 0 rows at initial rollout.
select
  profile.user_id,
  profile.email,
  profile.employment_status
from public.profiles profile
left join public.login login_user
  on lower(login_user.email) = lower(profile.email)
where login_user.email is null
order by profile.email;

-- 5. Duplicate normalized emails: should return 0 rows.
select lower(email) as normalized_email, count(*)
from public.profiles
group by lower(email)
having count(*) > 1;

-- 6. Duplicate normalized employee IDs: should return 0 rows.
select lower(employee_id) as normalized_employee_id, count(*)
from public.profiles
group by lower(employee_id)
having count(*) > 1;

-- 7. Existing administrators missing Phase 1 workforce permissions:
-- should return 0 rows.
with required_permissions(permission_key) as (
  values
    ('manage_employees'::text),
    ('manage_schedules'::text),
    ('view_team_attendance'::text),
    ('approve_leave'::text),
    ('view_workforce_reports'::text)
)
select
  profile.email,
  required.permission_key
from public.profiles profile
cross join required_permissions required
left join public.user_permissions permission
  on permission.user_id = profile.user_id
 and permission.permission_key = required.permission_key
 and permission.is_granted is true
where profile.base_role = 'admin'
  and permission.id is null
order by profile.email, required.permission_key;

-- 8. Existing article editors missing edit_articles permission:
-- should return 0 rows.
select profile.email
from public.profiles profile
left join public.user_permissions permission
  on permission.user_id = profile.user_id
 and permission.permission_key = 'edit_articles'
 and permission.is_granted is true
where profile.can_edit_articles is true
  and permission.id is null;

-- 9. Payroll permissions granted during Phase 1: review manually.
-- Expected initial result is normally 0 rows because payroll access is separate.
select
  profile.email,
  permission.is_granted,
  permission.reason
from public.user_permissions permission
join public.profiles profile on profile.user_id = permission.user_id
where permission.permission_key = 'manage_payroll'
  and permission.is_granted is true
order by profile.email;

-- 10. Anonymous table privileges: should return 0 rows.
select
  table_name,
  privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee = 'anon'
  and table_name in (
    'profiles',
    'teams',
    'user_permissions',
    'work_schedules',
    'attendance',
    'leave_requests',
    'workforce_audit_logs'
  )
order by table_name, privilege_type;

-- 11. Required helper/RPC functions: should return 9 rows.
select
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'workforce_current_user_is_active',
    'workforce_is_admin',
    'workforce_has_permission',
    'workforce_is_assigned_supervisor',
    'workforce_can_manage_user',
    'workforce_can_view_user',
    'workforce_clock_in',
    'workforce_clock_out',
    'workforce_cancel_leave_request',
    'workforce_review_leave_request'
  )
order by p.proname;

-- 12. Required RLS policies: inspect that the expected policy names are present.
select
  tablename,
  policyname,
  cmd,
  roles
from pg_policies
where schemaname = 'public'
  and tablename in (
    'profiles',
    'teams',
    'user_permissions',
    'work_schedules',
    'attendance',
    'leave_requests',
    'workforce_audit_logs'
  )
order by tablename, policyname;

-- 13. Profiles with invalid or unfinished team relationships: review manually.
select
  profile.email,
  profile.employee_id,
  profile.team_id,
  profile.supervisor_id
from public.profiles profile
where profile.employment_status in ('active', 'on_leave')
  and (profile.team_id is null or profile.supervisor_id is null)
order by profile.email;

-- 14. Confirm all expected users before Phase 1 completion.
-- The current project target is 11 active/on-leave users.
select
  count(*) as active_workforce_users
from public.profiles
where employment_status in ('active', 'on_leave');

-- 15. Audit trigger coverage: should list six audited workforce tables.
select
  event_object_table as table_name,
  trigger_name,
  event_manipulation
from information_schema.triggers
where trigger_schema = 'public'
  and trigger_name like '%workforce_audit'
order by event_object_table, event_manipulation;
