begin;

create table if not exists public.ticket_dimension_profiles (
  ticket_id bigint primary key check (ticket_id > 0),
  app_key text,
  platform_key text,
  country_key text,
  driver_key text,
  source_updated_at timestamptz,
  source_system text not null default 'zendesk',
  source_record_type text not null default 'ticket',
  source_record_id text not null,
  profile_version text not null default 'zendesk-custom-fields-v1',
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  synced_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ticket_dimension_profiles_app_idx
  on public.ticket_dimension_profiles (app_key)
  where app_key is not null;

create index if not exists ticket_dimension_profiles_platform_idx
  on public.ticket_dimension_profiles (platform_key)
  where platform_key is not null;

create index if not exists ticket_dimension_profiles_country_idx
  on public.ticket_dimension_profiles (country_key)
  where country_key is not null;

create index if not exists ticket_dimension_profiles_driver_idx
  on public.ticket_dimension_profiles (driver_key)
  where driver_key is not null;

create index if not exists ticket_dimension_profiles_source_updated_idx
  on public.ticket_dimension_profiles (source_updated_at desc)
  where source_updated_at is not null;

create or replace function public.upsert_ticket_dimension_profiles(
  p_profiles jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected_rows integer := 0;
begin
  if p_profiles is null or jsonb_typeof(p_profiles) <> 'array' then
    raise exception 'ticket_dimension_profiles_array_required';
  end if;

  with parsed_profiles as (
    select
      profile.ticket_id,
      nullif(btrim(profile.app_key), '') as app_key,
      nullif(btrim(profile.platform_key), '') as platform_key,
      nullif(btrim(profile.country_key), '') as country_key,
      nullif(btrim(profile.driver_key), '') as driver_key,
      profile.source_updated_at,
      coalesce(nullif(btrim(profile.source_system), ''), 'zendesk') as source_system,
      coalesce(nullif(btrim(profile.source_record_type), ''), 'ticket') as source_record_type,
      coalesce(
        nullif(btrim(profile.source_record_id), ''),
        profile.ticket_id::text
      ) as source_record_id,
      coalesce(
        nullif(btrim(profile.profile_version), ''),
        'zendesk-custom-fields-v1'
      ) as profile_version,
      case
        when profile.metadata is null then '{}'::jsonb
        when jsonb_typeof(profile.metadata) = 'object' then profile.metadata
        else '{}'::jsonb
      end as metadata
    from jsonb_to_recordset(p_profiles) as profile (
      ticket_id bigint,
      app_key text,
      platform_key text,
      country_key text,
      driver_key text,
      source_updated_at timestamptz,
      source_system text,
      source_record_type text,
      source_record_id text,
      profile_version text,
      metadata jsonb
    )
    where profile.ticket_id is not null
      and profile.ticket_id > 0
  ),
  upserted as (
    insert into public.ticket_dimension_profiles (
      ticket_id,
      app_key,
      platform_key,
      country_key,
      driver_key,
      source_updated_at,
      source_system,
      source_record_type,
      source_record_id,
      profile_version,
      metadata,
      synced_at,
      updated_at
    )
    select
      ticket_id,
      app_key,
      platform_key,
      country_key,
      driver_key,
      source_updated_at,
      source_system,
      source_record_type,
      source_record_id,
      profile_version,
      metadata,
      now(),
      now()
    from parsed_profiles
    on conflict (ticket_id) do update
    set
      app_key = excluded.app_key,
      platform_key = excluded.platform_key,
      country_key = excluded.country_key,
      driver_key = excluded.driver_key,
      source_updated_at = excluded.source_updated_at,
      source_system = excluded.source_system,
      source_record_type = excluded.source_record_type,
      source_record_id = excluded.source_record_id,
      profile_version = excluded.profile_version,
      metadata = excluded.metadata,
      synced_at = now(),
      updated_at = now()
    where public.ticket_dimension_profiles.source_updated_at is null
       or (
         excluded.source_updated_at is not null
         and excluded.source_updated_at >= public.ticket_dimension_profiles.source_updated_at
       )
    returning 1
  )
  select count(*)::integer
  into affected_rows
  from upserted;

  return affected_rows;
end;
$$;

insert into public.zendesk_sync_state (stream_key)
values ('ticket_dimensions_backfill')
on conflict (stream_key) do nothing;

alter table public.ticket_dimension_profiles enable row level security;

revoke all privileges
on table public.ticket_dimension_profiles
from anon, authenticated;

grant select, insert, update, delete
on table public.ticket_dimension_profiles
to service_role;

revoke all
on function public.upsert_ticket_dimension_profiles(jsonb)
from public, anon, authenticated;

grant execute
on function public.upsert_ticket_dimension_profiles(jsonb)
to service_role;

comment on table public.ticket_dimension_profiles is
  'Server-only current Zendesk ticket dimensions used for app, platform, country, and driver reporting.';

comment on function public.upsert_ticket_dimension_profiles(jsonb) is
  'Upserts current ticket-dimension profiles without rewriting immutable ticket lifecycle events.';

commit;
