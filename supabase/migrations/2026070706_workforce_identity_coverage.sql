-- Workforce identity coverage for all users
-- Apply after 2026070705_workforce_identity_links.sql.

begin;

-- Rebuild inferred alias links only when exactly one unmatched profile fits.
update public.workforce_identity_links
set is_active = false,
    updated_at = now()
where match_method = 'unique_name_alias';

with identities as (
  select
    auth_user.id as auth_user_id,
    lower(trim(auth_user.email)) as auth_email,
    lower(split_part(trim(auth_user.email), '@', 1)) as auth_local,
    lower(trim(coalesce(nullif(login_user.name, ''), ''))) as login_name,
    lower(trim(coalesce(
      nullif(auth_user.raw_user_meta_data ->> 'full_name', ''),
      nullif(auth_user.raw_user_meta_data ->> 'name', ''),
      ''
    ))) as metadata_name
  from auth.users auth_user
  join public.login login_user
    on lower(trim(login_user.email)) = lower(trim(auth_user.email))
), candidates as (
  select distinct
    identity.auth_user_id,
    profile.user_id as profile_user_id
  from identities identity
  join public.profiles profile
    on profile.user_id <> identity.auth_user_id
   and lower(trim(profile.email)) <> identity.auth_email
   and (
     (identity.login_name <> '' and lower(trim(profile.full_name)) = identity.login_name)
     or (identity.metadata_name <> '' and lower(trim(profile.full_name)) = identity.metadata_name)
     or (identity.auth_local <> '' and lower(trim(profile.full_name)) = identity.auth_local)
     or (identity.auth_local <> '' and lower(split_part(trim(profile.email), '@', 1)) = identity.auth_local)
   )
), unique_candidates as (
  select auth_user_id, min(profile_user_id) as profile_user_id
  from candidates
  group by auth_user_id
  having count(distinct profile_user_id) = 1
)
insert into public.workforce_identity_links (
  auth_user_id,
  profile_user_id,
  match_method,
  is_active
)
select auth_user_id, profile_user_id, 'unique_name_alias', true
from unique_candidates
on conflict (auth_user_id, profile_user_id) do update
set match_method = excluded.match_method,
    is_active = true,
    updated_at = now();

-- Keep future exact UUID/email mappings synchronized and revoke stale automatic
-- email links after profile email changes. Manual links are never changed here.
create or replace function public.workforce_sync_identity_link_from_profile()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_auth_user_id uuid;
begin
  select auth_user.id
  into v_auth_user_id
  from auth.users auth_user
  where auth_user.id = new.user_id
     or lower(trim(auth_user.email)) = lower(trim(new.email))
  order by (auth_user.id = new.user_id) desc
  limit 1;

  update public.workforce_identity_links identity_link
  set is_active = false,
      updated_at = now()
  where identity_link.profile_user_id = new.user_id
    and identity_link.match_method = 'exact_email'
    and (v_auth_user_id is null or identity_link.auth_user_id <> v_auth_user_id);

  if v_auth_user_id is not null then
    insert into public.workforce_identity_links (
      auth_user_id,
      profile_user_id,
      match_method,
      is_active
    ) values (
      v_auth_user_id,
      new.user_id,
      case when v_auth_user_id = new.user_id then 'auth_user_id' else 'exact_email' end,
      true
    )
    on conflict (auth_user_id, profile_user_id) do update
    set match_method = excluded.match_method,
        is_active = true,
        updated_at = now();
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_workforce_identity_link on public.profiles;
create trigger profiles_workforce_identity_link
after insert or update of email on public.profiles
for each row execute function public.workforce_sync_identity_link_from_profile();

-- Block partial deployment: every site login must have at least one linked
-- workforce profile. Inactive users remain inactive; this does not change status.
do $$
declare
  v_unresolved text;
