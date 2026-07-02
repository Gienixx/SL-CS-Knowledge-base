-- Phase 3 Step 7 verification: expanded agent analytics.

select
  to_regclass('public.agent_identity_map') as agent_identity_map_table,
  to_regprocedure(
    'public.get_agent_analytics_dashboard(date,date,text,text)'
  ) as agent_analytics_rpc;

select
  agent_key,
  agent_name,
  zendesk_agent_key,
  case when zendesk_agent_key is null then 'manual mapping required' else 'mapped' end
    as mapping_status
from public.agent_identity_map
order by agent_name;

select public.get_agent_analytics_dashboard(
  current_date - 29,
  current_date,
  null,
  'America/New_York'
) as agent_analytics_sample;
