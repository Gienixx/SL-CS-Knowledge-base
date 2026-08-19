-- Reinvite a deleted employee without creating a second workforce identity.
--
-- Sending the invitation only creates a pending request. The archived profile,
-- employee ID, permissions, attendance, and payroll history remain untouched
-- until the recipient accepts the Supabase link. Acceptance restores the
-- profile as Invited; creating a password completes onboarding as Active.

begin;

create table if not exists private.workforce_deleted_employee_identities (
  profile_user_id uuid primary key
    references public.profiles(user_id) on delete cascade,
  email_hash bytea not null,
  prior_employment_status text not null default 'active',
  prior_team_id uuid,
  prior_supervisor_id uuid,
  deleted_at timestamptz not null,
  deleted_by uuid,
  restored_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workforce_deleted_identity_prior_status_check check (
    prior_employment_status in ('active', 'on_leave', 'inactive', 'terminated')
  )
);

create index if not exists workforce_deleted_identity_email_hash_idx
  on private.workforce_deleted_employee_identities (email_hash)
  where restored_at is null;

alter table private.workforce_deleted_employee_identities enable row level security;
revoke all on table private.workforce_deleted_employee_identities
  from public, anon, authenticated;

create table if not exists private.workforce_deleted_employee_reinvites (
  auth_user_id uuid primary key,
  profile_user_id uuid not null
    references public.profiles(user_id) on delete cascade,
  email_hash bytea not null,
  requested_by uuid not null
    references public.profiles(user_id) on delete restrict,
  status text not null default 'pending',
  requested_at timestamptz not null default now(),
  last_sent_at timestamptz not null default now(),
  accepted_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workforce_deleted_employee_reinvites_status_check check (
    status in ('pending', 'accepted', 'completed', 'cancelled')
  )
);

create unique index if not exists workforce_deleted_reinvite_open_profile_idx
  on private.workforce_deleted_employee_reinvites (profile_user_id)
  where status in ('pending', 'accepted');

create index if not exists workforce_deleted_reinvite_profile_idx
  on private.workforce_deleted_employee_reinvites (profile_user_id, requested_at desc);

alter table private.workforce_deleted_employee_reinvites enable row level security;
revoke all on table private.workforce_deleted_employee_reinvites
  from public, anon, authenticated;

comment on table private.workforce_deleted_employee_identities is
  'Hashed former sign-in identities for deleted workforce profiles. Plaintext former email addresses are not stored here.';
comment on table private.workforce_deleted_employee_reinvites is
  'Pending Auth invitations that restore an archived workforce profile only after invite acceptance.';

-- Backfill the one deleted profile population from immutable workforce audit
-- history. This keeps the active profile and login tables free of the old email.
with deleted_history as (
  select
    profile.user_id as profile_user_id,
    profile.account_deleted_at as deleted_at,
    profile.account_deleted_by as deleted_by,
    historic.email,
    coalesce(historic.prior_employment_status, 'active') as prior_employment_status,
    historic.prior_team_id,
    historic.prior_supervisor_id
  from public.profiles profile
  cross join lateral (
    select
      candidate.email,
      candidate.prior_employment_status,
      candidate.prior_team_id,
      candidate.prior_supervisor_id
    from (
      select
        coalesce(
          nullif(trim(audit.before_data ->> 'email'), ''),
          nullif(trim(audit.after_data ->> 'email'), '')
        ) as email,
        nullif(trim(audit.before_data ->> 'employment_status'), '') as prior_employment_status,
        case
          when coalesce(audit.before_data ->> 'team_id', '') ~*
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            then (audit.before_data ->> 'team_id')::uuid
          else null
        end as prior_team_id,
        case
          when coalesce(audit.before_data ->> 'supervisor_id', '') ~*
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            then (audit.before_data ->> 'supervisor_id')::uuid
          else null
        end as prior_supervisor_id,
        audit.created_at
      from public.workforce_audit_logs audit
      where audit.entity_id = profile.user_id
        and audit.created_at <= profile.account_deleted_at + interval '1 minute'
    ) candidate
    where candidate.email is not null
      and candidate.email not like 'deleted-%@deleted.invalid'
    order by candidate.created_at desc
    limit 1
  ) historic
  where profile.account_deleted_at is not null
)
insert into private.workforce_deleted_employee_identities (
  profile_user_id,
  email_hash,
  prior_employment_status,
  prior_team_id,
  prior_supervisor_id,
  deleted_at,
  deleted_by
)
select
  history.profile_user_id,
  extensions.digest(lower(trim(history.email)), 'sha256'),
  history.prior_employment_status,
  history.prior_team_id,
  history.prior_supervisor_id,
  history.deleted_at,
  history.deleted_by
