do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles'
      and column_name = 'account_deleted_at'
  ) then raise exception 'profiles.account_deleted_at is missing'; end if;

  if to_regprocedure('public.workforce_admin_change_employee_lifecycle(uuid,text,text)') is null then
    raise exception 'Employee lifecycle RPC is missing';
  end if;

  if has_function_privilege('anon', 'public.workforce_admin_change_employee_lifecycle(uuid,text,text)', 'EXECUTE') then
    raise exception 'Anonymous users can execute the employee lifecycle RPC';
  end if;

  if not has_function_privilege('authenticated', 'public.workforce_admin_change_employee_lifecycle(uuid,text,text)', 'EXECUTE') then
    raise exception 'Authenticated administrators cannot execute the lifecycle RPC';
  end if;
end $$;

select
  count(*) filter (where is_system_admin and account_deleted_at is not null) as deleted_system_owners,
  count(*) filter (where account_deleted_at is not null and employment_status <> 'terminated') as invalid_deleted_profiles
from public.profiles;
