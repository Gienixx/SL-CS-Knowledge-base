create table public.team_announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  category text not null default 'General',
  status text not null default 'draft',
  created_by uuid not null references public.profiles(user_id) on delete restrict,
  created_by_name text not null,
  published_by uuid references public.profiles(user_id) on delete set null,
  published_by_name text,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint team_announcements_title_not_blank check (btrim(title) <> ''),
  constraint team_announcements_body_not_blank check (btrim(body) <> ''),
  constraint team_announcements_category_not_blank check (btrim(category) <> ''),
  constraint team_announcements_status_valid check (status in ('draft', 'published')),
  constraint team_announcements_publication_valid check (
    (status = 'draft' and published_at is null and published_by is null and published_by_name is null)
    or
    (status = 'published' and published_at is not null and published_by is not null and btrim(published_by_name) <> '')
  )
);

create index team_announcements_status_published_at_idx
  on public.team_announcements (status, published_at desc);

create index team_announcements_created_at_idx
  on public.team_announcements (created_at desc);

alter table public.team_announcements enable row level security;

create policy "Workforce users can view published announcements"
on public.team_announcements
for select
to authenticated
using (
  public.workforce_current_user_is_active()
  and (
    status = 'published'
    or public.workforce_is_admin()
  )
);

create policy "Workforce admins can create announcements"
on public.team_announcements
for insert
to authenticated
with check (
  public.workforce_current_user_is_active()
  and public.workforce_is_admin()
  and public.workforce_is_current_identity(created_by)
);

create policy "Workforce admins can update announcements"
on public.team_announcements
for update
to authenticated
using (
  public.workforce_current_user_is_active()
  and public.workforce_is_admin()
)
with check (
  public.workforce_current_user_is_active()
  and public.workforce_is_admin()
);

create policy "Workforce admins can delete announcements"
on public.team_announcements
for delete
to authenticated
using (
  public.workforce_current_user_is_active()
  and public.workforce_is_admin()
);

grant select, insert, update, delete on public.team_announcements to authenticated;
