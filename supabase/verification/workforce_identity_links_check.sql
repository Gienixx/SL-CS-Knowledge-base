-- Verify workforce identity-link deployment.
-- Run after 2026070705_workforce_identity_links.sql.
-- Queries marked "should return 0 rows" are deployment blockers.

begin;

-- 1. Required objects: every boolean should be true.
select
  to_regclass('public.workforce_identity_links') is not null as identity_table_exists,
  to_regprocedure('public.workforce_is_current_identity(uuid)') is not null as identity_helper_exists,
  to_regprocedure('public.workforce_get_current_access()') is not null as access_rpc_exists;

-- 2. Exact Auth/profile links missing: should return 0 rows.
select
  auth_user.id as auth_user_id,
  auth_user.email as auth_email,
  profile.user_id as profile_user_id,
  profile.email as profile_email
from auth.users auth_user
join public.profiles profile
  on profile.user_id = auth_user.id
  or lower(trim(profile.email)) = lower(trim(auth_user.email))
left join public.workforce_identity_links identity_link
  on identity_link.auth_user_id = auth_user.id
 and identity_link.profile_user_id = profile.user_id
 and identity_link.is_active is true
where nullif(trim(auth_user.email), '') is not null
  and identity_link.auth_user_id is null;

-- 3. Safe legacy alias links missing: should return 0 rows.
with auth_identity as (
  select
    auth_user.id as auth_user_id,
    lower(split_part(trim(auth_user.email), '@', 1)) as auth_local_part,
    lower(trim(coalesce(
      nullif(login_user.name, ''),
      nullif(auth_user.raw_user_meta_data ->> 'name', ''),
      split_part(auth_user.email, '@', 1)
    ))) as identity_name,
    count(*) over (
      partition by lower(split_part(trim(auth_user.email), '@', 1))
    ) as local_part_auth_count
  from auth.users auth_user
  left join lateral (
    select trim(login_row.name) as name
    from public.login login_row
    where lower(trim(login_row.email)) = lower(trim(auth_user.email))
    limit 1
  ) login_user on true
  where nullif(trim(auth_user.email), '') is not null
), safe_aliases as (
  select distinct
    identity.auth_user_id,
    profile.user_id as profile_user_id,
    profile.full_name,
    profile.email
  from auth_identity identity
  join public.profiles profile
    on profile.user_id <> identity.auth_user_id
   and (
     lower(trim(profile.full_name)) = identity.identity_name
     or lower(trim(profile.full_name)) = identity.auth_local_part
     or lower(split_part(trim(profile.email), '@', 1)) = identity.auth_local_part
   )
  where identity.local_part_auth_count = 1
)
select alias.*
from safe_aliases alias
left join public.workforce_identity_links identity_link
  on identity_link.auth_user_id = alias.auth_user_id
 and identity_link.profile_user_id = alias.profile_user_id
 and identity_link.is_active is true
where identity_link.auth_user_id is null;

-- 4. Orphaned or inactive links: should return 0 rows.
select identity_link.*
from public.workforce_identity_links identity_link
left join public.profiles profile
  on profile.user_id = identity_link.profile_user_id
left join auth.users auth_user
  on auth_user.id = identity_link.auth_user_id
where profile.user_id is null
   or auth_user.id is null
   or identity_link.is_active is not true;

-- 5. Multi-profile identities. Review this result and confirm expected names such
-- as Arby or the test account. This result may legitimately contain rows.
select
  auth_user.id as auth_user_id,
  auth_user.email as auth_email,
  count(*) as linked_profile_count,
  jsonb_agg(
    jsonb_build_object(
      'profile_user_id', profile.user_id,
      'full_name', profile.full_name,
      'email', profile.email,
      'employee_id', profile.employee_id,
      'match_method', identity_link.match_method,
      'schedule_count', (
        select count(*)
        from public.work_schedules schedule
        where schedule.user_id = profile.user_id
      )
    ) order by profile.full_name, profile.employee_id
  ) as linked_profiles
from public.workforce_identity_links identity_link
join auth.users auth_user on auth_user.id = identity_link.auth_user_id
join public.profiles profile on profile.user_id = identity_link.profile_user_id
where identity_link.is_active is true
group by auth_user.id, auth_user.email
having count(*) > 1
order by auth_user.email;

-- 6. Published schedules attached to a linked non-Auth UUID. These are the rows
-- that the identity layer makes visible to the corresponding signed-in account.
select
  auth_user.email as auth_email,
  profile.full_name,
  profile.employee_id,
  schedule.shift_date,
  schedule.shift_sequence,
  schedule.status,
  schedule.shift_start,
  schedule.shift_end
from public.workforce_identity_links identity_link
join auth.users auth_user on auth_user.id = identity_link.auth_user_id
join public.profiles profile on profile.user_id = identity_link.profile_user_id
join public.work_schedules schedule on schedule.user_id = profile.user_id
where identity_link.is_active is true
  and identity_link.profile_user_id <> identity_link.auth_user_id
  and schedule.status in ('published', 'changed', 'completed')
order by auth_user.email, schedule.shift_date, schedule.shift_sequence;

-- 7. Policy definitions should reference the linked-identity helper.
select
  schemaname,
  tablename,
  policyname,
  qual
from pg_policies
where schemaname = 'public'
  and tablename in ('profiles', 'work_schedules', 'attendance')
  and policyname in (
    'Users can view permitted workforce profiles',
    'Users can view permitted work schedules',
    'Users can view permitted attendance'
  )
order by tablename;

-- 8. Permission boundary: authenticated can execute; anon cannot.
select
  has_function_privilege(
    'authenticated',
    'public.workforce_is_current_identity(uuid)',
    'EXECUTE'
  ) as authenticated_can_execute_identity_helper,
  not has_function_privilege(
    'anon',
    'public.workforce_is_current_identity(uuid)',
    'EXECUTE'
  ) as anon_cannot_execute_identity_helper,
  has_function_privilege(
    'authenticated',
    'public.workforce_get_current_access()',
    'EXECUTE'
  ) as authenticated_can_execute_access_rpc,
  not has_function_privilege(
    'anon',
    'public.workforce_get_current_access()',
    'EXECUTE'
  ) as anon_cannot_execute_access_rpc;

rollback;
