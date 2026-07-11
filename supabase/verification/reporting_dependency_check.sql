with required_dependency as (
  select to_regprocedure(
    'public.get_dashboard_filtered_data(date,date,text,text,text,text,text,text,text,text)'
  ) as function_oid
)
select
  'step4_filtered_dashboard_rpc'::text as check_name,
  case when function_oid is not null then 'PASS' else 'FAIL' end as status,
  case
    when function_oid is not null then function_oid::text
    else 'Apply supabase/migrations-legacy/20260701_phase3_step4_global_filter_rpc.sql before Phase 3 Step 5.'
  end as details
from required_dependency;
