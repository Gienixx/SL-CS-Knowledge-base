select
  profile.employee_id,
  profile.email,
  profile.is_system_admin,
  profile.employment_status,
  count(*) filter (where permission.is_granted) as granted_permissions
from public.profiles profile
left join public.user_permissions permission on permission.user_id = profile.user_id
where profile.is_system_admin is true
group by profile.user_id;

select exists (
  select 1
  from pg_trigger
  where tgrelid = 'public.profiles'::regclass
    and tgname = 'profiles_protect_system_owner'
    and tgenabled <> 'D'
) as owner_profile_protection_enabled;

select action, entity_id, after_data, reason, created_at
from public.workforce_audit_logs
where action = 'system_owner_directory_hidden'
order by created_at desc
limit 5;
