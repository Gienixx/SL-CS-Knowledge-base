begin;

set local role authenticated;

with runtime_probe as (
  select public.get_dashboard_period_comparison(
    current_date - 6,
    current_date,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    'America/New_York',
    '7d'
  ) as payload
)
select
  'runtime_comparison_rpc'::text as check_name,
  case
    when jsonb_typeof(payload) = 'object'
      and payload ? 'currentRange'
      and payload ? 'previousRange'
      and payload ? 'metrics'
      then 'PASS'
    else 'FAIL'
  end as status,
  concat(
    'period=', coalesce(payload ->> 'periodKind', 'missing'),
    '; current=', coalesce(payload #>> '{currentRange,startDate}', 'missing'),
    '..', coalesce(payload #>> '{currentRange,endDate}', 'missing'),
    '; previous=', coalesce(payload #>> '{previousRange,startDate}', 'missing'),
    '..', coalesce(payload #>> '{previousRange,endDate}', 'missing')
  ) as details
from runtime_probe;

rollback;
