-- Workforce identity coverage hardening
--
-- Apply immediately after 2026070705_workforce_identity_links.sql.
-- This migration ensures the identity fix covers the entire current site user
-- population and fails transactionally when an account or scheduled profile
-- remains unresolved.

begin;

-- Re-evaluate legacy alias links conservatively. Exact UUID, exact-email, and
-- manually approved links are preserved. Automatically inferred aliases are
-- active only when exactly one unmatched workforce profile fits the Auth user.
update public.workforce_identity_links
set is_active = false,
    updated_at = now()
where match_method = 'unique_name_alias';

create temporary table workforce_identity_alias_candidates on commit drop as
with auth_identity as (
  select
    auth_user.id as auth_user_id,
    lower(trim(auth_user.email)) as auth_email,
    lower(split_part(trim(auth_user.email), '@', 1)) as auth_local_part,
    lower(trim(coalesce(nullif(login_user.name, ''), ''))) as login_name,
    lower(trim(coalesce(
      nullif(auth_user.raw_user_meta_data ->> 'full_name', ''),
      nullif(auth_user.raw_user_meta_data ->> 'name', ''),
      ''
    ))) as metadata_name
  from auth.users auth_user
  join public.login login_user
    on lower(trim(login_user.email)) = lower(trim(auth_user.email))
  where nullif(trim(auth_user.email), '') is not null
), candidates as (
  select distinct
    identity.auth_user_id,
    profile.user_id as profile_user_id,
    case
      when identity.login_name <> ''
       and lower(trim(profile.full_name)) = identity.login_name then 80
      when identity.metadata_name <> ''
       and lower(trim(profile.full_name)) = identity.metadata_name then 75
      when identity.auth_local_part <> ''
       and lower(trim(profile.full_name)) = identity.auth_local_part then 70
      when identity.auth_local_part <> ''
       and lower(split_part(trim(profile.email), '@', 1)) = identity.auth_local_part then 65
      else 0
    end as match_score
  from auth_identity identity
  join public.profiles profile
    on profile.user_id <> identity.auth_user_id
   and lower(trim(profile.email)) <> identity.auth_email
   and (
     (
       identity.login_name <> ''
       and lower(trim(profile.full_name)) = identity.login_name
     )
     or (
       identity.metadata_name <> ''
       and lower(trim(profile.full_name)) = identity.metadata_name
     )
     or (
       identity.auth_local_part <> ''
       and lower(trim(profile.full_name)) = identity.auth_local_part
     )
     or (
       identity.auth_local_part <> ''
       and lower(split_part(trim(profile.email), '@', 1)) = identity.auth_local_part
     )
   )
  where not exists (
    select 1
    from public.workforce_identity_links exact_link
    where exact_link.auth_user_id = identity.auth_user_id
      and exact_link.profile_user_id = profile.user_id
      and exact_link.is_active is true
      and exact_link.match_method in ('auth_user_id', 'exact_email', 'manual')
  )
), best_score as (
  select auth_user_id, max(match_score) as match_score
  from candidates
  group by auth_user_id
), best_candidates as (
  select candidate.auth_user_id, candidate.profile_user_id, candidate.match_score
  from candidates candidate
  join best_score best
    on best.auth_user_id = candidate.auth_user_id
   and best.match_score = candidate.match_score
)
select
  best.auth_user_id,
  best.profile_user_id,
  best.match_score,
  count(*) over (partition by best.auth_user_id) as best_candidate_count
from best_candidates best;

insert into public.workforce_identity_links (
  auth_user_id,
  profile_user_id,
  match_method,
  is_active
)
select
  candidate.auth_user_id,
  candidate.profile_user_id,
  'unique_name_alias',
  true
from workforce_identity_alias_candidates candidate
where candidate.best_candidate_count = 1
on conflict (auth_user_id, profile_user_id) do update
set match_method = excluded.match_method,
    is_active = true,
    updated_at = now();

