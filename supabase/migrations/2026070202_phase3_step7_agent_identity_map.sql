begin;

create table if not exists public.agent_identity_map (
  agent_key text primary key check (agent_key ~ '^[a-z0-9][a-z0-9_-]*$'),
  agent_name text not null check (btrim(agent_name) <> ''),
  zendesk_agent_key text unique
    references public.zendesk_agent_directory(agent_key)
    on update cascade
    on delete set null,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

create index if not exists agent_identity_map_name_idx
  on public.agent_identity_map (lower(agent_name));

insert into public.agent_identity_map (agent_key, agent_name)
select
  lower(btrim(agent_key)) as agent_key,
  coalesce(
    max(nullif(btrim(agent_name), '')),
    initcap(replace(lower(btrim(agent_key)), '_', ' '))
  ) as agent_name
from public.agent_productivity
where nullif(btrim(agent_key), '') is not null
group by lower(btrim(agent_key))
on conflict (agent_key) do update
set
  agent_name = excluded.agent_name,
  updated_at = now();

with unique_directory_names as (
  select
    lower(regexp_replace(btrim(agent_name), '\s+', ' ', 'g')) as normalized_name,
    min(agent_key) as zendesk_agent_key
  from public.zendesk_agent_directory
  where active = true
  group by lower(regexp_replace(btrim(agent_name), '\s+', ' ', 'g'))
  having count(*) = 1
)
update public.agent_identity_map as map
set
  zendesk_agent_key = directory.zendesk_agent_key,
  updated_at = now()
from unique_directory_names as directory
where map.zendesk_agent_key is null
  and lower(regexp_replace(btrim(map.agent_name), '\s+', ' ', 'g')) =
    directory.normalized_name;

alter table public.agent_identity_map enable row level security;

grant select
on table public.agent_identity_map
to authenticated;

grant select, insert, update, delete
on table public.agent_identity_map
to service_role;

drop policy if exists "Authenticated users can read agent identity mappings"
on public.agent_identity_map;

create policy "Authenticated users can read agent identity mappings"
on public.agent_identity_map
for select
to authenticated
using (true);

create or replace function public.capture_agent_identity_from_productivity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  insert into public.agent_identity_map (agent_key, agent_name)
  values (
    lower(btrim(new.agent_key)),
    coalesce(
      nullif(btrim(new.agent_name), ''),
      initcap(replace(lower(btrim(new.agent_key)), '_', ' '))
    )
  )
  on conflict (agent_key) do update
  set
    agent_name = excluded.agent_name,
    updated_at = now();

  return new;
end;
$$;

drop trigger if exists capture_agent_identity_from_productivity
on public.agent_productivity;

create trigger capture_agent_identity_from_productivity
after insert or update of agent_key, agent_name
on public.agent_productivity
for each row
execute function public.capture_agent_identity_from_productivity();

comment on table public.agent_identity_map is
  'Maps Google Sheet productivity agent keys to Zendesk directory agent keys for combined analytics.';

comment on function public.capture_agent_identity_from_productivity() is
  'Keeps the agent identity map aligned with synchronized productivity agents.';

commit;
