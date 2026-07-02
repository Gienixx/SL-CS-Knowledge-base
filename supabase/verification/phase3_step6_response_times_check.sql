with checks as (
  select
    'ticket_events_available'::text as check_name,
    to_regclass('public.ticket_events') is not null as passed

  union all

  select
    'response_time_dashboard_rpc',
    to_regprocedure(
      'public.get_sla_response_dashboard(date,date,text,text,text,text,text,text,text,text)'
    ) is not null

  union all

  select
    'authenticated_execution',
    has_function_privilege(
      'authenticated',
      'public.get_sla_response_dashboard(date,date,text,text,text,text,text,text,text,text)',
      'EXECUTE'
    )
)
select
  check_name,
  case when passed then 'PASS' else 'FAIL' end as result
from checks
order by check_name;
