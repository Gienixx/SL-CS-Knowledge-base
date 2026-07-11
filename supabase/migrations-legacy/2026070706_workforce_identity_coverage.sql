-- Apply after 2026070705_workforce_identity_links.sql.
-- Ensures the identity repair covers every current site account and every active
-- workforce profile that owns schedule, attendance, or leave records.

begin;

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

  update public.workforce_identity_links
  set is_active = false,
      updated_at = now()
  where profile_user_id = new.user_id
    and match_method = 'exact_email'
    and (v_auth_user_id is null or auth_user_id <> v_auth_user_id);

  if v_auth_user_id is not null then
    insert into public.workforce_identity_links (
      auth_user_id, profile_user_id, match_method, is_active
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

-- Every account admitted through public.login must have an identity link.
do $$
declare
  v_missing text;
begin
  select string_agg(login_user.email, ', ' order by login_user.email)
  into v_missing
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

  if v_missing is not null then
    raise exception 'Unlinked site account(s): %', v_missing;
  end if;
end;
$$;

-- Every active agent profile that owns workforce records must be linked.
do $$
declare
  v_missing text;
begin
  select string_agg(
    format('%s [%s]', profile.full_name, profile.employee_id),
    ', ' order by profile.full_name, profile.employee_id
  )
  into v_missing
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

  if v_missing is not null then
    raise exception 'Unlinked workforce-record owner(s): %', v_missing;
  end if;
end;
$$;

-- More than one inferred alias with workforce records is unsafe and must block.
do $$
declare
  v_ambiguous text;
begin
  select string_agg(auth_user.email, ', ' order by auth_user.email)
  into v_ambiguous
  from auth.users auth_user
  where (
    select count(*)
    from public.workforce_identity_links identity_link
    where identity_link.auth_user_id = auth_user.id
      and identity_link.match_method = 'unique_name_alias'
      and identity_link.is_active is true
      and exists (
        select 1 from public.work_schedules s
        where s.user_id = identity_link.profile_user_id
      )
  ) > 1;

  if v_ambiguous is not null then
    raise exception 'Ambiguous identity mapping for: %', v_ambiguous;
  end if;
end;
$$;

insert into public.workforce_audit_logs (
  action, entity_type, after_data, reason
)
select
  'workforce_identity_coverage_verified',
  'workforce_identity_links',
  jsonb_build_object(
    'site_accounts', (
      select count(*)
      from auth.users auth_user
      join public.login login_user
        on lower(trim(login_user.email)) = lower(trim(auth_user.email))
    ),
    'linked_auth_accounts', count(distinct auth_user_id),
    'linked_profiles', count(distinct profile_user_id),
    'active_links', count(*)
  ),
  'Verified identity coverage for all current users and workforce-record owners'
from public.workforce_identity_links
where is_active is true;

commit;
