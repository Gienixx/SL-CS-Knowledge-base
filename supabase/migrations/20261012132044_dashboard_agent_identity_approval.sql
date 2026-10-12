alter table public.agent_identity_map
  add column if not exists dashboard_sync_approved boolean not null default false;

comment on column public.agent_identity_map.dashboard_sync_approved is
  'Explicit operator approval for importing this identity onto dates that already contain other productivity identities. New rows default to unapproved.';
