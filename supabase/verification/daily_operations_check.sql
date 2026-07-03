-- Read-only verification for Phase 3 Step 3.

with required_objects as (
  select
    to_regclass('public.daily_operations_metrics') as metrics_table,
    to_regprocedure(
      'public.refresh_daily_operations_metrics(date,date,text)'
    ) as refresh_function
),
duplicate_dates as (
  select count(*) as duplicate_groups
  from (
    select report_date
    from public.daily_operations_metrics
    group by report_date
    having count(*) > 1
  ) duplicates
),
invalid_metrics as (
  select count(*) as invalid_rows
  from public.daily_operations_metrics
  where tickets_created < 0
     or tickets_solved < 0
     or backlog_open < 0
     or backlog_over_24h < 0
     or backlog_over_48h < 0
     or reopened_tickets < 0
     or backlog_over_24h > backlog_open
     or backlog_over_48h > backlog_over_24h
     or first_response_minutes < 0
     or resolution_minutes < 0
     or sla_breaches < 0
     or csat_score < 0
     or report_timezone is null
     or btrim(report_timezone) = ''
     or calculated_at is null
),
source_state as (
  select
    count(*) as row_count,
    count(*) filter (
      where sla_breaches is null
        and csat_score is null
    ) as rows_without_future_sources
  from public.daily_operations_metrics
),
rls_state as (
  select relrowsecurity as enabled
  from pg_class
  where oid = 'public.daily_operations_metrics'::regclass
)
select
  'required_objects' as check_name,
  case
    when metrics_table is not null and refresh_function is not null
      then 'PASS'
    else 'FAIL'
  end as result,
  concat_ws(
    ', ',
    case when metrics_table is null then 'table missing' end,
    case when refresh_function is null then 'function missing' end,
    case
      when metrics_table is not null and refresh_function is not null
        then 'all present'
    end
  ) as details
from required_objects
union all
select
  'report_date_uniqueness',
  case when duplicate_groups = 0 then 'PASS' else 'FAIL' end,
  duplicate_groups::text
from duplicate_dates
union all
select
  'metric_integrity',
  case when invalid_rows = 0 then 'PASS' else 'FAIL' end,
  invalid_rows::text
from invalid_metrics
union all
select
  'row_level_security',
  case when enabled then 'PASS' else 'FAIL' end,
  case when enabled then 'enabled' else 'disabled' end
from rls_state
union all
select
  'derived_rows_present',
  case when row_count > 0 then 'PASS' else 'FAIL' end,
  row_count::text || ' daily rows'
from source_state
union all
select
  'future_sources_nullable',
  case
    when row_count = 0 or rows_without_future_sources > 0 then 'PASS'
    else 'FAIL'
  end,
  rows_without_future_sources::text ||
    ' rows retain null SLA and CSAT placeholders'
from source_state;
