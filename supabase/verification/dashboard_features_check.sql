-- Phase 3 Step 11 verification. Read-only.

with checks as (
  select
    'dashboard_targets_table'::text as check_key,
    case when to_regclass('public.dashboard_targets') is not null then 'PASS' else 'FAIL' end as status,
    'Optional target comparison storage exists.'::text as details

  union all

  select
    'dashboard_targets_rls',
    case when coalesce((
      select relrowsecurity
      from pg_class
      where oid = to_regclass('public.dashboard_targets')
    ), false) then 'PASS' else 'FAIL' end,
    'Dashboard targets are protected by row-level security.'

  union all

  select
    'agent_dimension_metrics_table',
    case when to_regclass('public.agent_dimension_metrics') is not null then 'PASS' else 'FAIL' end,
    'Agent cross-filtering source exists.'

  union all

  select
    'dashboard_filter_capabilities_view',
    case when to_regclass('public.dashboard_filter_capabilities') is not null then 'PASS' else 'FAIL' end,
    'Dimension-filter availability view exists.'

  union all

  select
    'agent_dimension_data',
    case when exists (select 1 from public.agent_dimension_metrics) then 'PASS' else 'REVIEW' end,
    case when exists (select 1 from public.agent_dimension_metrics)
      then 'Agent-level dimension rows are available for cross-filtering.'
      else 'No agent-level dimension rows are synchronized yet; related filters must remain unavailable.'
    end

  union all

  select
    'sheet_only_dashboard_rpc',
    case when lower(pg_get_functiondef(
      'public.get_dashboard_filtered_data(date,date,text,text,text,text,text,text,text,text)'::regprocedure
    )) !~ 'ticket_events|ticket_dimension_profiles|agent_identity_map|zendesk_agent_directory'
      then 'PASS' else 'FAIL' end,
    'The active detailed dashboard RPC remains Google Sheet-only.'

  union all

  select
    'sheet_only_agent_rpc',
    case when lower(pg_get_functiondef(
      'public.get_agent_analytics_dashboard(date,date,text,text)'::regprocedure
    )) !~ 'ticket_events|ticket_dimension_profiles|agent_identity_map|zendesk_agent_directory'
      then 'PASS' else 'FAIL' end,
    'The active agent analytics RPC remains Google Sheet-only.'
)
select check_key, status, details
from checks
order by check_key;