begin
  select string_agg(login_user.email, ', ' order by login_user.email)
  into v_unresolved
  from public.login login_user
  join auth.users auth_user
    on lower(trim(auth_user.email)) = lower(trim(login_user.email))
  where not exists (
    select 1
    from public.workforce_identity_links identity_link
    join public.profiles profile on profile.user_id = identity_link.profile_user_id
    where identity_link.auth_user_id = auth_user.id
      and identity_link.is_active is true
  );

  if v_unresolved is not null then
    raise exception 'Unlinked site account(s): %', v_unresolved;
  end if;
end;
$$;

-- Every active agent profile that owns a schedule, attendance, or leave record
-- must be linked to an Auth account so self-service pages can read it.
do $$
declare
  v_unresolved text;
begin
  select string_agg(
    format('%s [%s]', profile.full_name, profile.employee_id),
    ', ' order by profile.full_name, profile.employee_id
  )
  into v_unresolved
  from public.profiles profile
  where profile.employment_status in ('active', 'on_leave')
    and profile.is_agent is true
    and (
      exists (select 1 from public.work_schedules schedule where schedule.user_id = profile.user_id)
      or exists (select 1 from public.attendance attendance_record where attendance_record.user_id = profile.user_id)
      or exists (select 1 from public.leave_requests leave_request where leave_request.user_id = profile.user_id)
    )
    and not exists (
      select 1
      from public.workforce_identity_links identity_link
      where identity_link.profile_user_id = profile.user_id
        and identity_link.is_active is true
    );

  if v_unresolved is not null then
    raise exception 'Unlinked workforce-record owner(s): %', v_unresolved;
  end if;
end;
$$;

-- Do not silently accept ambiguous legacy aliases that own workforce records.
do $$
declare
  v_ambiguous text;
begin
  with identities as (
    select
      auth_user.id as auth_user_id,
      auth_user.email,
      lower(split_part(trim(auth_user.email), '@', 1)) as auth_local,
      lower(trim(coalesce(nullif(login_user.name, ''), ''))) as login_name
    from auth.users auth_user
    join public.login login_user
      on lower(trim(login_user.email)) = lower(trim(auth_user.email))
  ), candidates as (
    select distinct identity.auth_user_id, identity.email, profile.user_id
    from identities identity
    join public.profiles profile
      on profile.user_id <> identity.auth_user_id
     and (
       (identity.login_name <> '' and lower(trim(profile.full_name)) = identity.login_name)
       or (identity.auth_local <> '' and lower(trim(profile.full_name)) = identity.auth_local)
       or (identity.auth_local <> '' and lower(split_part(trim(profile.email), '@', 1)) = identity.auth_local)
     )
    where exists (select 1 from public.work_schedules schedule where schedule.user_id = profile.user_id)
       or exists (select 1 from public.attendance attendance_record where attendance_record.user_id = profile.user_id)
       or exists (select 1 from public.leave_requests leave_request where leave_request.user_id = profile.user_id)
  ), ambiguous as (
    select auth_user_id, email
    from candidates
    group by auth_user_id, email
    having count(distinct user_id) > 1
  )
  select string_agg(email, ', ' order by email)
  into v_ambiguous
  from ambiguous;

  if v_ambiguous is not null then
    raise exception 'Ambiguous identity mapping requires manual review for: %', v_ambiguous;
  end if;
end;
$$;

insert into public.workforce_audit_logs (
  action,
  entity_type,
  after_data,
  reason
)
select
  'workforce_identity_coverage_verified',
  'workforce_identity_links',
  jsonb_build_object(
    'site_account_count', (
      select count(*)
      from auth.users auth_user
      join public.login login_user
        on lower(trim(login_user.email)) = lower(trim(auth_user.email))
    ),
    'linked_auth_accounts', count(distinct auth_user_id),
    'linked_profiles', count(distinct profile_user_id),
    'active_links', count(*)
  ),
  'Verified workforce identity coverage for every current site account and active workforce-record owner'
from public.workforce_identity_links
where is_active is true;

commit;
