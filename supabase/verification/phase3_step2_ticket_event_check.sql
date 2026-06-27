-- Read-only verification for Phase 3 Step 2.

with required_tables as (
  select unnest(array[
    'ticket_events',
    'zendesk_sync_state',
    'zendesk_sync_runs'
  ]) as table_name
),
missing_tables as (
  select table_name
  from required_tables
  where to_regclass('public.' || table_name) is null
),
duplicate_events as (
  select count(*) as duplicate_groups
  from (
    select source_event_id
    from public.ticket_events
    group by source_event_id
    having count(*) > 1
  ) duplicates
),
invalid_events as (
  select count(*) as invalid_rows
  from public.ticket_events
  where ticket_id <= 0
     or source_event_id is null
     or event_type is null
     or event_timestamp is null
     or source_system <> 'zendesk'
),
rls_state as (
  select count(*) filter (where relrowsecurity) as enabled_count
  from pg_class
  where oid = any (array[
    'public.ticket_events'::regclass,
    'public.zendesk_sync_state'::regclass,
    'public.zendesk_sync_runs'::regclass
  ])
),
state_row as (
  select count(*) as row_count
  from public.zendesk_sync_state
  where stream_key = 'tickets'
)
select
  'required_tables' as check_name,
  case when not exists (select 1 from missing_tables)
    then 'PASS' else 'FAIL' end as result,
  coalesce(
    (select string_agg(table_name, ', ') from missing_tables),
    'all present'
  ) as details
union all
select
  'source_event_id_uniqueness',
  case when duplicate_groups = 0 then 'PASS' else 'FAIL' end,
  duplicate_groups::text
from duplicate_events
union all
select
  'event_integrity',
  case when invalid_rows = 0 then 'PASS' else 'FAIL' end,
  invalid_rows::text
from invalid_events
union all
select
  'row_level_security',
  case when enabled_count = 3 then 'PASS' else 'FAIL' end,
  enabled_count::text || ' of 3 tables enabled'
from rls_state
union all
select
  'ticket_cursor_state',
  case when row_count = 1 then 'PASS' else 'FAIL' end,
  row_count::text || ' ticket stream rows'
from state_row;
