begin;

alter table public.team_announcements
  add column if not exists like_count integer not null default 0,
  add column if not exists dislike_count integer not null default 0;

alter table public.team_announcements
  drop constraint if exists team_announcements_like_count_nonnegative,
  drop constraint if exists team_announcements_dislike_count_nonnegative;

alter table public.team_announcements
  add constraint team_announcements_like_count_nonnegative
    check (like_count >= 0),
  add constraint team_announcements_dislike_count_nonnegative
    check (dislike_count >= 0);

create table public.announcement_reactions (
  announcement_id uuid not null
    references public.team_announcements(id) on delete cascade,
  user_id uuid not null
    references auth.users(id) on delete cascade,
  reaction text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (announcement_id, user_id),
  constraint announcement_reactions_value_valid
    check (reaction in ('like', 'dislike'))
);

create index announcement_reactions_announcement_reaction_idx
  on public.announcement_reactions (announcement_id, reaction);

alter table public.announcement_reactions enable row level security;

create policy "Users can view their own announcement reactions"
on public.announcement_reactions
for select
to authenticated
using (
  (select auth.uid()) = user_id
  and public.workforce_current_user_is_active()
  and exists (
    select 1
    from public.team_announcements announcement
    where announcement.id = announcement_id
      and announcement.status = 'published'
  )
);

create policy "Users can create their own announcement reactions"
on public.announcement_reactions
for insert
to authenticated
with check (
  (select auth.uid()) = user_id
  and public.workforce_current_user_is_active()
  and exists (
    select 1
    from public.team_announcements announcement
    where announcement.id = announcement_id
      and announcement.status = 'published'
  )
);

create policy "Users can update their own announcement reactions"
on public.announcement_reactions
for update
to authenticated
using (
  (select auth.uid()) = user_id
  and public.workforce_current_user_is_active()
)
with check (
  (select auth.uid()) = user_id
  and public.workforce_current_user_is_active()
  and exists (
    select 1
    from public.team_announcements announcement
    where announcement.id = announcement_id
      and announcement.status = 'published'
  )
);

create policy "Users can delete their own announcement reactions"
on public.announcement_reactions
for delete
to authenticated
using (
  (select auth.uid()) = user_id
  and public.workforce_current_user_is_active()
);

grant select, insert, update, delete
on public.announcement_reactions
to authenticated;

revoke all on public.announcement_reactions from anon;

create or replace function private.sync_announcement_reaction_counts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_announcement_id uuid;
  v_new_announcement_id uuid;
begin
  if tg_op in ('DELETE', 'UPDATE') then
    v_old_announcement_id := old.announcement_id;

    update public.team_announcements announcement
    set like_count = (
          select count(*)::integer
          from public.announcement_reactions reaction
          where reaction.announcement_id = v_old_announcement_id
            and reaction.reaction = 'like'
        ),
        dislike_count = (
          select count(*)::integer
          from public.announcement_reactions reaction
          where reaction.announcement_id = v_old_announcement_id
            and reaction.reaction = 'dislike'
        )
    where announcement.id = v_old_announcement_id;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    v_new_announcement_id := new.announcement_id;

    if tg_op = 'INSERT' or v_new_announcement_id is distinct from v_old_announcement_id then
      update public.team_announcements announcement
      set like_count = (
            select count(*)::integer
            from public.announcement_reactions reaction
            where reaction.announcement_id = v_new_announcement_id
              and reaction.reaction = 'like'
          ),
          dislike_count = (
            select count(*)::integer
            from public.announcement_reactions reaction
            where reaction.announcement_id = v_new_announcement_id
              and reaction.reaction = 'dislike'
          )
      where announcement.id = v_new_announcement_id;
    end if;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function private.sync_announcement_reaction_counts()
from public, anon, authenticated;

create trigger sync_announcement_reaction_counts_after_write
after insert or update of announcement_id, reaction or delete
on public.announcement_reactions
for each row
execute function private.sync_announcement_reaction_counts();

comment on table public.announcement_reactions is
  'One like or dislike reaction per authenticated user and announcement.';

comment on column public.team_announcements.like_count is
  'Trigger-maintained count of like reactions.';

comment on column public.team_announcements.dislike_count is
  'Trigger-maintained count of dislike reactions.';

commit;
