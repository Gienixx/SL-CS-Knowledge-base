-- Complete onboarding only after the invited employee has authenticated and
-- replaced any pre-existing/system password with the password they chose.

begin;

drop trigger if exists auth_user_activate_invited_profile on auth.users;
drop function if exists private.workforce_activate_profile_after_password_created();

create or replace function private.workforce_complete_profile_after_user_password_created()
returns trigger
language plpgsql
security definer
set search_path = private, public, pg_temp
as $$
declare
  v_activated_user_id uuid;
begin
  -- A password alone is not acceptance: legacy accounts may contain a
  -- system-generated temporary password. The user must have authenticated
  -- through the invitation/recovery link before their password change can
  -- complete onboarding.
  if new.last_sign_in_at is null
     or nullif(new.encrypted_password, '') is null then
    return new;
  end if;

  update public.profiles
  set onboarding_status = 'active',
      updated_at = now()
  where user_id = new.id
    and onboarding_status = 'invited'
    and account_deleted_at is null
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
      jsonb_build_object(
        'onboarding_status', 'active',
        'first_sign_in_recorded', true,
        'user_password_created', true
      ),
      'Invited employee authenticated and created their own account password'
    );
  end if;

  return new;
end;
$$;

revoke all on function private.workforce_complete_profile_after_user_password_created()
  from public, anon, authenticated;

create trigger auth_user_complete_invited_profile
after update of encrypted_password on auth.users
for each row
when (old.encrypted_password is distinct from new.encrypted_password)
execute function private.workforce_complete_profile_after_user_password_created();

-- Reconcile active employees against Auth evidence. A profile with no first
-- sign-in must remain invited even when a legacy temporary password exists.
with candidates as (
  select
    profile.user_id,
    profile.onboarding_status as previous_status,
    case
      when auth_user.last_sign_in_at is not null
       and nullif(auth_user.encrypted_password, '') is not null
        then 'active'
      else 'invited'
    end as expected_status
  from public.profiles profile
  join auth.users auth_user
    on auth_user.id = profile.user_id
  where profile.account_deleted_at is null
    and profile.employment_status in ('active', 'on_leave')
),
reconciled as (
  update public.profiles profile
  set onboarding_status = candidate.expected_status,
      updated_at = now()
  from candidates candidate
  where profile.user_id = candidate.user_id
    and profile.onboarding_status is distinct from candidate.expected_status
  returning
    profile.user_id,
    candidate.previous_status,
    candidate.expected_status
)
insert into public.workforce_audit_logs (
  actor_user_id,
  action,
  entity_type,
  entity_id,
  before_data,
  after_data,
  reason
)
select
  null,
  'employee_onboarding_status_reconciled',
  'profiles',
  reconciled.user_id,
  jsonb_build_object('onboarding_status', reconciled.previous_status),
  jsonb_build_object('onboarding_status', reconciled.expected_status),
  'Reconciled onboarding status against first sign-in and password evidence'
from reconciled;

comment on column public.profiles.onboarding_status is
  'Invitation lifecycle: invited until the employee authenticates and creates their own password; active afterward.';

commit;
