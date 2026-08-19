-- Complete workforce onboarding only after Supabase stores a real password for
-- the invited Auth user. This avoids browser-controlled activation and keeps
-- invitation acceptance separate from employment status.

begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.workforce_activate_profile_after_password_created()
returns trigger
language plpgsql
security definer
set search_path = private, public, pg_temp
as $$
declare
  v_activated_user_id uuid;
begin
  if nullif(new.encrypted_password, '') is null then
    return new;
  end if;

  update public.profiles
  set onboarding_status = 'active',
      updated_at = now()
  where user_id = new.id
    and onboarding_status = 'invited'
  returning user_id into v_activated_user_id;

  if v_activated_user_id is not null then
    insert into public.workforce_audit_logs (
      actor_user_id,
      action,
      entity_type,
      entity_id,
      after_data,
      reason
    ) values (
      v_activated_user_id,
      'employee_invitation_accepted',
      'profiles',
      v_activated_user_id,
      jsonb_build_object('onboarding_status', 'active'),
      'Invited employee created their account password'
    );
  end if;

  return new;
end;
$$;

revoke all on function private.workforce_activate_profile_after_password_created()
  from public, anon, authenticated;

drop trigger if exists auth_user_activate_invited_profile on auth.users;
create trigger auth_user_activate_invited_profile
after update of encrypted_password on auth.users
for each row
when (old.encrypted_password is distinct from new.encrypted_password)
execute function private.workforce_activate_profile_after_password_created();

commit;
