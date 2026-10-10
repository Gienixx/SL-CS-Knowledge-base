select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',false);
select set_config('test.is_agent','true',false);
select set_config('test.is_admin','false',false);
select set_config('test.can_manage','true',false);
insert into public.work_schedules(id,user_id,shift_date,shift_sequence,shift_start,shift_end,timezone,status,is_rest_day)
values
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','11111111-1111-1111-1111-111111111111','2026-10-20',1,'2026-10-20 13:00+00','2026-10-20 21:00+00','America/New_York','published',false),
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','11111111-1111-1111-1111-111111111111','2026-10-21',1,null,null,'America/New_York','published',true),
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','11111111-1111-1111-1111-111111111111','2026-10-22',1,'2026-10-22 13:00+00','2026-10-22 21:00+00','America/New_York','published',false),
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4','11111111-1111-1111-1111-111111111111','2026-10-23',1,'2026-10-23 13:00+00','2026-10-23 21:00+00','America/New_York','published',false),
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5','11111111-1111-1111-1111-111111111111','2026-10-24',1,'2026-10-24 13:00+00','2026-10-24 21:00+00','America/New_York','published',false),
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa6','11111111-1111-1111-1111-111111111111','2026-10-25',1,'2026-10-25 13:00+00','2026-10-25 21:00+00','America/New_York','published',false),
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa7','11111111-1111-1111-1111-111111111111','2026-10-26',1,null,null,'America/New_York','published',true);
do $$ declare r public.leave_requests%rowtype; s public.work_schedules%rowtype; failed boolean;
begin
  -- Regular Shift -> Rest Day: pending-only first, with a captured original shift.
  r := public.workforce_submit_schedule_conversion_request('rest_day','2026-10-20','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',null,null,'personal request');
  if r.status <> 'pending' or r.original_shift_start <> '2026-10-20 13:00+00'::timestamptz then raise exception 'Rest Day submission snapshot failed'; end if;
  select * into s from public.work_schedules where id=r.target_schedule_id;
  if s.is_rest_day or s.shift_start is null then raise exception 'Submission changed the schedule before approval'; end if;

  -- Duplicate pending conversion is rejected.
  failed := false;
  begin perform public.workforce_submit_schedule_conversion_request('rest_day','2026-10-20','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',null,null,'duplicate'); exception when others then failed := true; end;
  if not failed then raise exception 'Duplicate request was accepted'; end if;

  -- The established admin and schedule permissions are required to approve.
  perform set_config('test.is_admin','true',false);
  perform set_config('test.can_manage','false',false);
  failed := false;
  begin perform public.workforce_apply_schedule_conversion_request(r.id,null); exception when others then failed := true; end;
  if not failed then raise exception 'Unauthorized admin approval was accepted'; end if;
  perform set_config('test.can_manage','true',false);
  r := public.workforce_apply_schedule_conversion_request(r.id,'approved for harness');
  select * into s from public.work_schedules where id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';
  if r.status <> 'approved' or not s.is_rest_day or s.shift_start is not null or s.shift_end is not null then raise exception 'Rest Day approval failed'; end if;
  if not exists(select 1 from public.workforce_audit_logs where action='historical_schedule_correction' and entity_type='work_schedules' and entity_id=s.id and before_data->>'shift_start' is not null and after_data->>'is_rest_day'='true') then raise exception 'Schedule before/after audit missing'; end if;

  -- Rest Day -> overnight Regular Shift. It remains a Rest Day until approval.
  r := public.workforce_submit_schedule_conversion_request('regular_shift','2026-10-21','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','2026-10-21 23:00+00','2026-10-22 07:00+00','overnight shift');
  select * into s from public.work_schedules where id=r.target_schedule_id;
  if r.status <> 'pending' or not s.is_rest_day then raise exception 'Regular Shift submission changed the Rest Day'; end if;
  r := public.workforce_apply_schedule_conversion_request(r.id,null);
  select * into s from public.work_schedules where id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2';
  if r.status <> 'approved' or s.is_rest_day or s.shift_start <> '2026-10-21 23:00+00'::timestamptz or s.shift_end <> '2026-10-22 07:00+00'::timestamptz then raise exception 'Overnight Regular Shift approval failed'; end if;

  -- Invalid type, invalid source shape, incomplete times, and overlong shifts fail.
  failed := false;
  begin perform public.workforce_submit_schedule_conversion_request('slide_shift','2026-10-23','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4',null,null,'invalid type'); exception when others then failed := true; end;
  if not failed then raise exception 'Invalid conversion type was accepted'; end if;
  failed := false;
  begin perform public.workforce_submit_schedule_conversion_request('regular_shift','2026-10-23','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4','2026-10-23 13:00+00','2026-10-23 14:00+00','wrong source type'); exception when others then failed := true; end;
  if not failed then raise exception 'Regular Shift accepted a regular schedule'; end if;
  failed := false;
  begin perform public.workforce_submit_schedule_conversion_request('regular_shift','2026-10-21','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa7',null,'2026-10-22 07:00+00','missing start'); exception when others then failed := true; end;
  if not failed then raise exception 'Missing shift start was accepted'; end if;
  failed := false;
  begin perform public.workforce_submit_schedule_conversion_request('regular_shift','2026-10-21','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa7','2026-10-21 12:00+00','2026-10-22 13:00+00','over 24h'); exception when others then failed := true; end;
  if not failed then raise exception 'Shift over 24 hours was accepted'; end if;

  -- A stale source schedule blocks approval and leaves the request pending.
  perform set_config('test.is_admin','false',false);
  r := public.workforce_submit_schedule_conversion_request('rest_day','2026-10-22','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3',null,null,'stale check');
  update public.work_schedules set shift_start=shift_start + interval '15 minutes', schedule_version=schedule_version+1, updated_at=updated_at+interval '1 second' where id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3';
  perform set_config('test.is_admin','true',false);
  failed := false;
  begin perform public.workforce_apply_schedule_conversion_request(r.id,null); exception when others then failed := true; end;
  if not failed then raise exception 'Stale source was approved'; end if;
  select * into r from public.leave_requests where id=r.id;
  if r.status <> 'pending' then raise exception 'Stale request status changed'; end if;

  -- Live attendance and finalized payroll both block a conversion.
  perform set_config('test.is_admin','false',false);
  insert into public.attendance(user_id,work_date,schedule_id) values('11111111-1111-1111-1111-111111111111','2026-10-24','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5');
  failed := false;
  begin perform public.workforce_submit_schedule_conversion_request('rest_day','2026-10-24','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5',null,null,'attendance conflict'); exception when others then failed := true; end;
  if not failed then raise exception 'Attendance-conflicting request was accepted'; end if;  -- Voided attendance with a payroll approval lock must still block schedule changes.
  insert into public.attendance(user_id,work_date,schedule_id,voided_at,payroll_approved_at) values('11111111-1111-1111-1111-111111111111','2026-10-25','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa6',now(),now());
  failed := false;
  begin perform public.workforce_submit_schedule_conversion_request('rest_day','2026-10-25','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa6',null,null,'payroll locked attendance'); exception when others then failed := true; end;
  if not failed then raise exception 'Payroll-locked attendance was accepted'; end if;
  insert into public.payroll_periods(period_start,period_end,status) values('2026-10-26','2026-10-31','finalized');
  failed := false;
  begin perform public.workforce_submit_schedule_conversion_request('regular_shift','2026-10-26','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa7','2026-10-26 13:00+00','2026-10-26 21:00+00','finalized payroll'); exception when others then failed := true; end;
  if not failed then raise exception 'Finalized-payroll request was accepted'; end if;

  -- An unrelated identity cannot submit against another employee's schedule.
  perform set_config('request.jwt.claim.sub','22222222-2222-2222-2222-222222222222',false);
  failed := false;
  begin perform public.workforce_submit_schedule_conversion_request('rest_day','2026-10-25','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa6',null,null,'wrong owner'); exception when others then failed := true; end;
  if not failed then raise exception 'Unauthorized schedule conversion was accepted'; end if;
end $$;
select 'schedule conversion behavior checks passed' as result;
