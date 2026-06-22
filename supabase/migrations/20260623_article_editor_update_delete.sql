-- Allow approved article editors to update and delete knowledge base articles.
-- Run this migration in the Supabase SQL Editor after the article image migration.

alter table public.articles enable row level security;

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
