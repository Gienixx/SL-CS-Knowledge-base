-- Run after 20260714115839_workforce_schedule_delete.sql.

select
  to_regprocedure('public.workforce_admin_delete_schedule(uuid)') is not null
    as schedule_delete_rpc_exists,
  has_function_privilege('anon', 'public.workforce_admin_delete_schedule(uuid)', 'execute')
    as anon_can_delete_schedule,
  has_function_privilege('authenticated', 'public.workforce_admin_delete_schedule(uuid)', 'execute')
    as authenticated_can_call_delete_rpc;

select pg_get_functiondef('public.workforce_admin_delete_schedule(uuid)'::regprocedure)
  like '%not public.workforce_is_admin()%' as requires_admin,
  pg_get_functiondef('public.workforce_admin_delete_schedule(uuid)'::regprocedure)
  like '%workforce_has_permission(''manage_schedules'')%' as requires_schedule_permission,
  pg_get_functiondef('public.workforce_admin_delete_schedule(uuid)'::regprocedure)
  like '%workforce_can_manage_user(v_schedule.user_id, ''manage_schedules'')%' as enforces_employee_scope;

select exists (
  select 1
  from pg_trigger
  where tgrelid = 'public.work_schedules'::regclass
    and tgname = 'work_schedules_workforce_audit'
    and tgenabled <> 'D'
) as schedule_delete_is_audited;
