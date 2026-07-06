-- Phase 1 Step 3 verification checks.

select to_regprocedure(
  'public.workforce_admin_save_employee(uuid,text,text,text,text,uuid,uuid,text,jsonb,text)'
) is not null as employee_admin_rpc_exists;

select to_regprocedure(
  'public.workforce_admin_save_team(uuid,text,text,uuid,boolean,text)'
) is not null as team_admin_rpc_exists;

select has_function_privilege(
  'authenticated',
  'public.workforce_admin_save_employee(uuid,text,text,text,text,uuid,uuid,text,jsonb,text)',
  'EXECUTE'
) as authenticated_can_execute_employee_admin;

select not has_function_privilege(
  'anon',
  'public.workforce_admin_save_employee(uuid,text,text,text,text,uuid,uuid,text,jsonb,text)',
  'EXECUTE'
) as anon_cannot_execute_employee_admin;

select has_function_privilege(
  'authenticated',
  'public.workforce_admin_save_team(uuid,text,text,uuid,boolean,text)',
  'EXECUTE'
) as authenticated_can_execute_team_admin;

select not has_function_privilege(
  'anon',
  'public.workforce_admin_save_team(uuid,text,text,uuid,boolean,text)',
  'EXECUTE'
) as anon_cannot_execute_team_admin;
