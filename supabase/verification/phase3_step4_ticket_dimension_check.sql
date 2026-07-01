-- Read-only verification for Phase 3 Step 4.

with required_objects as (
  select
    to_regclass('public.ticket_dimension_profiles') as profile_table,
    to_regprocedure(
      'public.upsert_ticket_dimension_profiles(jsonb)'
    ) as upsert_function,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'ticket_dimension_profiles'
        and column_name = 'concern_key'
    ) as concern_column_present
),
invalid_profiles as (
  select count(*) as invalid_rows
  from public.ticket_dimension_profiles
  where ticket_id <= 0
     or source_record_id is null
     or btrim(source_record_id) = ''
     or source_system <> 'zendesk'
     or source_record_type <> 'ticket'
     or jsonb_typeof(metadata) <> 'object'
     or driver_key is distinct from concern_key
),
coverage as (
  select
    count(*) as profile_count,
    count(*) filter (where app_key is not null) as app_count,
    count(*) filter (where platform_key is not null) as platform_count,
    count(*) filter (where country_key is not null) as country_count,
    count(*) filter (where concern_key is not null) as concern_count
  from public.ticket_dimension_profiles
),
rls_state as (
  select relrowsecurity as enabled
  from pg_class
  where oid = 'public.ticket_dimension_profiles'::regclass
),
client_grants as (
  select count(*) as grant_count
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name = 'ticket_dimension_profiles'
    and grantee in ('anon', 'authenticated')
),
backfill_state as (
  select count(*) as state_rows
  from public.zendesk_sync_state
  where stream_key = 'ticket_dimensions_backfill'
),
compatibility_alias as (
  select count(*) as generated_aliases
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'ticket_dimension_profiles'
    and column_name = 'driver_key'
    and is_generated = 'ALWAYS'
)
select
  'required_objects' as check_name,
  case
    when profile_table is not null
      and upsert_function is not null
      and concern_column_present
      then 'PASS'
    else 'FAIL'
  end as result,
  concat_ws(
    ', ',
    case when profile_table is null then 'table missing' end,
    case when upsert_function is null then 'function missing' end,
    case when not concern_column_present then 'concern_key missing' end,
    case
      when profile_table is not null
        and upsert_function is not null
        and concern_column_present
        then 'all present'
    end
  ) as details
from required_objects
union all
select
  'profile_integrity',
  case when invalid_rows = 0 then 'PASS' else 'FAIL' end,
  invalid_rows::text || ' invalid rows'
from invalid_profiles
union all
select
  'row_level_security',
  case when enabled then 'PASS' else 'FAIL' end,
  case when enabled then 'enabled' else 'disabled' end
from rls_state
union all
select
  'server_only_access',
  case when grant_count = 0 then 'PASS' else 'FAIL' end,
  grant_count::text || ' client table grants'
from client_grants
union all
select
  'backfill_state',
  case when state_rows = 1 then 'PASS' else 'FAIL' end,
  state_rows::text || ' state rows'
from backfill_state
union all
select
  'compatibility_alias',
  case when generated_aliases = 1 then 'PASS' else 'FAIL' end,
  generated_aliases::text || ' generated driver aliases'
from compatibility_alias
union all
select
  'dimension_coverage',
  case when profile_count > 0 then 'PASS' else 'FAIL' end,
  profile_count::text || ' profiles; app=' || app_count::text ||
    ', platform=' || platform_count::text ||
    ', country=' || country_count::text ||
    ', concern=' || concern_count::text
from coverage;
