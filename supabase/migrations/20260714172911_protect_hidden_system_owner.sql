begin;

create or replace function public.workforce_protect_system_owner_profile()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
begin
  if old.is_system_admin is true and auth.uid() is not null then
    raise exception 'The protected system owner cannot be changed through workforce administration.'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

revoke all on function public.workforce_protect_system_owner_profile() from public;
revoke all on function public.workforce_protect_system_owner_profile() from anon;
revoke all on function public.workforce_protect_system_owner_profile() from authenticated;

drop trigger if exists profiles_protect_system_owner on public.profiles;
create trigger profiles_protect_system_owner
before update or delete on public.profiles
for each row execute function public.workforce_protect_system_owner_profile();

insert into public.workforce_audit_logs (
  action,
  entity_type,
  entity_id,
  after_data,
  reason
)
select
  'system_owner_directory_hidden',
  'profiles',
  profile.user_id,
  jsonb_build_object(
    'employee_id', profile.employee_id,
    'is_system_admin', profile.is_system_admin,
    'permissions_preserved', (
      select count(*)
      from public.user_permissions permission
      where permission.user_id = profile.user_id
        and permission.is_granted
    )
  ),
  'Protected owner remains active but is hidden from Employee Profiles and User Management'
from public.profiles profile
where profile.is_system_admin is true;

comment on function public.workforce_protect_system_owner_profile() is
  'Rejects authenticated workforce attempts to update or delete the protected system owner.';

commit;
