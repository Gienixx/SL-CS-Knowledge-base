alter table public.profiles
  add column if not exists restoration_invite_pending boolean not null default false;

comment on column public.profiles.restoration_invite_pending is
  'True only while a deleted employee has a pending restoration invitation.';

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
  v_delivery_email text;
  v_email_hash bytea;
  v_open_request private.workforce_deleted_employee_reinvites%rowtype;
  v_match_count integer;
begin
  v_actor_profile_id :=
    private.workforce_service_reinvite_actor_profile(p_actor_auth_user_id);

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

  select *
  into v_open_request
  from private.workforce_deleted_employee_reinvites reinvite
  where reinvite.profile_user_id = p_profile_user_id
    and reinvite.status = 'pending'
  order by reinvite.requested_at desc
  limit 1;

  v_delivery_email := lower(trim(coalesce(p_email, '')));

  if v_delivery_email = '' then
    if v_open_request.auth_user_id is null then
      raise exception 'Enter the email address that belonged to this deleted employee.'
        using errcode = '22023';
    end if;

    select lower(trim(auth_user.email))
    into v_delivery_email
    from auth.users auth_user
    where auth_user.id = v_open_request.auth_user_id
      and auth_user.last_sign_in_at is null;

    if coalesce(v_delivery_email, '') = '' then
      raise exception 'The pending restoration invitation no longer has a valid Auth recipient.'
        using errcode = '22023';
    end if;
  end if;

  v_email_hash := extensions.digest(v_delivery_email, 'sha256');

  select count(*)
  into v_match_count
  from private.workforce_deleted_employee_identities deleted_identity
  where deleted_identity.profile_user_id = p_profile_user_id
    and deleted_identity.email_hash = v_email_hash
    and deleted_identity.restored_at is null;

  if v_match_count <> 1
     or (
       v_open_request.auth_user_id is not null
       and v_open_request.email_hash <> v_email_hash
     ) then
    raise exception 'Enter the email address that belonged to this deleted employee.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.profiles profile
    where profile.account_deleted_at is null
      and lower(profile.email) = v_delivery_email
  ) or exists (
    select 1
    from public.login login_row
    where lower(login_row.email) = v_delivery_email
  ) then
    raise exception 'This email is already attached to an active workforce account.'
      using errcode = '23505';
  end if;

  return jsonb_build_object(
    'mode', case when v_open_request.auth_user_id is null then 'new' else 'resend' end,
    'auth_user_id', v_open_request.auth_user_id,
    'profile_user_id', v_profile.user_id,
    'employee_id', v_profile.employee_id,
    'full_name', v_profile.full_name,
    'delivery_email', v_delivery_email,
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

create or replace function private.workforce_sync_deleted_employee_reinvite_timestamp()
returns trigger
language plpgsql
security definer
set search_path = private, public, pg_temp
as $$
begin
  update public.profiles
  set invitation_last_sent_at = case
        when new.status = 'pending' then new.last_sent_at
        else invitation_last_sent_at
      end,
      restoration_invite_pending = new.status = 'pending',
      updated_at = now()
  where user_id = new.profile_user_id;

  return new;
end;
$$;

revoke all on function private.workforce_sync_deleted_employee_reinvite_timestamp()
  from public, anon, authenticated;

update public.profiles profile
set restoration_invite_pending = exists (
      select 1
      from private.workforce_deleted_employee_reinvites reinvite
      where reinvite.profile_user_id = profile.user_id
        and reinvite.status = 'pending'
    ),
    updated_at = now()
where profile.account_deleted_at is not null
  and profile.restoration_invite_pending is distinct from exists (
    select 1
    from private.workforce_deleted_employee_reinvites reinvite
    where reinvite.profile_user_id = profile.user_id
      and reinvite.status = 'pending'
  );
