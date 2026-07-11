-- Track who last created or updated each knowledge base article.
-- Run this migration in the Supabase SQL Editor before deploying the UI changes.

alter table public.articles
  add column if not exists updated_at timestamptz,
  add column if not exists updated_by_name text;

update public.articles
set
  updated_at = coalesce(updated_at, created_at, timezone('utc', now())),
  updated_by_name = coalesce(
    nullif(trim(updated_by_name), ''),
    nullif(trim(author_name), ''),
    'Unknown user'
  )
where
  updated_at is null
  or updated_by_name is null
  or trim(updated_by_name) = '';

alter table public.articles
  alter column updated_at set default timezone('utc', now()),
  alter column updated_at set not null;

create or replace function public.set_article_update_metadata()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_name text;
begin
  select nullif(trim(login.name), '')
  into actor_name
  from public.login as login
  where lower(login.email) = lower(
    coalesce(auth.jwt() ->> 'email', '')
  )
  limit 1;

  new.updated_at := timezone('utc', now());
  new.updated_by_name := coalesce(
    actor_name,
    nullif(trim(new.updated_by_name), ''),
    nullif(trim(new.author_name), ''),
    'Unknown user'
  );

  return new;
end;
$$;

revoke all
on function public.set_article_update_metadata()
from public;

drop trigger if exists
  set_article_update_metadata_trigger
on public.articles;

create trigger set_article_update_metadata_trigger
before insert or update
on public.articles
for each row
execute function public.set_article_update_metadata();

-- Administrators must retain article-management access even when the
-- editor checkbox was not explicitly selected on an older account.
update public.login
set can_edit_articles = true
where is_admin is true
  and can_edit_articles is distinct from true;

create or replace function public.enforce_admin_article_access()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.is_admin is true then
    new.can_edit_articles := true;
  end if;

  return new;
end;
$$;

drop trigger if exists
  enforce_admin_article_access_trigger
on public.login;

create trigger enforce_admin_article_access_trigger
before insert or update
on public.login
for each row
execute function public.enforce_admin_article_access();

create or replace function public.current_user_can_edit_articles()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.login
    where lower(email) = lower(
      coalesce(auth.jwt() ->> 'email', '')
    )
    and (
      can_edit_articles is true
      or is_admin is true
    )
  );
$$;

revoke all
on function public.current_user_can_edit_articles()
from public;

grant execute
on function public.current_user_can_edit_articles()
to authenticated;
