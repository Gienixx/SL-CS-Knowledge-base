with required_functions as (
  select
    to_regprocedure(
      'public.get_dashboard_filtered_data(date,date,text,text,text,text,text,text,text,text)'
    ) as filtered_rpc,
    to_regprocedure(
      'public.get_dashboard_period_comparison(date,date,text,text,text,text,text,text,text,text,text)'
    ) as comparison_rpc
),
checks as (
  select
    filtered_rpc,
    comparison_rpc,
    filtered_rpc is not null
      and has_function_privilege('authenticated', filtered_rpc, 'EXECUTE')
      as filtered_rpc_executable,
    comparison_rpc is not null
      and has_function_privilege('authenticated', comparison_rpc, 'EXECUTE')
      as comparison_rpc_executable
  from required_functions
)
select
  'runtime_comparison_rpc'::text as check_name,
  case
    when filtered_rpc is not null
      and comparison_rpc is not null
      and filtered_rpc_executable
      and comparison_rpc_executable
      then 'PASS'
    else 'FAIL'
  end as status,
  concat_ws(
    '; ',
    case
      when filtered_rpc is null then
        'missing Step 4 filtered RPC'
      when not filtered_rpc_executable then
        'authenticated cannot execute Step 4 filtered RPC'
      else
        'Step 4 filtered RPC ready'
    end,
    case
      when comparison_rpc is null then
        'missing Step 5 comparison RPC'
      when not comparison_rpc_executable then
        'authenticated cannot execute Step 5 comparison RPC'
      else
        'Step 5 comparison RPC ready'
    end,
    'full data execution intentionally skipped because it performs expensive dashboard aggregation'
  ) as details
from checks;
