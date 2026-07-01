with comparison_function as (
  select to_regprocedure(
    'public.get_dashboard_period_comparison(date,date,text,text,text,text,text,text,text,text,text)'
  ) as function_oid
),
checks as (
  select
    'required_function'::text as check_name,
    case when function_oid is not null then 'PASS' else 'FAIL' end as status,
    coalesce(function_oid::text, 'missing') as details
  from comparison_function

  union all

  select
    'authenticated_execute',
    case
      when function_oid is not null
        and has_function_privilege('authenticated', function_oid, 'EXECUTE')
        then 'PASS'
      else 'FAIL'
    end,
    'authenticated role can execute the comparison RPC'
  from comparison_function

  union all

  select
    'anonymous_denied',
    case
      when function_oid is not null
        and not has_function_privilege('anon', function_oid, 'EXECUTE')
        then 'PASS'
      else 'FAIL'
    end,
    'anon role cannot execute the comparison RPC'
  from comparison_function

  union all

  select
    'reuses_filtered_contract',
    case
      when function_oid is not null
        and pg_get_functiondef(function_oid) like '%get_dashboard_filtered_data%'
        then 'PASS'
      else 'FAIL'
    end,
    'comparison RPC delegates both periods to the Step 4 aggregate RPC'
  from comparison_function

  union all

  select
    'zero_baseline_handling',
    case
      when function_oid is not null
        and pg_get_functiondef(function_oid) like '%zeroBaseline%'
        and pg_get_functiondef(function_oid) like '%previous_value = 0%'
        then 'PASS'
      else 'FAIL'
    end,
    'zero previous values return a non-infinite comparison state'
  from comparison_function
)
select check_name, status, details
from checks
order by check_name;