from deleted_history history
on conflict (profile_user_id) do update
set email_hash = excluded.email_hash,
    prior_employment_status = excluded.prior_employment_status,
    prior_team_id = excluded.prior_team_id,
    prior_supervisor_id = excluded.prior_supervisor_id,
    deleted_at = excluded.deleted_at,
    deleted_by = excluded.deleted_by,
    restored_at = null,
    updated_at = now();

create or replace function private.workforce_service_reinvite_actor_profile(
  p_actor_auth_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = private, public, pg_temp
as $$
declare
  v_actor_profile_id uuid;
begin
  select profile.user_id
  into v_actor_profile_id
  from public.workforce_identity_links identity_link
  join public.profiles profile
    on profile.user_id = identity_link.profile_user_id
  where identity_link.auth_user_id = p_actor_auth_user_id
    and identity_link.is_active is true
    and profile.employment_status in ('active', 'on_leave')
    and profile.onboarding_status = 'active'
    and profile.account_deleted_at is null
    and (
      profile.is_system_admin is true
      or (
        profile.base_role = 'admin'
        and exists (
          select 1
          from public.user_permissions permission
          where permission.user_id = profile.user_id
            and permission.permission_key = 'manage_employees'
            and permission.is_granted is true
        )
      )
    )
  order by (profile.user_id = p_actor_auth_user_id) desc
  limit 1;

  if v_actor_profile_id is null then
    raise exception 'You do not have permission to reinvite deleted employees.'
      using errcode = '42501';
  end if;

  return v_actor_profile_id;
end;
$$;

revoke all on function private.workforce_service_reinvite_actor_profile(uuid)
  from public, anon, authenticated;

create or replace function public.workforce_service_get_deleted_employee_reinvite(
  p_actor_auth_user_id uuid,
  p_profile_user_id uuid,
  p_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_actor_profile_id uuid;
  v_profile public.profiles%rowtype;
  v_email_hash bytea;
  v_open_request private.workforce_deleted_employee_reinvites%rowtype;
  v_match_count integer;
begin
  v_actor_profile_id :=
    private.workforce_service_reinvite_actor_profile(p_actor_auth_user_id);
  v_email_hash := extensions.digest(lower(trim(coalesce(p_email, ''))), 'sha256');

  select *
  into v_profile
  from public.profiles
  where user_id = p_profile_user_id
  for update;

  if not found or v_profile.account_deleted_at is null then
    raise exception 'The selected employee is not an archived deleted account.';
  end if;
  if v_profile.is_system_admin is true then
    raise exception 'The protected system owner cannot be reinvited this way.'
      using errcode = '42501';
  end if;

  select count(*)
  into v_match_count
  from private.workforce_deleted_employee_identities deleted_identity
  where deleted_identity.profile_user_id = p_profile_user_id
    and deleted_identity.email_hash = v_email_hash
    and deleted_identity.restored_at is null;

  if v_match_count <> 1 then
    raise exception 'Enter the email address that belonged to this deleted employee.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.profiles profile
    where profile.account_deleted_at is null
      and lower(profile.email) = lower(trim(p_email))
  ) or exists (
    select 1
    from public.login login_row
    where lower(login_row.email) = lower(trim(p_email))
  ) then
    raise exception 'This email is already attached to an active workforce account.'
      using errcode = '23505';
  end if;

  select *
  into v_open_request
  from private.workforce_deleted_employee_reinvites reinvite
  where reinvite.profile_user_id = p_profile_user_id
    and reinvite.status = 'pending'
  order by reinvite.requested_at desc
  limit 1;

  return jsonb_build_object(
    'mode', case when v_open_request.auth_user_id is null then 'new' else 'resend' end,
    'auth_user_id', v_open_request.auth_user_id,
    'profile_user_id', v_profile.user_id,
    'employee_id', v_profile.employee_id,
    'full_name', v_profile.full_name,
    'requested_by', v_actor_profile_id,
    'restoration_pending', v_open_request.auth_user_id is not null
  );
end;
$$;

revoke all on function public.workforce_service_get_deleted_employee_reinvite(
  uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.workforce_service_get_deleted_employee_reinvite(
  uuid, uuid, text
) to service_role;

create or replace function public.workforce_service_prepare_deleted_employee_reinvite(
  p_actor_auth_user_id uuid,
  p_profile_user_id uuid,
  p_auth_user_id uuid,
  p_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_actor_profile_id uuid;
  v_profile public.profiles%rowtype;
  v_email_hash bytea;
begin
  v_actor_profile_id :=
    private.workforce_service_reinvite_actor_profile(p_actor_auth_user_id);
  v_email_hash := extensions.digest(lower(trim(coalesce(p_email, ''))), 'sha256');

  select *
  into v_profile
  from public.profiles
  where user_id = p_profile_user_id
  for update;

  if not found or v_profile.account_deleted_at is null then
    raise exception 'The selected employee is not an archived deleted account.';
  end if;
  if v_profile.is_system_admin is true then
    raise exception 'The protected system owner cannot be reinvited this way.'
      using errcode = '42501';
  end if;
  if not exists (
    select 1
    from private.workforce_deleted_employee_identities deleted_identity
    where deleted_identity.profile_user_id = p_profile_user_id
      and deleted_identity.email_hash = v_email_hash
      and deleted_identity.restored_at is null
  ) then
    raise exception 'The deleted employee email does not match the archived identity.';
  end if;
  if p_auth_user_id is null or not exists (
    select 1
    from auth.users auth_user
    where auth_user.id = p_auth_user_id
      and lower(auth_user.email) = lower(trim(p_email))
      and auth_user.last_sign_in_at is null
  ) then
    raise exception 'The pending Auth invitation does not match this employee.';
  end if;
  if exists (
    select 1
    from private.workforce_deleted_employee_reinvites reinvite
    where reinvite.profile_user_id = p_profile_user_id
      and reinvite.status in ('pending', 'accepted')
  ) then
    raise exception 'A restoration invitation is already pending for this employee.'
      using errcode = '23505';
  end if;

  insert into private.workforce_deleted_employee_reinvites (
    auth_user_id,
    profile_user_id,
    email_hash,
    requested_by
  ) values (
    p_auth_user_id,
    p_profile_user_id,
    v_email_hash,
    v_actor_profile_id
  );

  insert into public.workforce_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    after_data,
    reason
  ) values (
    v_actor_profile_id,
    'deleted_employee_reinvite_sent',
    'profiles',
    p_profile_user_id,
    jsonb_build_object(
      'employee_id', v_profile.employee_id,
      'auth_user_id', p_auth_user_id,
      'restoration_pending', true,
      'profile_still_archived', true
    ),
    'Invitation sent; restoration waits for recipient acceptance'
  );

  return jsonb_build_object(
    'profile_user_id', p_profile_user_id,
    'auth_user_id', p_auth_user_id,
    'employee_id', v_profile.employee_id,
    'full_name', v_profile.full_name,
    'restoration_pending', true,
    'profile_still_archived', true
  );
end;
$$;

revoke all on function public.workforce_service_prepare_deleted_employee_reinvite(
  uuid, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.workforce_service_prepare_deleted_employee_reinvite(
  uuid, uuid, uuid, text
) to service_role;

create or replace function public.workforce_service_mark_deleted_employee_reinvite_resent(
  p_actor_auth_user_id uuid,
  p_profile_user_id uuid,
  p_auth_user_id uuid,
  p_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_actor_profile_id uuid;
  v_employee_id text;
  v_email_hash bytea;
begin
  v_actor_profile_id :=
    private.workforce_service_reinvite_actor_profile(p_actor_auth_user_id);
  v_email_hash := extensions.digest(lower(trim(coalesce(p_email, ''))), 'sha256');

  update private.workforce_deleted_employee_reinvites reinvite
  set last_sent_at = now(),
      updated_at = now()
  where reinvite.profile_user_id = p_profile_user_id
    and reinvite.auth_user_id = p_auth_user_id
    and reinvite.email_hash = v_email_hash
    and reinvite.status = 'pending';

  if not found then
    raise exception 'No matching pending restoration invitation was found.';
  end if;

  select profile.employee_id
  into v_employee_id
  from public.profiles profile
  where profile.user_id = p_profile_user_id
    and profile.account_deleted_at is not null;

  insert into public.workforce_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    after_data,
    reason
  ) values (
    v_actor_profile_id,
    'deleted_employee_reinvite_resent',
    'profiles',
    p_profile_user_id,
    jsonb_build_object(
      'employee_id', v_employee_id,
      'auth_user_id', p_auth_user_id,
      'restoration_pending', true,
      'profile_still_archived', true
    ),
    'Pending deleted-employee restoration invitation resent'
  );

  return jsonb_build_object(
    'profile_user_id', p_profile_user_id,
    'auth_user_id', p_auth_user_id,
    'employee_id', v_employee_id,
    'restoration_pending', true,
    'profile_still_archived', true
  );
end;
$$;

revoke all on function public.workforce_service_mark_deleted_employee_reinvite_resent(
  uuid, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.workforce_service_mark_deleted_employee_reinvite_resent(
  uuid, uuid, uuid, text
) to service_role;

create or replace function private.workforce_restore_deleted_employee_after_invite_acceptance()
returns trigger
language plpgsql
security definer
set search_path = private, public, auth, pg_temp
as $$
declare
  v_reinvite private.workforce_deleted_employee_reinvites%rowtype;
  v_deleted_identity private.workforce_deleted_employee_identities%rowtype;
  v_profile public.profiles%rowtype;
  v_email text := lower(trim(coalesce(new.email, '')));
  v_restored_team_id uuid;
  v_restored_supervisor_id uuid;
begin
  if new.last_sign_in_at is null
     or old.last_sign_in_at is not distinct from new.last_sign_in_at then
    return new;
  end if;

  select *
  into v_reinvite
  from private.workforce_deleted_employee_reinvites reinvite
  where reinvite.auth_user_id = new.id
    and reinvite.status = 'pending'
  for update;

  if not found then
    return new;
  end if;

  select *
  into v_deleted_identity
  from private.workforce_deleted_employee_identities deleted_identity
  where deleted_identity.profile_user_id = v_reinvite.profile_user_id
    and deleted_identity.restored_at is null
  for update;

  select *
  into v_profile
  from public.profiles profile
  where profile.user_id = v_reinvite.profile_user_id
    and profile.account_deleted_at is not null
  for update;

  if v_deleted_identity.profile_user_id is null
     or v_profile.user_id is null
     or v_email = ''
     or extensions.digest(v_email, 'sha256') <> v_reinvite.email_hash
     or v_deleted_identity.email_hash <> v_reinvite.email_hash then
    update private.workforce_deleted_employee_reinvites
    set status = 'cancelled',
        completed_at = now(),
        updated_at = now()
    where auth_user_id = new.id;
    return new;
  end if;

  if exists (
    select 1
    from public.profiles profile
    where profile.user_id <> v_profile.user_id
      and profile.account_deleted_at is null
      and lower(profile.email) = v_email
  ) or exists (
    select 1
    from public.login login_row
    where lower(login_row.email) = v_email
  ) then
    raise exception 'The reinvited email is already attached to another workforce identity.';
  end if;

  select team.id
  into v_restored_team_id
  from public.teams team
  where team.id = v_deleted_identity.prior_team_id
    and team.is_active is true;

  select supervisor.user_id
  into v_restored_supervisor_id
  from public.profiles supervisor
  where supervisor.user_id = v_deleted_identity.prior_supervisor_id
    and supervisor.account_deleted_at is null
    and supervisor.employment_status in ('active', 'on_leave')
    and supervisor.onboarding_status = 'active';

  update public.workforce_identity_links
  set is_active = false,
      updated_at = now()
  where profile_user_id = v_profile.user_id;

  update public.profiles
  set email = v_email,
      employment_status = 'active',
      onboarding_status = 'invited',
      invited_at = v_reinvite.requested_at,
      invited_by = v_reinvite.requested_by,
      invitation_last_sent_at = v_reinvite.last_sent_at,
      activated_at = null,
      account_deleted_at = null,
      account_deleted_by = null,
      team_id = v_restored_team_id,
      supervisor_id = v_restored_supervisor_id,
      updated_at = now()
  where user_id = v_profile.user_id;

  insert into public.workforce_identity_links (
    auth_user_id,
    profile_user_id,
    match_method,
    is_active
  ) values (
    new.id,
    v_profile.user_id,
    'manual',
    true
  )
  on conflict (auth_user_id, profile_user_id) do update
  set match_method = excluded.match_method,
      is_active = true,
      updated_at = now();

  insert into public.login (
    name,
    email,
    is_admin,
    can_edit_articles
  ) values (
    v_profile.full_name,
    v_email,
    v_profile.base_role = 'admin',
    coalesce((
      select permission.is_granted
      from public.user_permissions permission
      where permission.user_id = v_profile.user_id
        and permission.permission_key = 'edit_articles'
      limit 1
    ), false)
  );

  update private.workforce_deleted_employee_identities
  set restored_at = now(),
      updated_at = now()
  where profile_user_id = v_profile.user_id;

  update private.workforce_deleted_employee_reinvites
  set status = 'accepted',
      accepted_at = now(),
      updated_at = now()
  where auth_user_id = new.id;

  insert into public.workforce_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    before_data,
    after_data,
    reason
  ) values (
    v_profile.user_id,
    'deleted_employee_restoration_started',
    'profiles',
    v_profile.user_id,
    jsonb_build_object(
      'account_deleted_at', v_profile.account_deleted_at,
      'employment_status', v_profile.employment_status,
      'onboarding_status', v_profile.onboarding_status
    ),
    jsonb_build_object(
      'auth_user_id', new.id,
      'employee_id', v_profile.employee_id,
      'account_deleted_at', null,
      'employment_status', 'active',
      'onboarding_status', 'invited',
      'history_preserved', true
    ),
    'Recipient accepted the restoration invitation; password creation remains required'
  );

  return new;
end;
$$;

revoke all on function private.workforce_restore_deleted_employee_after_invite_acceptance()
  from public, anon, authenticated;

drop trigger if exists auth_user_restore_deleted_employee_after_invite_acceptance
  on auth.users;
create trigger auth_user_restore_deleted_employee_after_invite_acceptance
after update of last_sign_in_at on auth.users
for each row
when (
  old.last_sign_in_at is distinct from new.last_sign_in_at
  and new.last_sign_in_at is not null
)
execute function private.workforce_restore_deleted_employee_after_invite_acceptance();

-- Activation must resolve the workforce profile through the active identity
-- link because a reinvited Auth UUID intentionally differs from the stable
-- employee/workforce UUID.
create or replace function private.workforce_complete_profile_after_user_password_created()
returns trigger
language plpgsql
security definer
set search_path = private, public, pg_temp
as $$
declare
  v_activated_user_id uuid;
begin
  if new.last_sign_in_at is null
     or nullif(new.encrypted_password, '') is null then
    return new;
  end if;

  select profile.user_id
  into v_activated_user_id
  from public.workforce_identity_links identity_link
  join public.profiles profile
    on profile.user_id = identity_link.profile_user_id
  where identity_link.auth_user_id = new.id
    and identity_link.is_active is true
    and profile.onboarding_status = 'invited'
    and profile.account_deleted_at is null
  order by (profile.user_id = new.id) desc, profile.created_at asc
  limit 1
  for update of profile;

  if v_activated_user_id is not null then
    update public.profiles
    set onboarding_status = 'active',
        activated_at = coalesce(activated_at, now()),
        updated_at = now()
    where user_id = v_activated_user_id;

    update private.workforce_deleted_employee_reinvites
    set status = 'completed',
        completed_at = now(),
        updated_at = now()
    where auth_user_id = new.id
      and profile_user_id = v_activated_user_id
      and status = 'accepted';

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
        'auth_user_id', new.id,
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

-- Future deletions retain only a one-way hash of the released email plus the
-- team/supervisor values needed for a controlled restoration.
create or replace function public.workforce_admin_change_employee_lifecycle(
  p_user_id uuid,
  p_action text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_action text := lower(trim(coalesce(p_action, '')));
  v_before_status text;
  v_after_status text;
  v_deleted_email text;
  v_now timestamptz := now();
begin
  if auth.uid() is null
     or not public.workforce_is_admin()
     or not public.workforce_has_permission('manage_employees') then
    raise exception 'You do not have permission to manage employee lifecycles.'
      using errcode = '42501';
  end if;
  if p_user_id is null or v_action not in ('deactivate', 'reactivate', 'delete') then
    raise exception 'Employee and a valid lifecycle action are required.';
  end if;

  select *
  into v_profile
  from public.profiles
  where user_id = p_user_id
  for update;

  if not found then
    raise exception 'Employee profile not found.';
  end if;
  if v_profile.is_system_admin then
    raise exception 'The protected system owner cannot be deactivated or deleted.'
      using errcode = '42501';
  end if;
  if public.workforce_is_current_identity(p_user_id) then
    raise exception 'You cannot change the lifecycle of your own administrator account.'
      using errcode = '42501';
  end if;
  if v_profile.account_deleted_at is not null and v_action <> 'delete' then
    raise exception 'A deleted Auth account cannot be reactivated; use the controlled reinvite process.';
  end if;

  v_before_status := v_profile.employment_status;
  v_after_status := case v_action
    when 'deactivate' then 'inactive'
    when 'reactivate' then 'active'
    when 'delete' then 'terminated'
  end;
  v_deleted_email :=
    'deleted-' || replace(p_user_id::text, '-', '') || '@deleted.invalid';

  if v_action = 'delete' then
    insert into private.workforce_deleted_employee_identities (
      profile_user_id,
      email_hash,
      prior_employment_status,
      prior_team_id,
      prior_supervisor_id,
      deleted_at,
      deleted_by,
      restored_at
    ) values (
      p_user_id,
      extensions.digest(lower(trim(v_profile.email)), 'sha256'),
      v_profile.employment_status,
      v_profile.team_id,
      v_profile.supervisor_id,
      v_now,
      auth.uid(),
      null
    )
    on conflict (profile_user_id) do update
    set email_hash = excluded.email_hash,
        prior_employment_status = excluded.prior_employment_status,
        prior_team_id = excluded.prior_team_id,
        prior_supervisor_id = excluded.prior_supervisor_id,
        deleted_at = excluded.deleted_at,
        deleted_by = excluded.deleted_by,
        restored_at = null,
        updated_at = now();

    update private.workforce_deleted_employee_reinvites
    set status = 'cancelled',
        completed_at = v_now,
        updated_at = v_now
    where profile_user_id = p_user_id
      and status in ('pending', 'accepted');

    delete from public.login
    where lower(email) = lower(v_profile.email);
  end if;

  update public.profiles
  set employment_status = v_after_status,
      email = case when v_action = 'delete' then v_deleted_email else email end,
      account_deleted_at =
        case when v_action = 'delete' then v_now else account_deleted_at end,
      account_deleted_by =
        case when v_action = 'delete' then auth.uid() else account_deleted_by end,
      team_id = case when v_action = 'delete' then null else team_id end,
      supervisor_id =
        case when v_action in ('deactivate', 'delete') then null else supervisor_id end,
      updated_at = v_now
  where user_id = p_user_id;

  if v_action = 'delete' then
    update public.workforce_identity_links
    set is_active = false,
        updated_at = v_now
    where profile_user_id = p_user_id;
  end if;

  if v_action in ('deactivate', 'delete') then
    update public.profiles
    set supervisor_id = null,
        updated_at = v_now
    where supervisor_id = p_user_id
      and is_system_admin is false;
  end if;

  insert into public.workforce_audit_logs (
    actor_user_id, action, entity_type, entity_id, before_data, after_data, reason
  ) values (
    auth.uid(),
    'employee_' || v_action || 'd',
    'profiles',
    p_user_id,
    jsonb_build_object(
      'employment_status', v_before_status,
      'account_deleted_at', v_profile.account_deleted_at
    ),
    jsonb_build_object(
      'employment_status', v_after_status,
      'account_deleted_at',
      case when v_action = 'delete' then v_now else v_profile.account_deleted_at end,
      'email_released', v_action = 'delete',
      'reinvite_identity_hash_retained', v_action = 'delete'
    ),
    nullif(trim(coalesce(p_reason, '')), '')
  );

  return jsonb_build_object(
    'user_id', p_user_id,
    'action', v_action,
    'employment_status', v_after_status,
    'history_preserved', true,
    'email_released', v_action = 'delete',
    'controlled_reinvite_available', v_action = 'delete'
  );
end;
$$;

revoke all on function public.workforce_admin_change_employee_lifecycle(
  uuid, text, text
) from public, anon;
grant execute on function public.workforce_admin_change_employee_lifecycle(
  uuid, text, text
) to authenticated;

commit;
