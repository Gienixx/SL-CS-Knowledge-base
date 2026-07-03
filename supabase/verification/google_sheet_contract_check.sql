-- Phase 3 Step 9 read-only production verification.
-- PASS means the Google Sheet reporting contract satisfies the exit criterion.
-- REVIEW means the implementation is installed but the seven-day test window is incomplete.
-- FAIL means the reported data or schema does not satisfy the contract.

with latest_metadata as (
  select *
  from public.sheet_sync_metadata
  where contract_version = 3
  order by generated_at desc
  limit 1
),
required_columns as (
  select *
  from (values
    ('daily_ticket_metrics', 'responded_tickets'),
    ('daily_ticket_metrics', 'first_response_minutes_total'),
    ('daily_ticket_metrics', 'first_response_median_minutes'),
    ('daily_ticket_metrics', 'resolved_tickets'),
    ('daily_ticket_metrics', 'resolution_minutes_total'),
    ('daily_ticket_metrics', 'resolution_median_minutes'),
    ('daily_ticket_metrics', 'reopened_tickets'),
    ('daily_ticket_metrics', 'one_touch_tickets'),
    ('agent_productivity', 'handled_tickets'),
    ('agent_productivity', 'handle_minutes_total'),
    ('agent_productivity', 'responded_tickets'),
    ('agent_productivity', 'first_response_minutes_total'),
    ('agent_productivity', 'first_response_median_minutes'),
    ('agent_productivity', 'resolved_tickets'),
    ('agent_productivity', 'resolution_minutes_total'),
    ('agent_productivity', 'resolution_median_minutes'),
    ('agent_productivity', 'reopened_tickets'),
    ('agent_productivity', 'one_touch_tickets'),
    ('agent_productivity', 'worked_hours')
  ) as columns(table_name, column_name)
),
schema_health as (
  select
    count(*) as expected_columns,
    count(c.column_name) as installed_columns
  from required_columns r
  left join information_schema.columns c
    on c.table_schema = 'public'
   and c.table_name = r.table_name
   and c.column_name = r.column_name
),
agent_totals as (
  select
    report_date,
    sum(solved_tickets)::numeric as solved_tickets,
    sum(responded_tickets)::numeric as responded_tickets,
    sum(first_response_minutes_total)::numeric as first_response_minutes_total,
    sum(resolved_tickets)::numeric as resolved_tickets,
    sum(resolution_minutes_total)::numeric as resolution_minutes_total,
    sum(reopened_tickets)::numeric as reopened_tickets,
    sum(one_touch_tickets)::numeric as one_touch_tickets
  from public.agent_productivity
  where report_date between
    (select test_window_start from latest_metadata)
    and
    (select test_window_end from latest_metadata)
  group by report_date
),
daily_reconciliation as (
  select
    count(*) as reporting_days,
    count(*) filter (
      where d.solved_tickets::numeric <> a.solved_tickets
         or d.responded_tickets::numeric <> a.responded_tickets
         or abs(
           d.first_response_minutes_total::numeric -
           a.first_response_minutes_total
         ) > 0.01
         or d.resolved_tickets::numeric <> a.resolved_tickets
         or abs(
           d.resolution_minutes_total::numeric -
           a.resolution_minutes_total
         ) > 0.01
         or d.reopened_tickets::numeric <> a.reopened_tickets
         or d.one_touch_tickets::numeric <> a.one_touch_tickets
    ) as mismatched_days
  from public.daily_ticket_metrics d
  join agent_totals a using (report_date)
  where d.report_date between
    (select test_window_start from latest_metadata)
    and
    (select test_window_end from latest_metadata)
),
agent_key_health as (
  select
    count(*) filter (where name_count > 1) as unstable_agent_keys
  from (
    select
      agent_key,
      count(distinct lower(trim(agent_name))) as name_count
    from public.agent_productivity
    where report_date between
      (select test_window_start from latest_metadata)
      and
      (select test_window_end from latest_metadata)
    group by agent_key
  ) agent_names
),
dimension_totals as (
  select
    report_date,
    agent_key,
    dimension_type,
    sum(ticket_count)::numeric as ticket_count
  from public.agent_dimension_metrics
  where report_date between
    (select test_window_start from latest_metadata)
    and
    (select test_window_end from latest_metadata)
  group by report_date, agent_key, dimension_type
),
dimension_health as (
  select
    count(*) as dimension_groups,
    count(*) filter (
      where d.ticket_count <> p.handled_tickets::numeric
    ) as mismatched_dimension_groups
  from dimension_totals d
  join public.agent_productivity p
    on p.report_date = d.report_date
   and p.agent_key = d.agent_key
),
dictionary_health as (
  select
    count(*) as documented_columns,
    count(*) filter (
      where length(trim(definition)) = 0
         or length(trim(validation_rule)) = 0
    ) as incomplete_definitions
  from public.reporting_data_dictionary
  where contract_version = 3
),
date_health as (
  select
    count(distinct report_date) as distinct_reporting_days,
    min(report_date) as first_reporting_day,
    max(report_date) as last_reporting_day
  from public.daily_ticket_metrics
  where report_date between
    (select test_window_start from latest_metadata)
    and
    (select test_window_end from latest_metadata)
),
checks as (
  select
    'Step 9 schema installed'::text as check_name,
    case
      when installed_columns = expected_columns
       and to_regclass('public.agent_dimension_metrics') is not null
       and to_regclass('public.reporting_data_dictionary') is not null
       and to_regclass('public.sheet_sync_metadata') is not null
      then 'PASS'
      else 'FAIL'
    end as status,
    format(
      '%s of %s required added columns are installed.',
      installed_columns,
      expected_columns
    ) as details
  from schema_health

  union all

  select
    'Seven consecutive test days',
    case
      when m.sync_run_id is null then 'REVIEW'
      when m.ready_for_production
       and m.test_days_count >= 7
       and d.distinct_reporting_days >= 7
       and d.first_reporting_day = m.test_window_start
       and d.last_reporting_day = m.test_window_end
      then 'PASS'
      else 'REVIEW'
    end,
    case
      when m.sync_run_id is null
      then 'No Step 9 sync metadata has been recorded.'
      else format(
        'Metadata reports %s day(s), %s through %s; ready=%s.',
        m.test_days_count,
        m.test_window_start,
        m.test_window_end,
        m.ready_for_production
      )
    end
  from latest_metadata m
  full join date_health d on true

  union all

  select
    'Stable agent_key mapping',
    case when unstable_agent_keys = 0 then 'PASS' else 'FAIL' end,
    format('%s unstable agent key(s) detected.', unstable_agent_keys)
  from agent_key_health

  union all

  select
    'Team and agent totals reconcile',
    case
      when mismatched_days = 0
       and reporting_days >= 7
      then 'PASS'
      when mismatched_days = 0
      then 'REVIEW'
      else 'FAIL'
    end,
    format(
      '%s reporting day(s) checked; %s mismatch(es).',
      reporting_days,
      mismatched_days
    )
  from daily_reconciliation

  union all

  select
    'Agent dimensions reconcile',
    case
      when mismatched_dimension_groups = 0
       and dimension_groups > 0
      then 'PASS'
      when dimension_groups = 0
      then 'REVIEW'
      else 'FAIL'
    end,
    format(
      '%s dimension group(s) checked; %s mismatch(es).',
      dimension_groups,
      mismatched_dimension_groups
    )
  from dimension_health

  union all

  select
    'Column definitions documented',
    case
      when documented_columns >= 50
       and incomplete_definitions = 0
      then 'PASS'
      else 'FAIL'
    end,
    format(
      '%s contract column(s) documented; %s incomplete definition(s).',
      documented_columns,
      incomplete_definitions
    )
  from dictionary_health
)
select *
from checks
order by check_name;
