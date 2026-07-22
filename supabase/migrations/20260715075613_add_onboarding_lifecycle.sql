-- Add an invitation lifecycle that is independent from employment status.
-- Existing workforce users are activated before the secure `invited` default
-- is installed for profiles created by the invitation flow.

begin;

alter table public.profiles
  add column if not exists onboarding_status text,
  add column if not exists invited_at timestamptz,
  add column if not exists invited_by uuid,
  add column if not exists activated_at timestamptz,
  add column if not exists invitation_last_sent_at timestamptz;

update public.profiles
set onboarding_status = 'active',
    activated_at = coalesce(activated_at, created_at, now())
where onboarding_status is null;

alter table public.profiles
  alter column onboarding_status set default 'invited',
  alter column onboarding_status set not null;

alter table public.profiles
  drop constraint if exists profiles_onboarding_status_check;

alter table public.profiles
  add constraint profiles_onboarding_status_check
  check (onboarding_status in ('invited', 'active'));

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_invited_by_profile_fk'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_invited_by_profile_fk
      foreign key (invited_by)
      references public.profiles(user_id)
      on delete set null;
  end if;
end
$$;

create index if not exists profiles_onboarding_status_idx
  on public.profiles (onboarding_status);

create index if not exists profiles_invited_by_idx
  on public.profiles (invited_by)
  where invited_by is not null;

comment on column public.profiles.onboarding_status is
  'Account invitation lifecycle. This is intentionally independent from employment_status.';
comment on column public.profiles.invited_at is
  'Time the employee profile first entered the invited lifecycle state.';
comment on column public.profiles.invited_by is
  'Workforce profile that initiated the invitation.';
comment on column public.profiles.activated_at is
  'Time the invited employee completed activation.';
comment on column public.profiles.invitation_last_sent_at is
  'Most recent time an invitation email was sent or resent.';

create or replace function public.workforce_set_onboarding_timestamps()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.onboarding_status = 'invited' then
    new.invited_at := coalesce(new.invited_at, now());
    new.activated_at := null;
  elsif new.onboarding_status = 'active' then
    new.activated_at := coalesce(new.activated_at, now());
  end if;

  return new;
end;
$$;

revoke all on function public.workforce_set_onboarding_timestamps() from public;
revoke all on function public.workforce_set_onboarding_timestamps() from anon;
revoke all on function public.workforce_set_onboarding_timestamps() from authenticated;

drop trigger if exists profiles_set_onboarding_timestamps on public.profiles;
create trigger profiles_set_onboarding_timestamps
before insert or update of onboarding_status on public.profiles
for each row execute function public.workforce_set_onboarding_timestamps();

-- This helper is the shared gate used by workforce RLS policies and RPCs.
-- Requiring onboarding activation here prevents an invited Auth user from
-- inheriting workforce access from employment status, role, or permissions.
create or replace function public.workforce_current_user_is_active()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles profile
    where public.workforce_is_current_identity(profile.user_id)
      and profile.employment_status in ('active', 'on_leave')
      and profile.onboarding_status = 'active'
  );
$$;

revoke all on function public.workforce_current_user_is_active() from public;
revoke execute on function public.workforce_current_user_is_active() from anon;
grant execute on function public.workforce_current_user_is_active() to authenticated;

insert into public.workforce_audit_logs (
  actor_user_id,
  action,
  entity_type,
  after_data,
  reason
)
select
  null,
  'onboarding_lifecycle_backfilled',
  'profiles',
  jsonb_build_object(
    'profile_count', count(*),
    'onboarding_status', 'active',
    'employment_status_unchanged', true
  ),
  'Existing workforce profiles activated when onboarding lifecycle was introduced'
from public.profiles;

commit;
