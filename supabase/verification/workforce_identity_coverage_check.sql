-- Run after both identity migrations:
-- 2026070705_workforce_identity_links.sql
-- 2026070706_workforce_identity_coverage.sql

begin;

-- 1. Required objects. Every value should be true.
select
  to_regclass('public.workforce_identity_links') is not null as identity_table_exists,
  to_regprocedure('public.workforce_is_current_identity(uuid)') is not null as identity_helper_exists,
  to_regprocedure('public.workforce_get_current_access()') is not null as access_rpc_exists,
  exists (
    select 1 from pg_trigger
    where tgname = 'zz_login_workforce_identity_link'
      and not tgisinternal
  ) as login_link_trigger_exists,
  exists (
    select 1 from pg_trigger
    where tgname = 'profiles_workforce_identity_link'
      and not tgisinternal
  ) as profile_link_trigger_exists;

-- 2. Every site Auth account and its active links.
select
  auth_user.email as auth_email,
  count(identity_link.profile_user_id) filter (
    where identity_link.is_active is true
  ) as active_link_count,
  jsonb_agg(
    jsonb_build_object(
      'profile_user_id', profile.user_id,
      'full_name', profile.full_name,
      'profile_email', profile.email,
      'employee_id', profile.employee_id,
      'employment_status', profile.employment_status,
      'match_method', identity_link.match_method,
      'is_active', identity_link.is_active,
      'schedule_count', (
        select count(*) from public.work_schedules schedule
        where schedule.user_id = profile.user_id
      )
    ) order by profile.full_name, profile.employee_id
  ) filter (where profile.user_id is not null) as linked_profiles
from auth.users auth_user
join public.login login_user
  on lower(trim(login_user.email)) = lower(trim(auth_user.email))
left join public.workforce_identity_links identity_link
  on identity_link.auth_user_id = auth_user.id
left join public.profiles profile
  on profile.user_id = identity_link.profile_user_id
group by auth_user.id, auth_user.email
order by auth_user.email;

-- 3. Unlinked site accounts: must return 0 rows.
select auth_user.id, auth_user.email
from auth.users auth_user
join public.login login_user
  on lower(trim(login_user.email)) = lower(trim(auth_user.email))
where not exists (
  select 1
  from public.workforce_identity_links identity_link
  join public.profiles profile on profile.user_id = identity_link.profile_user_id
  where identity_link.auth_user_id = auth_user.id
    and identity_link.is_active is true
);

-- 4. Active workforce-record owners without an Auth link: must return 0 rows.
select
  profile.user_id,
  profile.full_name,
  profile.email,
  profile.employee_id,
  profile.employment_status,
  (select count(*) from public.work_schedules s where s.user_id = profile.user_id) as schedule_count,
  (select count(*) from public.attendance a where a.user_id = profile.user_id) as attendance_count,
  (select count(*) from public.leave_requests l where l.user_id = profile.user_id) as leave_count
from public.profiles profile
where profile.employment_status in ('active', 'on_leave')
  and profile.is_agent is true
  and (
    exists (select 1 from public.work_schedules s where s.user_id = profile.user_id)
    or exists (select 1 from public.attendance a where a.user_id = profile.user_id)
    or exists (select 1 from public.leave_requests l where l.user_id = profile.user_id)
  )
  and not exists (
    select 1
    from public.workforce_identity_links identity_link
    where identity_link.profile_user_id = profile.user_id
      and identity_link.is_active is true
  );

-- 5. Ambiguous inferred aliases: must return 0 rows.
select
  auth_user.id as auth_user_id,
  auth_user.email,
  count(*) as inferred_alias_count,
  jsonb_agg(
    jsonb_build_object(
      'profile_user_id', profile.user_id,
      'full_name', profile.full_name,
      'profile_email', profile.email,
      'employee_id', profile.employee_id
    ) order by profile.full_name, profile.employee_id
  ) as inferred_profiles
from auth.users auth_user
join public.workforce_identity_links identity_link
  on identity_link.auth_user_id = auth_user.id
 and identity_link.match_method = 'unique_name_alias'
 and identity_link.is_active is true
join public.profiles profile on profile.user_id = identity_link.profile_user_id
group by auth_user.id, auth_user.email
having count(*) > 1
order by auth_user.email;

-- 6. Published/changed schedules reachable through a non-identical linked UUID.
select
  auth_user.email as auth_email,
  profile.full_name,
  profile.employee_id,
  schedule.shift_date,
  schedule.shift_sequence,
  schedule.status,
  schedule.shift_start,
  schedule.shift_end,
  identity_link.match_method
from public.workforce_identity_links identity_link
join auth.users auth_user on auth_user.id = identity_link.auth_user_id
join public.profiles profile on profile.user_id = identity_link.profile_user_id
join public.work_schedules schedule on schedule.user_id = profile.user_id
where identity_link.is_active is true
  and identity_link.auth_user_id <> identity_link.profile_user_id
  and schedule.status in ('published', 'changed', 'completed')
order by auth_user.email, schedule.shift_date, schedule.shift_sequence;

-- 7. Latest all-user coverage audit entry.
select action, after_data, reason, created_at
from public.workforce_audit_logs
where action = 'workforce_identity_coverage_verified'
order by created_at desc
limit 5;

rollback;
