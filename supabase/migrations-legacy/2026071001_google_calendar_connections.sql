-- Google Calendar read-only integration storage.
-- OAuth refresh tokens are encrypted by Cloudflare Pages Functions before they
-- are written. Browser clients receive no direct table privileges.

begin;

create table if not exists public.google_calendar_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  encrypted_refresh_token text not null,
  calendar_id text not null default 'primary',
  calendar_summary text,
  calendar_timezone text,
  granted_scope text not null,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_synced_at timestamptz,
  last_error text
);

comment on table public.google_calendar_connections is
  'Server-only Google Calendar OAuth connections. Refresh tokens are AES-GCM encrypted before storage.';
comment on column public.google_calendar_connections.encrypted_refresh_token is
  'Versioned AES-GCM ciphertext produced with the GOOGLE_TOKEN_ENCRYPTION_KEY Cloudflare secret.';

create table if not exists public.google_calendar_oauth_states (
  state_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  return_to text not null default './home.html',
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.google_calendar_oauth_states is
  'Single-use hashed OAuth state values used to bind Google authorization callbacks to authenticated users.';

create index if not exists google_calendar_oauth_states_user_id_idx
  on public.google_calendar_oauth_states(user_id);
create index if not exists google_calendar_oauth_states_expires_at_idx
  on public.google_calendar_oauth_states(expires_at);

alter table public.google_calendar_connections enable row level security;
alter table public.google_calendar_oauth_states enable row level security;

revoke all on public.google_calendar_connections from anon, authenticated;
revoke all on public.google_calendar_oauth_states from anon, authenticated;

grant all on public.google_calendar_connections to service_role;
grant all on public.google_calendar_oauth_states to service_role;

insert into public.workforce_audit_logs (
  actor_user_id,
  action,
  entity_type,
  after_data,
  reason
) values (
  auth.uid(),
  'google_calendar_storage_created',
  'google_calendar_integration',
  jsonb_build_object(
    'connection_table', 'google_calendar_connections',
    'oauth_state_table', 'google_calendar_oauth_states',
    'browser_table_access', false,
    'token_storage', 'AES-GCM encrypted by Cloudflare Pages Functions',
    'scope', 'calendar.readonly'
  ),
  'Created server-only storage for read-only Google Calendar connections'
);

commit;
