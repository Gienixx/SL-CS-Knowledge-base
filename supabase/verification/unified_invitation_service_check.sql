do $$
begin
  if to_regprocedure(
    'public.workforce_service_create_invitation(uuid,uuid,text,text,text,jsonb,uuid,uuid)'
  ) is null then
    raise exception 'Unified invitation provisioning function is missing';
  end if;

  if has_function_privilege(
    'anon',
    'public.workforce_service_create_invitation(uuid,uuid,text,text,text,jsonb,uuid,uuid)',
    'execute'
  ) or has_function_privilege(
    'authenticated',
    'public.workforce_service_create_invitation(uuid,uuid,text,text,text,jsonb,uuid,uuid)',
    'execute'
  ) then
    raise exception 'Browser roles can execute the invitation provisioning function';
  end if;

  if not has_function_privilege(
    'service_role',
    'public.workforce_service_create_invitation(uuid,uuid,text,text,text,jsonb,uuid,uuid)',
    'execute'
  ) then
    raise exception 'Service role cannot execute the invitation provisioning function';
  end if;
end
$$;

select
  p.proname,
  has_function_privilege('service_role', p.oid, 'execute') as service_role_execute,
  has_function_privilege('authenticated', p.oid, 'execute') as authenticated_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'workforce_service_create_invitation';
