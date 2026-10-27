-- Freeze announcement publication chronology without inventing historical dates.
-- Existing published rows intentionally remain NULL in first_published_at; their
-- current published_at is the legacy display date and is frozen by the trigger.
begin;

alter table public.team_announcements
  add column if not exists first_published_at timestamptz,
  add column if not exists content_updated_at timestamptz;

create index if not exists team_announcements_important_publication_idx
  on public.team_announcements (
    status,
    is_important,
    (coalesce(first_published_at, published_at)) asc,
    id asc
  );

create or replace function public.enforce_team_announcements_important_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  important_count integer;
  oldest_important_id uuid;
  new_is_important boolean;
  old_is_important boolean;
  content_changed boolean;
begin
  -- Serialize every write that can change publication eligibility or the
  -- Important set. This makes the count-and-demote operation transactional.
  perform pg_catalog.pg_advisory_xact_lock(814739201);

  if tg_op = 'DELETE' then
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status = 'published' then
      -- A new publication gets one immutable publication timestamp. Do not
      -- use created_at as a universal historical substitute.
      new.published_at := coalesce(
        new.published_at,
        pg_catalog.clock_timestamp()
      );
      new.first_published_at := new.published_at;
    else
      new.published_at := null;
      new.first_published_at := null;
    end if;

    -- A new publication is not a content edit.
    new.content_updated_at := null;
    new.updated_at := pg_catalog.clock_timestamp();
  else
    -- Once set, first_published_at cannot move. A legacy published row may
    -- remain NULL, or may be manually corrected later when authoritative
    -- evidence becomes available.
    new.first_published_at := case
      when old.first_published_at is not null then old.first_published_at
      when old.status = 'published' then new.first_published_at
      when new.status = 'published' then coalesce(
        new.published_at,
        pg_catalog.clock_timestamp()
      )
      else null
    end;

    -- published_at remains the compatibility publication marker. It is
    -- frozen for edits to a published row; republishing a draft may receive a
    -- new compatibility marker while the immutable first date stays fixed.
    if new.status = 'published' then
      new.published_at := case
        when old.status = 'published' then old.published_at
        else coalesce(new.published_at, pg_catalog.clock_timestamp())
      end;
    else
      new.published_at := null;
    end if;

    if new.status = 'published' and new.first_published_at is null then
      new.first_published_at := new.published_at;
    end if;

    -- Preserve a legacy row's known display date if an administrator moves it
    -- to draft before republishing it. This is the first point at which the
    -- value would otherwise be lost; normal edits to a published legacy row
    -- leave first_published_at NULL.
    if old.status = 'published'
       and new.status = 'draft'
       and old.first_published_at is null then
      new.first_published_at := old.published_at;
    end if;

    content_changed := new.title is distinct from old.title
      or new.body is distinct from old.body
      or new.category is distinct from old.category;

    -- A first publication is not an edit. Later meaningful content changes
    -- receive the only timestamp used by the visible Updated note. Important
    -- toggles, including trigger-driven demotions, preserve it.
    new.content_updated_at := case
      when old.first_published_at is null
        and old.status <> 'published'
        and new.status = 'published' then null
      when content_changed then pg_catalog.clock_timestamp()
      else old.content_updated_at
    end;
    new.updated_at := pg_catalog.clock_timestamp();
  end if;

  new_is_important := new.status = 'published' and new.is_important is true;
  old_is_important := tg_op = 'UPDATE'
    and old.status = 'published'
    and old.is_important is true;

  -- Only a row newly entering the active Important set can consume a slot.
  -- Editing an existing Important announcement cannot refresh its age or
  -- displace another announcement.
  if new_is_important and not old_is_important then
    select count(*)::integer
    into important_count
    from public.team_announcements existing
    where existing.is_important is true
      and existing.status = 'published'
      and existing.id <> new.id;

    while important_count >= 3 loop
      select existing.id
      into oldest_important_id
      from public.team_announcements existing
      where existing.is_important is true
        and existing.status = 'published'
        and existing.id <> new.id
      order by coalesce(
        existing.first_published_at,
        existing.published_at
      ) asc, existing.id asc
      limit 1;

      exit when oldest_important_id is null;

      -- System-only demotion: do not assign content_updated_at. The trigger
      -- preserves it because title/body/category are unchanged.
      update public.team_announcements
      set is_important = false
      where id = oldest_important_id;

      important_count := important_count - 1;
      oldest_important_id := null;
    end loop;
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

comment on column public.team_announcements.first_published_at is
  'Immutable first publication timestamp for new rows; NULL means legacy publication chronology is unproven.';

comment on column public.team_announcements.content_updated_at is
  'Timestamp of the most recent meaningful announcement content edit; NULL for never-edited rows.';

commit;

;
