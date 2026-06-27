begin;

create extension if not exists pgcrypto;

create table if not exists public.ticket_events (
  id uuid primary key default gen_random_uuid(),
  ticket_id bigint not null check (ticket_id > 0),
  source_event_id text not null unique,
  event_type text not null check (
    event_type in (
      'created',
      'assigned',
      'first_response',
      'status_changed',
      'priority_changed',
      'solved',
      'reopened',
      'closed',
      'sla_breached',
      'csat_rating'
    )
  ),
  event_timestamp timestamptz not null,
  agent_key text,
  ticket_status text,
  priority text,
  channel text,
  app_key text,
  platform_key text,
  country_key text,
  driver_key text,
  source_system text not null default 'zendesk',
  source_record_type text not null,
  source_record_id text not null,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  imported_at timestamptz not null default now()
);

create index if not exists ticket_events_ticket_timestamp_idx
  on public.ticket_events (ticket_id, event_timestamp desc);

create index if not exists ticket_events_event_timestamp_idx
  on public.ticket_events (event_timestamp desc);

create index if not exists ticket_events_event_type_timestamp_idx
  on public.ticket_events (event_type, event_timestamp desc);

create index if not exists ticket_events_agent_timestamp_idx
  on public.ticket_events (agent_key, event_timestamp desc)
  where agent_key is not null;

create index if not exists ticket_events_priority_timestamp_idx
  on public.ticket_events (priority, event_timestamp desc)
  where priority is not null;

create index if not exists ticket_events_channel_timestamp_idx
  on public.ticket_events (channel, event_timestamp desc)
  where channel is not null;

create index if not exists ticket_events_app_timestamp_idx
  on public.ticket_events (app_key, event_timestamp desc)
  where app_key is not null;

create index if not exists ticket_events_platform_timestamp_idx
  on public.ticket_events (platform_key, event_timestamp desc)
  where platform_key is not null;

create index if not exists ticket_events_country_timestamp_idx
  on public.ticket_events (country_key, event_timestamp desc)
  where country_key is not null;

create index if not exists ticket_events_driver_timestamp_idx
  on public.ticket_events (driver_key, event_timestamp desc)
  where driver_key is not null;

create table if not exists public.zendesk_sync_state (
  stream_key text primary key,
  cursor text,
  start_time bigint check (start_time is null or start_time > 0),
  last_event_timestamp timestamptz,
  last_success_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.zendesk_sync_runs (
  id uuid primary key default gen_random_uuid(),
  stream_key text not null,
  started_at timestamptz not null,
  completed_at timestamptz,
  status text not null check (status in ('running', 'success', 'failed')),
  trigger_source text not null check (
    trigger_source in ('manual', 'scheduled')
  ),
  cursor_before text,
  cursor_after text,
  tickets_processed integer not null default 0
    check (tickets_processed >= 0),
  events_seen integer not null default 0
    check (events_seen >= 0),
  events_imported integer not null default 0
    check (events_imported >= 0),
  duplicate_events integer not null default 0
    check (duplicate_events >= 0),
  warnings_count integer not null default 0
    check (warnings_count >= 0),
  error_message text
);

create index if not exists zendesk_sync_runs_started_at_idx
  on public.zendesk_sync_runs (started_at desc);

create index if not exists zendesk_sync_runs_stream_started_idx
  on public.zendesk_sync_runs (stream_key, started_at desc);

insert into public.zendesk_sync_state (stream_key)
values ('tickets')
on conflict (stream_key) do nothing;

create or replace function public.acquire_zendesk_sync_lock(
  p_stream_key text,
  p_lock_token uuid,
  p_lease_seconds integer default 900
)
returns table (
  current_cursor text,
  current_start_time bigint
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_stream_key is null or btrim(p_stream_key) = '' then
    raise exception 'stream_key_required';
  end if;

  if p_lock_token is null then
    raise exception 'lock_token_required';
  end if;

  insert into public.zendesk_sync_state (stream_key)
  values (p_stream_key)
  on conflict (stream_key) do nothing;

  update public.zendesk_sync_state
  set
    lease_token = p_lock_token,
    lease_expires_at = now() + make_interval(
      secs => greatest(60, least(coalesce(p_lease_seconds, 900), 3600))
    ),
    updated_at = now()
  where stream_key = p_stream_key
    and (
      lease_token is null
      or lease_expires_at is null
      or lease_expires_at < now()
      or lease_token = p_lock_token
    )
  returning cursor, start_time
  into current_cursor, current_start_time;

  if not found then
    raise exception 'zendesk_sync_locked'
      using errcode = '55P03';
  end if;

  return next;
end;
$$;

create or replace function public.release_zendesk_sync_lock(
  p_stream_key text,
  p_lock_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.zendesk_sync_state
  set
    lease_token = null,
    lease_expires_at = null,
    updated_at = now()
  where stream_key = p_stream_key
    and lease_token = p_lock_token;

  return found;
end;
$$;

create or replace function public.advance_zendesk_sync_state(
  p_stream_key text,
  p_lock_token uuid,
  p_cursor text,
  p_start_time bigint,
  p_last_event_timestamp timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.zendesk_sync_state
  set
    cursor = p_cursor,
    start_time = coalesce(p_start_time, start_time),
    last_event_timestamp = coalesce(
      p_last_event_timestamp,
      last_event_timestamp
    ),
    last_success_at = now(),
    lease_token = null,
    lease_expires_at = null,
    updated_at = now()
  where stream_key = p_stream_key
    and lease_token = p_lock_token;

  if not found then
    raise exception 'zendesk_sync_lock_lost'
      using errcode = '55P03';
  end if;

  return true;
end;
$$;

alter table public.ticket_events enable row level security;
alter table public.zendesk_sync_state enable row level security;
alter table public.zendesk_sync_runs enable row level security;

revoke all privileges
on table
  public.ticket_events,
  public.zendesk_sync_state,
  public.zendesk_sync_runs
from anon, authenticated;

grant select
on table public.ticket_events
to authenticated;

grant select, insert, update, delete
on table
  public.ticket_events,
  public.zendesk_sync_state,
  public.zendesk_sync_runs
to service_role;

create policy "Authenticated users can read ticket events"
on public.ticket_events
for select
to authenticated
using (true);

revoke all
on function public.acquire_zendesk_sync_lock(text, uuid, integer)
from public, anon, authenticated;

revoke all
on function public.release_zendesk_sync_lock(text, uuid)
from public, anon, authenticated;

revoke all
on function public.advance_zendesk_sync_state(
  text,
  uuid,
  text,
  bigint,
  timestamptz
)
from public, anon, authenticated;

grant execute
on function public.acquire_zendesk_sync_lock(text, uuid, integer)
to service_role;

grant execute
on function public.release_zendesk_sync_lock(text, uuid)
to service_role;

grant execute
on function public.advance_zendesk_sync_state(
  text,
  uuid,
  text,
  bigint,
  timestamptz
)
to service_role;

comment on table public.ticket_events is
  'Normalized, deduplicated Zendesk ticket lifecycle events.';

comment on column public.ticket_events.source_event_id is
  'Immutable source identifier used to make imports idempotent.';

comment on table public.zendesk_sync_state is
  'Server-only cursor and lease state for incremental Zendesk exports.';

comment on table public.zendesk_sync_runs is
  'Server-only execution history for Zendesk event synchronization.';

commit;
