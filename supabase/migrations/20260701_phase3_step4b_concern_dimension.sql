begin;

do $$
declare
  concern_exists boolean;
  driver_exists boolean;
  driver_generated boolean;
begin
  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'ticket_dimension_profiles'
      and column_name = 'concern_key'
  ) into concern_exists;

  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'ticket_dimension_profiles'
      and column_name = 'driver_key'
  ) into driver_exists;

  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'ticket_dimension_profiles'
      and column_name = 'driver_key'
      and is_generated = 'ALWAYS'
  ) into driver_generated;

  if driver_exists and not concern_exists then
    alter table public.ticket_dimension_profiles
      rename column driver_key to concern_key;
    concern_exists := true;
    driver_exists := false;
  elsif driver_exists and concern_exists and not driver_generated then
    update public.ticket_dimension_profiles
    set concern_key = coalesce(concern_key, driver_key)
    where concern_key is null
      and driver_key is not null;

    alter table public.ticket_dimension_profiles
      drop column driver_key;
    driver_exists := false;
  elsif not concern_exists then
    alter table public.ticket_dimension_profiles
      add column concern_key text;
    concern_exists := true;
  end if;

  if not driver_exists then
    alter table public.ticket_dimension_profiles
      add column driver_key text
      generated always as (concern_key) stored;
  end if;
end;
$$;

do $$
begin
  if to_regclass('public.ticket_dimension_profiles_driver_idx') is not null
     and to_regclass('public.ticket_dimension_profiles_concern_idx') is null then
    alter index public.ticket_dimension_profiles_driver_idx
      rename to ticket_dimension_profiles_concern_idx;
  elsif to_regclass('public.ticket_dimension_profiles_driver_idx') is not null then
    drop index public.ticket_dimension_profiles_driver_idx;
  end if;
end;
$$;

create index if not exists ticket_dimension_profiles_concern_idx
  on public.ticket_dimension_profiles (concern_key)
  where concern_key is not null;

create index if not exists ticket_dimension_profiles_driver_compat_idx
  on public.ticket_dimension_profiles (driver_key)
  where driver_key is not null;

update public.ticket_dimension_profiles
set
  metadata = case
    when metadata #> '{configured_field_ids,driver}' is not null
         and metadata #> '{configured_field_ids,concern}' is null then
      jsonb_set(
        metadata #- '{configured_field_ids,driver}',
        '{configured_field_ids,concern}',
        metadata #> '{configured_field_ids,driver}',
        true
      )
    when metadata #> '{configured_field_ids,driver}' is not null then
      metadata #- '{configured_field_ids,driver}'
    else metadata
  end,
  profile_version = 'zendesk-custom-fields-v2',
  updated_at = now();

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
      nullif(btrim(profile.concern_key), '') as concern_key,
      profile.source_updated_at,
      coalesce(nullif(btrim(profile.source_system), ''), 'zendesk') as source_system,
      coalesce(nullif(btrim(profile.source_record_type), ''), 'ticket') as source_record_type,
      coalesce(
        nullif(btrim(profile.source_record_id), ''),
        profile.ticket_id::text
      ) as source_record_id,
      coalesce(
        nullif(btrim(profile.profile_version), ''),
        'zendesk-custom-fields-v2'
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
      concern_key text,
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
      concern_key,
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
      concern_key,
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
      concern_key = excluded.concern_key,
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

revoke all
on function public.upsert_ticket_dimension_profiles(jsonb)
from public, anon, authenticated;

grant execute
on function public.upsert_ticket_dimension_profiles(jsonb)
to service_role;

update public.zendesk_sync_state
set
  cursor = null,
  start_time = null,
  last_event_timestamp = null,
  last_success_at = null,
  lease_token = null,
  lease_expires_at = null,
  updated_at = now()
where stream_key = 'ticket_dimensions_backfill';

comment on table public.ticket_dimension_profiles is
  'Server-only current Zendesk ticket dimensions used for app, platform, country, and concern reporting.';

comment on column public.ticket_dimension_profiles.concern_key is
  'Normalized Zendesk Concerns ticket-field value.';

comment on column public.ticket_dimension_profiles.driver_key is
  'Generated compatibility alias for concern_key used by the existing Step 4 dashboard RPC.';

comment on function public.upsert_ticket_dimension_profiles(jsonb) is
  'Upserts current ticket-dimension profiles using concern_key without rewriting immutable ticket lifecycle events.';

commit;
