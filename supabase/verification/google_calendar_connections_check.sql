-- Google Calendar connection storage verification.
-- Run after 2026071001_google_calendar_connections.sql.

-- ---------------------------------------------------------------------------
-- 1. Required tables and columns
-- ---------------------------------------------------------------------------

select
  to_regclass('public.google_calendar_connections') is not null
    as connection_table_exists,
  to_regclass('public.google_calendar_oauth_states') is not null
    as oauth_state_table_exists;

select
  column_name,
  data_type,
  is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'google_calendar_connections'
order by ordinal_position;

select
  column_name,
  data_type,
  is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'google_calendar_oauth_states'
order by ordinal_position;

-- ---------------------------------------------------------------------------
-- 2. RLS and privilege boundary
-- ---------------------------------------------------------------------------

select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n
  on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in (
    'google_calendar_connections',
    'google_calendar_oauth_states'
  )
order by c.relname;

select
  has_table_privilege(
    'authenticated',
    'public.google_calendar_connections',
    'SELECT'
  ) as authenticated_can_select_connections_should_be_false,
  has_table_privilege(
    'authenticated',
    'public.google_calendar_connections',
    'INSERT'
  ) as authenticated_can_insert_connections_should_be_false,
  has_table_privilege(
    'authenticated',
    'public.google_calendar_oauth_states',
    'SELECT'
  ) as authenticated_can_select_oauth_states_should_be_false,
  has_table_privilege(
    'anon',
    'public.google_calendar_connections',
    'SELECT'
  ) as anonymous_can_select_connections_should_be_false;

-- ---------------------------------------------------------------------------
-- 3. Blocker queries
-- Every blocker query in section 3 must return zero rows.
-- ---------------------------------------------------------------------------

-- Browser roles must have no direct grants on either OAuth table.
select
  grantee,
  table_name,
  privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in (
    'google_calendar_connections',
    'google_calendar_oauth_states'
  )
  and grantee in ('anon', 'authenticated');

-- No browser-access RLS policies should exist.
select
  tablename,
  policyname,
  roles,
  cmd
from pg_policies
where schemaname = 'public'
  and tablename in (
    'google_calendar_connections',
    'google_calendar_oauth_states'
  );

-- Stored refresh tokens must use the versioned encrypted format.
select user_id
from public.google_calendar_connections
where encrypted_refresh_token not like 'v1.%';

-- OAuth state values must be single-use and short-lived.
select state_hash, user_id, expires_at
from public.google_calendar_oauth_states
where used_at is null
  and expires_at < now() - interval '1 hour';
