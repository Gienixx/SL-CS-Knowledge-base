do $$
begin
  if exists (
    select 1
    from public.profiles profile
    where lower(profile.email) in ('arez@eurekasurveys.com', 'gen@eurekasurveys.com')
      and not (
        profile.base_role = 'agent'
        and profile.is_agent is true
        and exists (
          select 1 from public.user_permissions permission
          where permission.user_id = profile.user_id
            and permission.permission_key = 'edit_articles'
            and permission.is_granted is true
        )
      )
  ) then
    raise exception 'Arez or Genevive does not have canonical Regular Agent plus Edit articles access.';
  end if;

  if not exists (
    select 1 from public.profiles
    where lower(email) = 'almar@eurekasurveys.com'
      and base_role = 'admin' and is_agent is true
  ) then
    raise exception 'Almar is not Admin and Agent.';
  end if;

  if exists (
    select 1 from public.profiles
    where lower(email) = 'arby.benito10@gmail.com'
  ) and not exists (
    select 1 from public.profiles
    where lower(email) = 'arby.benito10@gmail.com'
      and base_role = 'admin' and is_agent is false and is_system_admin is true
  ) then
    raise exception 'The protected admin is not canonical Admin.';
  end if;

  if has_function_privilege('anon',
    'public.workforce_admin_save_employee_legacy_access_bridge(uuid,text,text,text,text,uuid,uuid,text,jsonb,text)',
    'EXECUTE') then
    raise exception 'Legacy access bridge is exposed to anon.';
  end if;
end
$$;

select full_name, employee_id, base_role, is_agent, is_system_admin,
       coalesce((select is_granted from public.user_permissions permission
                 where permission.user_id = profile.user_id
                   and permission.permission_key = 'edit_articles'), false) as edit_articles
from public.profiles profile
where lower(email) in (
  'arez@eurekasurveys.com', 'gen@eurekasurveys.com',
  'almar@eurekasurveys.com', 'arby.benito10@gmail.com'
)
order by full_name;