-- Keep exact links synchronized whenever an administrator changes a workforce
-- profile email or a profile is created outside the ordinary login trigger.
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

  if v_auth_user_id is not null then
    insert into public.workforce_identity_links (
      auth_user_id,
      profile_user_id,
      match_method,
      is_active
    ) values (
      v_auth_user_id,
      new.user_id,
      case
        when v_auth_user_id = new.user_id then 'auth_user_id'
        else 'exact_email'
      end,
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

-- Controlled repair path for genuinely exceptional legacy identities. This is
-- intentionally administrator-only and records the reason in the audit log.
create or replace function public.workforce_admin_link_identity(
  p_auth_email text,
  p_profile_user_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_auth_user_id uuid;
  v_profile public.profiles%rowtype;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if auth.uid() is null
     or not public.workforce_is_admin()
     or not public.workforce_has_permission('manage_employees') then
    raise exception 'You do not have permission to link workforce identities.'
      using errcode = '42501';
  end if;

  select auth_user.id
  into v_auth_user_id
  from auth.users auth_user
  where lower(trim(auth_user.email)) = lower(trim(coalesce(p_auth_email, '')))
  limit 1;

  if v_auth_user_id is null then
    raise exception 'Auth account not found for the supplied email.';
  end if;

  select *
  into v_profile
  from public.profiles profile
  where profile.user_id = p_profile_user_id;

  if not found then
    raise exception 'Workforce profile not found.';
  end if;

  insert into public.workforce_identity_links (
    auth_user_id,
    profile_user_id,
    match_method,
    is_active
  ) values (
    v_auth_user_id,
    v_profile.user_id,
    'manual',
    true
  )
  on conflict (auth_user_id, profile_user_id) do update
  set match_method = 'manual',
      is_active = true,
      updated_at = now();

  insert into public.workforce_audit_logs (
    action,
    entity_type,
    entity_id,
    after_data,
    reason
  ) values (
    'workforce_identity_linked_manually',
    'workforce_identity_links',
    v_profile.user_id,
    jsonb_build_object(
      'auth_user_id', v_auth_user_id,
      'auth_email', lower(trim(p_auth_email)),
      'profile_user_id', v_profile.user_id,
      'profile_email', v_profile.email,
      'profile_name', v_profile.full_name
    ),
    coalesce(v_reason, 'Manual administrator identity repair')
  );

  return jsonb_build_object(
    'auth_user_id', v_auth_user_id,
    'profile_user_id', v_profile.user_id,
    'match_method', 'manual',
    'is_active', true
  );
end;
$$;

revoke execute on function public.workforce_admin_link_identity(text, uuid, text) from anon;
revoke all on function public.workforce_admin_link_identity(text, uuid, text) from public;
grant execute on function public.workforce_admin_link_identity(text, uuid, text) to authenticated;

-- Deployment blockers -------------------------------------------------------
-- Every Auth account admitted through public.login must resolve to at least one
-- active workforce profile. A partial deployment is rolled back.
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
    join public.profiles profile
      on profile.user_id = identity_link.profile_user_id
    where identity_link.auth_user_id = auth_user.id
      and identity_link.is_active is true
      and profile.employment_status in ('active', 'on_leave')
  );

  if v_unresolved is not null then
    raise exception
      'Workforce identity coverage is incomplete for site account(s): %',
      v_unresolved;
  end if;
end;
$$;

-- Every active agent profile that already owns workforce records must be linked
-- to at least one Auth account. Otherwise that employee could never see the
-- schedule, attendance, or leave record assigned to the profile.
do $$
declare
  v_unresolved text;
begin
  select string_agg(
    format('%s [%s]', profile.full_name, profile.employee_id),
    ', '
    order by profile.full_name, profile.employee_id
  )
  into v_unresolved
  from public.profiles profile
  where profile.employment_status in ('active', 'on_leave')
    and profile.is_agent is true
    and (
      exists (
        select 1 from public.work_schedules schedule
        where schedule.user_id = profile.user_id
      )
      or exists (
        select 1 from public.attendance attendance_record
        where attendance_record.user_id = profile.user_id
      )
      or exists (
        select 1 from public.leave_requests leave_request
        where leave_request.user_id = profile.user_id
      )
    )
    and not exists (
      select 1
      from public.workforce_identity_links identity_link
      where identity_link.profile_user_id = profile.user_id
        and identity_link.is_active is true
    );

  if v_unresolved is not null then
    raise exception
      'Workforce records belong to unlinked active profile(s): %',
      v_unresolved;
  end if;
end;
$$;

-- Ambiguous aliases with workforce records must be resolved manually before the
-- migration can succeed. This prevents accidentally sharing one person's data.
do $$
declare
  v_ambiguous text;
begin
  select string_agg(
    coalesce(auth_user.email, candidate.auth_user_id::text),
    ', '
    order by coalesce(auth_user.email, candidate.auth_user_id::text)
  )
  into v_ambiguous
  from (
    select distinct auth_user_id
    from workforce_identity_alias_candidates alias_candidate
    where alias_candidate.best_candidate_count > 1
      and exists (
        select 1
        from public.profiles profile
        where profile.user_id = alias_candidate.profile_user_id
          and (
            exists (
              select 1 from public.work_schedules schedule
              where schedule.user_id = profile.user_id
            )
            or exists (
              select 1 from public.attendance attendance_record
              where attendance_record.user_id = profile.user_id
            )
            or exists (
              select 1 from public.leave_requests leave_request
              where leave_request.user_id = profile.user_id
            )
          )
      )
  ) candidate
  left join auth.users auth_user on auth_user.id = candidate.auth_user_id;

  if v_ambiguous is not null then
    raise exception
      'Ambiguous workforce identity candidate(s) require manual mapping: %',
      v_ambiguous;
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
    'site_auth_account_count', (
      select count(*)
      from auth.users auth_user
      join public.login login_user
        on lower(trim(login_user.email)) = lower(trim(auth_user.email))
    ),
    'linked_auth_account_count', count(distinct identity_link.auth_user_id),
    'linked_profile_count', count(distinct identity_link.profile_user_id),
    'active_link_count', count(*)
  ),
  'Verified complete workforce identity coverage for all current site accounts and active profiles with workforce records'
from public.workforce_identity_links identity_link
where identity_link.is_active is true;

commit;
