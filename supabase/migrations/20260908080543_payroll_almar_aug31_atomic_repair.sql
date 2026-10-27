-- Definition only: never invokes the repair. One historical attendance only.
begin;
create function public.payroll_repair_almar_aug31(
 p_attendance_id uuid, p_actor_user_id uuid, p_reason text,
 p_expected_prepaid_fingerprint text
) returns jsonb language plpgsql security definer
set search_path = '' set timezone = 'UTC' set lock_timeout = '5s'
as $$
declare
 a public.attendance%rowtype; z public.attendance%rowtype;
 s public.work_schedules%rowtype; h public.payroll_attendance_snapshots%rowtype;
 p public.payroll_periods%rowtype; r public.payroll_records%rowtype;
 previous_setting text; prepaid_before text; prepaid_after text; blockers text[];
 period_id constant uuid := 'dd6c75b4-4eb1-4b77-9aa7-82a536eeb15f';
 v_employee_id constant uuid := '9b11cbdf-9f09-46cb-bdbc-05ed75ef2b8e';
begin
 if current_setting('transaction_isolation') <> 'read committed' then
  raise exception 'Repair requires READ COMMITTED'; end if;
 if coalesce(auth.jwt()->>'role','') <> 'service_role' then
  raise exception using errcode='42501', message='service_role required'; end if;
 if p_attendance_id is distinct from 'ec7a4621-2e99-4964-b351-8b7169af989f'::uuid then
  raise exception 'Only the fixed Almar attendance is allowed'; end if;
 if not exists(select 1 from public.profiles actor where actor.user_id=p_actor_user_id
   and actor.is_system_admin is true and actor.can_manage_payroll is true
   and actor.employment_status='active' and actor.account_deleted_at is null for share) then
  raise exception 'Active payroll system administrator required'; end if;
 if nullif(trim(p_reason),'') is null or nullif(trim(p_expected_prepaid_fingerprint),'') is null then
  raise exception 'Reason and expected prepaid fingerprint required'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('public.payroll_lifecycle:'||period_id::text,0));
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('public.payroll_import_attendance:'||period_id::text,0));
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(v_employee_id::text)::bigint);
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('public.payroll_prepaid_hours:'||v_employee_id::text,0));
 -- Bounded write exclusion protects absence predicates, including non-RPC writers.
 lock table public.payroll_periods,public.payroll_records,public.attendance,
  public.payroll_attendance_snapshots,public.payroll_schedule_snapshots,public.payroll_items,
  public.payroll_hour_allocations,public.payroll_prepaid_hours,public.payslips
  in share row exclusive mode;
 select * into p from public.payroll_periods where id=period_id for update;
 if not found or p.status is distinct from 'draft' or p.finalization_version is distinct from 0
  or p.period_start is distinct from date '2026-08-16' or p.period_end is distinct from date '2026-08-31'
  or p.approved_at is not null or p.approved_by is not null or p.reviewed_at is not null
  or p.reviewed_by is not null or p.finalized_at is not null or p.finalized_by is not null then
  raise exception 'Period must remain Draft and unfinalized'; end if;
 if exists(select 1 from public.payroll_records x where x.payroll_period_id=period_id
   and (x.status is distinct from 'draft' or x.calculated_at is not null or x.calculated_by is not null
     or x.reviewed_at is not null or x.reviewed_by is not null or x.finalized_at is not null)) then
  raise exception 'Calculated or progressed payroll blocks repair'; end if;
 if exists(select 1 from public.payroll_items i join public.payroll_records x on x.id=i.payroll_record_id where x.payroll_period_id=period_id)
  or exists(select 1 from public.payslips i join public.payroll_records x on x.id=i.payroll_record_id where x.payroll_period_id=period_id) then
  raise exception 'Payroll items or payslips block repair'; end if;
 select * into r from public.payroll_records x where x.id='faaf8298-c31f-43df-9fb0-a0ebf1e24cd6'
   and x.employee_id=v_employee_id and x.payroll_period_id=period_id for update;
 if not found then raise exception 'Expected payroll record missing'; end if;
 select * into a from public.attendance where id=p_attendance_id for update;
 if not found or a.attendance_version is distinct from 9 or a.work_date is distinct from date '2026-08-31'
  or a.total_worked_minutes is distinct from 965
  or md5(to_jsonb(a)::text) is distinct from '6f5a3d1f90cd51d16daba7dd3826dc79' then
  raise exception 'Attendance expected state drift'; end if;
 if a.user_id is distinct from v_employee_id or a.voided_at is not null
  or a.attendance_status is distinct from 'present' or a.review_status is distinct from 'corrected'
  or a.payroll_approved_at is not null
  or a.clock_in is distinct from timestamptz '2026-08-31 09:46:04.405115+00'
  or a.clock_out is distinct from timestamptz '2026-09-01 01:51:17.674400+00'
  or a.billed_clock_in is distinct from timestamptz '2026-08-31 10:00+00'
  or a.billed_clock_out is distinct from timestamptz '2026-09-01 01:00+00'
  or public.workforce_canonical_billed_minutes(a.billed_clock_in,a.billed_clock_out) is distinct from 900
  or a.regular_minutes is distinct from 480 or a.pre_shift_overtime_minutes is distinct from 0
  or a.post_shift_overtime_minutes is distinct from 420 or a.total_overtime_minutes is distinct from 420
  or a.overtime_minutes is distinct from 420 or a.rest_day_overtime_minutes is distinct from 0
  or a.holiday_overtime_minutes is distinct from 0 then raise exception 'Timing or classification drift'; end if;
 select * into s from public.work_schedules where id=a.schedule_id for share;
 if not found or s.id is distinct from 'f5c093bc-52a2-4101-b52f-84aece24fb57'::uuid
  or md5(to_jsonb(s)::text) is distinct from 'e3d4af75cd0752408684abd9cb210209'
  or s.user_id is distinct from v_employee_id or s.schedule_version is distinct from 2
  or s.status is distinct from 'published' or s.shift_date is distinct from date '2026-08-31'
  or s.timezone is distinct from 'America/New_York' or s.shift_start is not null or s.shift_end is not null
  or s.planned_paid_minutes is distinct from 480 or s.is_rest_day is distinct from false
  or s.is_holiday is distinct from false or s.is_leave is distinct from false or s.is_absent is distinct from false then
  raise exception 'Schedule expected state drift'; end if;
 -- Match the open-schedule branch, including the employee/date overtime budget.
 if least(900,s.planned_paid_minutes) is distinct from 480
  or least(greatest(900-s.planned_paid_minutes,0),greatest(0,1200-(select coalesce(sum(greatest(coalesce(x.total_overtime_minutes,0),0)),0)
   from public.attendance x where x.user_id=v_employee_id and x.work_date=a.work_date and x.id<>a.id and x.voided_at is null))) is distinct from 420::bigint then
  raise exception 'Open-schedule calculation drift'; end if;
 if exists(select 1 from public.attendance x where x.user_id=v_employee_id and x.id<>a.id and x.voided_at is null
  and (x.schedule_id=s.id or x.work_date=a.work_date
   or (x.clock_in<a.clock_out and coalesce(x.clock_out,'infinity')>a.clock_in)
   or (coalesce(x.billed_clock_in,x.clock_in)<a.billed_clock_out and coalesce(x.billed_clock_out,x.clock_out,'infinity')>a.billed_clock_in))) then
  raise exception 'Conflicting attendance'; end if;
 select * into h from public.payroll_attendance_snapshots where id='35b479d0-0c9f-4ecb-8c63-f2ba94f457b6' for update;
 if not found or md5(to_jsonb(h)::text) is distinct from '0d01f23629796229226282ad1d4993f8'
  or h.attendance_id is distinct from a.id or h.attendance_version is distinct from 7
  or h.payroll_record_id is distinct from r.id or h.regular_minutes is distinct from 720
  or h.post_shift_overtime_minutes is distinct from 180 then
  raise exception 'Historical snapshot expected state drift'; end if;
 if exists(select 1 from public.payroll_attendance_snapshots x where x.id<>h.id
   and (x.attendance_id=a.id or x.schedule_id=s.id or (x.employee_id=v_employee_id and
    (x.work_date=a.work_date or (coalesce(x.billed_clock_in,x.clock_in)<a.billed_clock_out
      and coalesce(x.billed_clock_out,x.clock_out)>a.billed_clock_in)))))
  or exists(select 1 from public.payroll_schedule_snapshots x where x.schedule_id=s.id) then
  raise exception 'Unexpected dependency snapshot'; end if;
 if exists(select 1 from public.payroll_hour_allocations x join public.payroll_attendance_snapshots y on y.id=x.attendance_snapshot_id
  where y.attendance_id=a.id or y.schedule_id=s.id) then raise exception 'Allocation or settlement dependency'; end if;
 if exists(select 1 from public.payroll_items i left join public.payroll_attendance_snapshots x on x.id=i.source_attendance_snapshot_id
  join public.payroll_records y on y.id=i.payroll_record_id where x.attendance_id=a.id or i.source_schedule_id=s.id
   or (y.employee_id=v_employee_id and i.work_date=a.work_date) or i.metadata::text like '%'||a.id::text||'%')
  or exists(select 1 from public.payslips x where x.payroll_record_id=h.payroll_record_id) then
  raise exception 'Historical payroll artifact dependency'; end if;
 select md5(coalesce(string_agg(to_jsonb(x)::text,'|' order by id),'')) into prepaid_before
  from public.payroll_prepaid_hours x where x.employee_id=v_employee_id;
 if prepaid_before is distinct from p_expected_prepaid_fingerprint then raise exception 'Prepaid fingerprint drift'; end if;
 select payroll_readiness_blockers into blockers from public.workforce_attendance_payroll_readiness where id=a.id;
 if blockers is distinct from array['total_worked_mismatch','review_required']::text[] then raise exception 'Unexpected readiness before repair'; end if;
 previous_setting:=current_setting('workforce.correction_recalculation',true);
 perform set_config('workforce.correction_recalculation','true',true);
 begin
  update public.attendance set total_worked_minutes=900 where id=a.id and attendance_version=9 and total_worked_minutes=965 returning * into z;
 exception when others then
  perform set_config('workforce.correction_recalculation',coalesce(previous_setting,'false'),true); raise;
 end;
 perform set_config('workforce.correction_recalculation',coalesce(previous_setting,'false'),true);
 if z.id is null or z.attendance_version is distinct from 10 or z.total_worked_minutes is distinct from 900
  or (to_jsonb(z)-array['total_worked_minutes','attendance_version','updated_at']) is distinct from
     (to_jsonb(a)-array['total_worked_minutes','attendance_version','updated_at']) then raise exception 'Unauthorized attendance change'; end if;
 select payroll_readiness_blockers into blockers from public.workforce_attendance_payroll_readiness where id=a.id;
 if blockers is distinct from array['review_required']::text[] then raise exception 'Unexpected readiness after repair'; end if;
 if (select to_jsonb(x) from public.payroll_attendance_snapshots x where id=h.id) is distinct from to_jsonb(h)
  or (select count(*) from public.payroll_attendance_snapshots where attendance_id=a.id)<>1
  or (select to_jsonb(x) from public.work_schedules x where id=s.id) is distinct from to_jsonb(s)
  or (select to_jsonb(x) from public.payroll_periods x where id=p.id) is distinct from to_jsonb(p) then
  raise exception 'Historical snapshot or schedule/period changed'; end if;
 select md5(coalesce(string_agg(to_jsonb(x)::text,'|' order by id),'')) into prepaid_after from public.payroll_prepaid_hours x where x.employee_id=v_employee_id;
 if prepaid_after is distinct from prepaid_before then raise exception 'Prepaid changed during repair'; end if;
 -- Existing AFTER UPDATE trigger marks the draft record stale and writes its own audit.
 if (select to_jsonb(x)-array['updated_at','requires_recalculation','recalculation_reason'] from public.payroll_records x where id=r.id)
  is distinct from (to_jsonb(r)-array['updated_at','requires_recalculation','recalculation_reason']) then raise exception 'Unexpected payroll record change'; end if;
 insert into public.payroll_audit_logs(actor_user_id,action,entity_type,entity_id,payroll_period_id,payroll_record_id,before_data,after_data,reason,metadata)
 values(p_actor_user_id,'payroll_almar_aug31_total_repaired','attendance',a.id,p.id,r.id,to_jsonb(a),to_jsonb(z),trim(p_reason),
  jsonb_build_object('historical_snapshot_id',h.id,'historical_snapshot_unchanged',true,'prepaid_fingerprint',prepaid_before,'approval_executed',false,'payroll_import_executed',false));
 return jsonb_build_object('attendance_id',a.id,'before',to_jsonb(a),'after',to_jsonb(z),'is_payroll_ready',false,'payroll_readiness_blockers',to_jsonb(blockers));
end;
$$;
alter function public.payroll_repair_almar_aug31(uuid,uuid,text,text) owner to postgres;
revoke all on function public.payroll_repair_almar_aug31(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.payroll_repair_almar_aug31(uuid,uuid,text,text) to service_role;
commit;

;
