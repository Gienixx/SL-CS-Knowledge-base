-- The regular agent path and both conversion directions are exercised by the
-- existing schedule-conversion-payroll-check fixture. These cases ensure the
-- new admin gate remains self-service only and cannot target another profile.
insert into public.work_schedules(
  id,user_id,shift_date,shift_sequence,shift_start,shift_end,timezone,status,is_rest_day
) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa8','11111111-1111-1111-1111-111111111111','2026-11-09',1,'2026-11-09 14:00+00','2026-11-09 22:00+00','America/New_York','published',false),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa9','33333333-3333-3333-3333-333333333333','2026-11-07',1,'2026-11-07 14:00+00','2026-11-07 22:00+00','America/New_York','published',false),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa10','33333333-3333-3333-3333-333333333333','2026-11-08',1,null,null,'America/New_York','published',true),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa11','11111111-1111-1111-1111-111111111111','2026-11-18',1,null,null,'America/New_York','published',true);

do $$
declare
  request_row public.leave_requests%rowtype;
  schedule_row public.work_schedules%rowtype;
  failed boolean;
  function_oid oid;
begin
  select p.oid into function_oid
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'
    and p.proname='workforce_submit_schedule_conversion_request';
  if function_oid is null
     or not (select prosecdef from pg_proc where oid=function_oid)
     or not has_function_privilege('authenticated',function_oid,'execute')
     or has_function_privilege('anon',function_oid,'execute')
     or (select coalesce(array_to_string(proconfig,','),'') not like '%search_path=""%'
         from pg_proc where oid=function_oid)
     or exists (
       select 1 from pr68_test.conversion_function_security original
       join pg_proc p on pg_get_function_identity_arguments(p.oid)=original.identity_args
       where p.oid=function_oid
         and (p.proacl is distinct from original.proacl
           or p.prosecdef is distinct from original.prosecdef
           or p.proconfig is distinct from original.proconfig)
     ) then
    raise exception 'Conversion RPC security settings or execution grants changed';
  end if;

  -- Admin-only accounts can submit both conversions against their own schedule.
  perform set_config('request.jwt.claim.sub','33333333-3333-3333-3333-333333333333',false);
  perform set_config('test.is_agent','false',false);
  perform set_config('test.is_admin','true',false);
  perform set_config('test.can_manage','false',false);
  request_row := public.workforce_submit_schedule_conversion_request(
    'rest_day','2026-11-07','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa9',null,null,'admin own shift'
  );
  select * into schedule_row from public.work_schedules where id=request_row.target_schedule_id;
  if request_row.status <> 'pending'
     or request_row.user_id <> '33333333-3333-3333-3333-333333333333'
     or schedule_row.is_rest_day
     or schedule_row.shift_start is null then
    raise exception 'Admin-only Rest Day request bypassed pending approval or ownership';
  end if;

  request_row := public.workforce_submit_schedule_conversion_request(
    'regular_shift','2026-11-08','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa10',
    '2026-11-08 14:00+00','2026-11-08 22:00+00','admin own rest day'
  );
  select * into schedule_row from public.work_schedules where id=request_row.target_schedule_id;
  if request_row.status <> 'pending'
     or request_row.user_id <> '33333333-3333-3333-3333-333333333333'
     or not schedule_row.is_rest_day then
    raise exception 'Admin-only Regular Shift request changed a schedule before approval';
  end if;

  -- An admin cannot submit a conversion against a coworker's schedule.
  failed := false;
  begin
    perform public.workforce_submit_schedule_conversion_request(
      'rest_day','2026-11-09','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa8',null,null,'wrong employee'
    );
    raise exception 'TEST_UNEXPECTED_SUCCESS';
  exception when others then
    if sqlerrm='TEST_UNEXPECTED_SUCCESS' then raise; end if;
    failed := true;
  end;
  if not failed then raise exception 'Admin submitted a coworker schedule conversion'; end if;

  -- A dual-role user and an ordinary agent remain authorized by their own role.
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',false);
  perform set_config('test.is_agent','true',false);
  perform set_config('test.is_admin','true',false);
  request_row := public.workforce_submit_schedule_conversion_request(
    'rest_day','2026-11-09','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa8',null,null,'dual role own shift'
  );
  if request_row.status <> 'pending'
     or request_row.user_id <> '11111111-1111-1111-1111-111111111111' then
    raise exception 'Dual-role agent/admin request failed';
  end if;

  perform set_config('test.is_admin','false',false);
  request_row := public.workforce_submit_schedule_conversion_request(
    'regular_shift','2026-11-18','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa11',
    '2026-11-18 14:00+00','2026-11-18 22:00+00','ordinary agent own shift'
  );
  if request_row.status <> 'pending'
     or request_row.user_id <> '11111111-1111-1111-1111-111111111111' then
    raise exception 'Regular agent request failed';
  end if;

  -- Active role flags do not override an inactive profile.
  perform set_config('request.jwt.claim.sub','44444444-4444-4444-4444-444444444444',false);
  perform set_config('test.is_agent','false',false);
  perform set_config('test.is_admin','true',false);
  failed := false;
  begin
    perform public.workforce_submit_schedule_conversion_request(
      'rest_day','2026-11-07','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa9',null,null,'inactive admin'
    );
    raise exception 'TEST_UNEXPECTED_SUCCESS';
  exception when others then
    if sqlerrm='TEST_UNEXPECTED_SUCCESS' then raise; end if;
    failed := true;
  end;
  if not failed then raise exception 'Inactive admin submitted a schedule conversion'; end if;
end $$;

select 'admin schedule conversion checks passed' as result;
