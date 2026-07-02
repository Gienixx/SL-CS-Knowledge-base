with checks as (
  select
    'ticket_metric_event_stream_state'::text as check_name,
    exists (
      select 1
      from public.zendesk_sync_state
      where stream_key = 'ticket_metric_events'
    ) as passed

  union all

  select
    'sla_event_type_reserved',
    exists (
      select 1
      from pg_constraint as constraint_row
      join pg_class as table_row
        on table_row.oid = constraint_row.conrelid
      join pg_namespace as namespace_row
        on namespace_row.oid = table_row.relnamespace
      where namespace_row.nspname = 'public'
        and table_row.relname = 'ticket_events'
        and constraint_row.contype = 'c'
        and pg_get_constraintdef(constraint_row.oid) like '%sla_breached%'
    )

  union all

  select
    'sla_response_dashboard_rpc',
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

select
  stream_key,
  last_success_at,
  case
    when last_success_at is null then 'NOT ACTIVATED'
    else 'READY'
  end as sla_stream_status
from public.zendesk_sync_state
where stream_key = 'ticket_metric_events';
