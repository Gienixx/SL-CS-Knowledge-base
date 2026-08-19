-- Keep a non-sensitive, administrator-visible delivery timestamp on the
-- archived workforce profile. The restoration email itself remains hashed in
-- the private reinvite table until the employee accepts the invitation.
create or replace function private.workforce_sync_deleted_employee_reinvite_timestamp()
returns trigger
language plpgsql
security definer
set search_path = private, public, pg_temp
as $$
begin
  update public.profiles
  set invitation_last_sent_at = new.last_sent_at,
      updated_at = now()
  where user_id = new.profile_user_id
    and account_deleted_at is not null;

  return new;
end;
$$;

revoke all on function private.workforce_sync_deleted_employee_reinvite_timestamp()
  from public, anon, authenticated;

drop trigger if exists workforce_sync_deleted_employee_reinvite_timestamp
  on private.workforce_deleted_employee_reinvites;

create trigger workforce_sync_deleted_employee_reinvite_timestamp
after insert or update of last_sent_at
on private.workforce_deleted_employee_reinvites
for each row
execute function private.workforce_sync_deleted_employee_reinvite_timestamp();

-- Backfill invitations that were already sent before this indicator existed.
update public.profiles profile
set invitation_last_sent_at = reinvite.last_sent_at,
    updated_at = now()
from (
  select distinct on (profile_user_id)
    profile_user_id,
    last_sent_at
  from private.workforce_deleted_employee_reinvites
  order by profile_user_id, last_sent_at desc
) reinvite
where profile.user_id = reinvite.profile_user_id
  and profile.account_deleted_at is not null
  and profile.invitation_last_sent_at is distinct from reinvite.last_sent_at;

comment on function private.workforce_sync_deleted_employee_reinvite_timestamp() is
  'Persists the latest deleted-employee restoration invitation delivery time on the archived workforce profile for administrator visibility.';
