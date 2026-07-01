begin;

create table if not exists public.zendesk_agent_directory (
  agent_key text primary key check (agent_key ~ '^zendesk:[0-9]+$'),
  zendesk_user_id bigint not null unique check (zendesk_user_id > 0),
  agent_name text not null check (btrim(agent_name) <> ''),
  active boolean not null default true,
  role text,
  updated_at timestamptz not null default now()
);

create index if not exists zendesk_agent_directory_name_idx
  on public.zendesk_agent_directory (lower(agent_name));

create or replace function public.get_unresolved_zendesk_agent_ids(
  p_limit integer default 100
)
returns table (zendesk_user_id bigint)
language sql
security definer
set search_path = public
as $$
  select distinct
    substring(event.agent_key from '^zendesk:([0-9]+)$')::bigint
      as zendesk_user_id
  from public.ticket_events as event
  left join public.zendesk_agent_directory as directory
    on directory.agent_key = event.agent_key
  where event.agent_key ~ '^zendesk:[0-9]+$'
    and (
      directory.agent_key is null
      or directory.updated_at < now() - interval '7 days'
    )
  order by zendesk_user_id
  limit greatest(1, least(coalesce(p_limit, 100), 100));
$$;

alter table public.zendesk_agent_directory enable row level security;

revoke all privileges
on table public.zendesk_agent_directory
from anon, authenticated;

grant select
on table public.zendesk_agent_directory
to authenticated;

grant select, insert, update, delete
on table public.zendesk_agent_directory
to service_role;

drop policy if exists "Authenticated users can read Zendesk agent names"
on public.zendesk_agent_directory;

create policy "Authenticated users can read Zendesk agent names"
on public.zendesk_agent_directory
for select
to authenticated
using (true);

revoke all
on function public.get_unresolved_zendesk_agent_ids(integer)
from public, anon, authenticated;

grant execute
on function public.get_unresolved_zendesk_agent_ids(integer)
to service_role;

comment on table public.zendesk_agent_directory is
  'Cached Zendesk user names used to replace numeric agent IDs in dashboards.';

comment on function public.get_unresolved_zendesk_agent_ids(integer) is
  'Returns missing or stale Zendesk user IDs for server-side directory refresh.';

commit;
