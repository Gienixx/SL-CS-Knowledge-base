-- Add a bounded Important tag to announcements.
-- The tag is intentionally independent of normal read/unread state. Only
-- published rows are eligible for the authenticated Important popup.

begin;

alter table public.team_announcements
  add column if not exists is_important boolean not null default false;

create index if not exists team_announcements_important_idx
  on public.team_announcements (is_important, status, published_at desc);

create or replace function public.enforce_team_announcements_important_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Serialize every table write because publication, activation, expiry, or
  -- deletion state can change whether an Important row is eligible. The
  -- current table uses status as its canonical visibility field and has no
  -- separate expiry or soft-delete columns.
  perform pg_catalog.pg_advisory_xact_lock(814739201);

  if tg_op = 'DELETE' then
    return old;
  end if;

  if new.is_important is true
     and new.status = 'published'
     and (
       select count(*)
       from public.team_announcements existing
       where existing.is_important is true
         and existing.status = 'published'
         and existing.id <> new.id
     ) >= 2 then
    raise exception using
      errcode = '23514',
      message = 'Maximum of 2 Important announcements allowed.';
  end if;

  return new;
end;
$$;

drop trigger if exists team_announcements_important_limit
  on public.team_announcements;

create trigger team_announcements_important_limit
before insert or update or delete on public.team_announcements
for each row
execute function public.enforce_team_announcements_important_limit();

revoke all on function public.enforce_team_announcements_important_limit()
  from public, anon, authenticated;

commit;
