-- Phase 2 Step 10 verification.
-- Run this query before the first sync, after the first sync, and after the
-- second identical sync. total_rows and distinct_keys should remain equal
-- after the second sync. duplicate_rows and invalid_rows must remain zero.

with integrity as (
  select
    'daily_ticket_metrics'::text as dataset,
    count(*)::bigint as total_rows,
    count(distinct report_date)::bigint as distinct_keys,
    count(*) filter (
      where new_tickets < 0
         or unsolved_tickets < 0
         or solved_tickets < 0
         or one_touch_resolution not between 0 and 1
         or reopened_rate not between 0 and 1
    )::bigint as invalid_rows,
    max(report_date) as latest_report_date
  from public.daily_ticket_metrics

  union all

  select
    'daily_distribution_metrics',
    count(*)::bigint,
    count(distinct (report_date, dimension_type, dimension_key))::bigint,
    count(*) filter (where ticket_count < 0)::bigint,
    max(report_date)
  from public.daily_distribution_metrics

  union all

  select
    'agent_productivity',
    count(*)::bigint,
    count(distinct (report_date, agent_key))::bigint,
    count(*) filter (
      where solved_tickets < 0
         or open_tickets < 0
         or aht_value < 0
    )::bigint,
    max(report_date)
  from public.agent_productivity

  union all

  select
    'ticket_driver_metrics',
    count(*)::bigint,
    count(distinct (report_date, driver_key))::bigint,
    count(*) filter (where ticket_count < 0)::bigint,
    max(report_date)
  from public.ticket_driver_metrics
)
select
  dataset,
  total_rows,
  distinct_keys,
  total_rows - distinct_keys as duplicate_rows,
  invalid_rows,
  latest_report_date
from integrity
order by dataset;

select
  id,
  started_at,
  completed_at,
  status,
  report_date,
  rows_imported,
  error_message
from public.sheet_sync_runs
order by started_at desc
limit 5;
