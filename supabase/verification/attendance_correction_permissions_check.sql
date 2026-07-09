-- Phase 1, Step 11: attendance correction permission verification.
-- Run after 2026070903_attendance_correction_permissions.sql.

-- ---------------------------------------------------------------------------
-- 1. Required permission keys and helper functions
-- ---------------------------------------------------------------------------

select
  position(
    '''correct_attendance'''
    in pg_get_constraintdef(
      (
        select constraint_row.oid
        from pg_constraint constraint_row
        where constraint_row.conname = 'user_permissions_permission_key_check'
          and constraint_row.conrelid = 'public.user_permissions'::regclass
      )
    )
  ) > 0 as correct_attendance_key_exists,
  position(
    '''approve_attendance'''
    in pg_get_constraintdef(
      (
        select constraint_row.oid
        from pg_constraint constraint_row
        where constraint_row.conname = 'user_permissions_permission_key_check'
          and constraint_row.conrelid = 'public.user_permissions'::regclass
      )
    )
  ) > 0 as approve_attendance_key_exists;

select
  to_regprocedure('public.workforce_is_authorized_attendance_admin(text)') is not null
    as admin_authorizer_exists,
  to_regprocedure('public.workforce_can_correct_attendance(uuid)') is not null
    as correction_authorizer_exists,
  to_regprocedure('public.workforce_can_approve_attendance(uuid)') is not null
    as approval_authorizer_exists;

-- ---------------------------------------------------------------------------
-- 2. Browser-role privileges
-- ---------------------------------------------------------------------------

select
  has_function_privilege(
    'authenticated',
    'public.workforce_can_correct_attendance(uuid)',
    'EXECUTE'
  ) as authenticated_can_check_correction,
  has_function_privilege(
    'authenticated',
    'public.workforce_can_approve_attendance(uuid)',
    'EXECUTE'
  ) as authenticated_can_check_approval,
  has_function_privilege(
    'anon',
    'public.workforce_can_correct_attendance(uuid)',
    'EXECUTE'
  ) as anon_can_check_correction_should_be_false,
  has_function_privilege(
    'anon',
    'public.workforce_can_approve_attendance(uuid)',
    'EXECUTE'
  ) as anon_can_check_approval_should_be_false;

-- ---------------------------------------------------------------------------
-- 3. Required authorization boundaries
-- ---------------------------------------------------------------------------

select
  position(
    'workforce_is_admin()'
    in pg_get_functiondef(
      'public.workforce_is_authorized_attendance_admin(text)'::regprocedure
    )
  ) > 0 as admin_role_is_required,
  position(
    'workforce_has_permission(p_permission_key)'
    in pg_get_functiondef(
      'public.workforce_is_authorized_attendance_admin(text)'::regprocedure
    )
  ) > 0 as explicit_permission_is_required,
  position(
    'workforce_is_assigned_supervisor'
    in pg_get_functiondef(
      'public.workforce_can_correct_attendance(uuid)'::regprocedure
    )
  ) = 0 as supervisor_scope_does_not_grant_correction,
  position(
    'manage_payroll'
    in pg_get_functiondef(
      'public.workforce_is_authorized_attendance_admin(text)'::regprocedure
    )
  ) = 0 as payroll_permission_is_not_used;

-- ---------------------------------------------------------------------------
-- 4. Shared access and employee-administration integration
-- ---------------------------------------------------------------------------

select
  position(
    '''correct_attendance'''
    in pg_get_functiondef('public.workforce_get_current_access()'::regprocedure)
  ) > 0 as access_payload_has_correction,
  position(
    '''approve_attendance'''
    in pg_get_functiondef('public.workforce_get_current_access()'::regprocedure)
  ) > 0 as access_payload_has_approval,
  position(
    '''correct_attendance'''
    in pg_get_functiondef(
      'public.workforce_admin_save_employee(uuid,text,text,text,text,uuid,uuid,text,jsonb,text)'::regprocedure
    )
  ) > 0 as employee_editor_saves_correction,
  position(
    '''approve_attendance'''
    in pg_get_functiondef(
      'public.workforce_admin_save_employee(uuid,text,text,text,text,uuid,uuid,text,jsonb,text)'::regprocedure
    )
  ) > 0 as employee_editor_saves_approval;

-- ---------------------------------------------------------------------------
-- 5. Blocker queries
-- Every blocker query in section 5 must return zero rows.
-- ---------------------------------------------------------------------------

-- Non-admin profiles must not retain attendance correction or approval grants.
select
  profile.user_id,
  profile.full_name,
  profile.base_role,
  permission.permission_key
from public.user_permissions permission
join public.profiles profile
  on profile.user_id = permission.user_id
where permission.permission_key in ('correct_attendance', 'approve_attendance')
  and permission.is_granted is true
  and profile.base_role <> 'admin'
  and profile.is_system_admin is not true;

-- System administrators must retain both explicit grants.
select
  profile.user_id,
  profile.full_name,
  required.permission_key
from public.profiles profile
cross join (
  values ('correct_attendance'::text), ('approve_attendance'::text)
) as required(permission_key)
left join public.user_permissions permission
  on permission.user_id = profile.user_id
 and permission.permission_key = required.permission_key
 and permission.is_granted is true
where profile.is_system_admin is true
  and permission.id is null;

-- No duplicate permission rows may exist for either new key.
select
  permission.user_id,
  permission.permission_key,
  count(*) as duplicate_count
from public.user_permissions permission
where permission.permission_key in ('correct_attendance', 'approve_attendance')
group by permission.user_id, permission.permission_key
having count(*) > 1;
