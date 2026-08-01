-- Announcement reaction structure: every query should return the expected value.

select
  to_regclass('public.announcement_reactions') is not null
    as reaction_table_exists_should_be_true;

select
  count(*) = 2 as count_columns_exist_should_be_true
from information_schema.columns
where table_schema = 'public'
  and table_name = 'team_announcements'
  and column_name in ('like_count', 'dislike_count');

select
  c.relrowsecurity as rls_enabled_should_be_true
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'announcement_reactions';

select
  count(*) = 4 as four_reaction_policies_should_be_true
from pg_policies
where schemaname = 'public'
  and tablename = 'announcement_reactions';

select
  has_table_privilege(
    'authenticated',
    'public.announcement_reactions',
    'select, insert, update, delete'
  ) as authenticated_reaction_access_should_be_true,
  not has_table_privilege(
    'anon',
    'public.announcement_reactions',
    'select'
  ) as anon_reaction_access_should_be_false;

select
  count(*) = 1 as reaction_count_trigger_exists_should_be_true
from pg_trigger trigger
join pg_class relation on relation.oid = trigger.tgrelid
join pg_namespace namespace on namespace.oid = relation.relnamespace
where namespace.nspname = 'public'
  and relation.relname = 'announcement_reactions'
  and trigger.tgname = 'sync_announcement_reaction_counts_after_write'
  and not trigger.tgisinternal;

select
  p.prosecdef as trigger_function_is_security_definer_should_be_true,
  n.nspname = 'private' as trigger_function_is_private_should_be_true
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'private'
  and p.proname = 'sync_announcement_reaction_counts';

select
  count(*) = 0 as invalid_reactions_should_be_zero
from public.announcement_reactions
where reaction not in ('like', 'dislike');

select
  count(*) = 0 as stored_counts_match_rows_should_be_zero
from public.team_announcements announcement
where announcement.like_count <> (
    select count(*)
    from public.announcement_reactions reaction
    where reaction.announcement_id = announcement.id
      and reaction.reaction = 'like'
  )
  or announcement.dislike_count <> (
    select count(*)
    from public.announcement_reactions reaction
    where reaction.announcement_id = announcement.id
      and reaction.reaction = 'dislike'
  );
