-- Article cover images for Knowledge Base cards
-- Run this migration in the Supabase SQL Editor before using image uploads.

alter table public.articles
  add column if not exists image_url text;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'article-images',
  'article-images',
  true,
  5242880,
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif'
  ]::text[]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

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
  "Public can view article images"
on storage.objects;

create policy
  "Public can view article images"
on storage.objects
for select
to public
using (bucket_id = 'article-images');

drop policy if exists
  "Article editors can upload article images"
on storage.objects;

create policy
  "Article editors can upload article images"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'article-images'
  and public.current_user_can_edit_articles()
);

drop policy if exists
  "Article editors can delete article images"
on storage.objects;

create policy
  "Article editors can delete article images"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'article-images'
  and public.current_user_can_edit_articles()
);
