-- Workforce Phase 1 Step 4 verification checks.

select to_regprocedure(
  'public.workforce_admin_save_schedule(uuid,uuid,date,integer,timestamp with time zone,timestamp with time zone,text,text,boolean,boolean,text,text)'
) is not null as schedule_admin_rpc_exists;

select has_function_privilege(
  'authenticated',
  'public.workforce_admin_save_schedule(uuid,uuid,date,integer,timestamp with time zone,timestamp with time zone,text,text,boolean,boolean,text,text)',
  'EXECUTE'
) as authenticated_can_execute_schedule_admin;

select not has_function_privilege(
  'anon',
  'public.workforce_admin_save_schedule(uuid,uuid,date,integer,timestamp with time zone,timestamp with time zone,text,text,boolean,boolean,text,text)',
  'EXECUTE'
) as anon_cannot_execute_schedule_admin;

select relrowsecurity
from pg_class
where oid = 'public.work_schedules'::regclass;

select exists (
  select 1
  from pg_trigger
  where tgrelid = 'public.work_schedules'::regclass
    and tgname = 'work_schedules_workforce_audit'
    and not tgisinternal
) as schedule_audit_trigger_exists;

-- Blocker: should return 0 rows.
select schedule.id, schedule.user_id, schedule.shift_date, schedule.shift_sequence
from public.work_schedules schedule
left join public.profiles profile on profile.user_id = schedule.user_id
where profile.user_id is null
   or profile.is_agent is not true
   or schedule.shift_sequence < 1
   or schedule.shift_sequence > 99
   or (
     schedule.is_rest_day is false
     and (
       schedule.shift_start is null
       or schedule.shift_end is null
       or schedule.shift_end <= schedule.shift_start
     )
   )
   or (
     schedule.is_holiday is true
     and nullif(trim(coalesce(schedule.holiday_name, '')), '') is null
   );
