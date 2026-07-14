-- Run after 20260714160959_transfer_system_ownership_to_admin.sql.

select
  full_name,
  employee_id,
  email,
  base_role,
  is_agent,
  is_system_admin,
  employment_status
from public.profiles
where is_system_admin is true;

-- Must return exactly nine true permissions for the dedicated admin account.
select permission.permission_key, permission.is_granted
from public.profiles profile
join public.user_permissions permission on permission.user_id = profile.user_id
where lower(profile.email) = lower('arby.benito10@gmail.com')
order by permission.permission_key;

-- Must return zero granted permissions and no protected owner flag.
select
  profile.is_system_admin,
  profile.base_role,
  profile.is_agent,
  count(*) filter (where permission.is_granted) as granted_permissions
from public.profiles profile
left join public.user_permissions permission on permission.user_id = profile.user_id
where lower(profile.email) = lower('arby@eurekasurveys.com')
group by profile.user_id;

select
  count(*) filter (
    where is_system_admin is true
      and employment_status in ('active', 'on_leave')
  ) as active_system_owners,
  count(*) filter (where is_system_admin is true) as total_system_owners
from public.profiles;

select
  indexname,
  indexdef
from pg_indexes
where schemaname = 'public'
  and indexname = 'profiles_single_system_owner_idx';

select
  trigger_name,
  action_timing
from information_schema.triggers
where trigger_schema = 'public'
  and trigger_name = 'profiles_require_single_active_system_owner';

select action, before_data, after_data, reason, created_at
from public.workforce_audit_logs
where action in ('system_ownership_transfer_started', 'system_ownership_transferred')
order by created_at desc;
