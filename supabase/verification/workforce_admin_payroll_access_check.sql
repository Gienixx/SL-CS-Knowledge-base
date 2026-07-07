-- Verify mandatory payroll access for visible and hidden administrators.
-- Run after 2026070702_workforce_admin_payroll_access.sql.

begin;

-- Blocker: should return 0 rows.
select
  profile.full_name,
  profile.email,
  profile.base_role,
  profile.is_system_admin,
  profile.can_manage_payroll,
  permission.is_granted as manage_payroll_permission,
  permission.reason
from public.profiles profile
left join public.user_permissions permission
  on permission.user_id = profile.user_id
 and permission.permission_key = 'manage_payroll'
where (profile.base_role = 'admin' or profile.is_system_admin is true)
  and (
    profile.can_manage_payroll is not true
    or permission.id is null
    or permission.is_granted is not true
  )
order by profile.full_name;

-- Review: all administrators should appear with both values true.
select
  profile.full_name,
  profile.email,
  case
    when profile.is_system_admin is true then 'Hidden System Administrator'
    when profile.base_role = 'admin' and profile.is_agent is true then 'Admin and Agent'
    else 'Admin'
  end as administrator_type,
  profile.can_manage_payroll,
  permission.is_granted as manage_payroll_permission,
  permission.reason
from public.profiles profile
join public.user_permissions permission
  on permission.user_id = profile.user_id
 and permission.permission_key = 'manage_payroll'
where profile.base_role = 'admin'
   or profile.is_system_admin is true
order by profile.full_name;

-- Audit marker: should return at least one recent row after deployment.
select
  action,
  entity_type,
  after_data ->> 'administrator_count' as administrator_count,
  reason,
  created_at
from public.workforce_audit_logs
where action = 'administrator_payroll_access_enabled'
order by created_at desc
limit 5;

rollback;
