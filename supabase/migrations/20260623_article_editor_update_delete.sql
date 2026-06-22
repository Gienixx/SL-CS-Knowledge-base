-- Allow approved article editors to update and delete knowledge base articles.
-- Run this migration in the Supabase SQL Editor before using edit or delete.

alter table public.articles enable row level security;

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
    and can_edit_articles is true
  );
$$;

revoke all
on function public.current_user_can_edit_articles()
from public;

grant execute
on function public.current_user_can_edit_articles()
to authenticated;

drop policy if exists
  "Article editors can update articles"
on public.articles;

create policy
  "Article editors can update articles"
on public.articles
for update
to authenticated
using (public.current_user_can_edit_articles())
with check (public.current_user_can_edit_articles());

drop policy if exists
  "Article editors can delete articles"
on public.articles;

create policy
  "Article editors can delete articles"
on public.articles
for delete
to authenticated
using (public.current_user_can_edit_articles());
