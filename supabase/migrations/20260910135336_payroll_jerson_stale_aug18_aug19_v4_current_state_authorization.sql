-- Superseding current-state authorization artifact; do not alter V2 or V3.
-- Do not deploy or execute against production in Stage 1.
-- This is deliberately a superseding function definition; historical audit logs are not authorization evidence. The unsafe three-source artifact
-- 20260908100000_payroll_jerson_stale_aug18_aug19_atomic_repair.sql is
-- untouched.
begin;

create or replace function public.payroll_repair_jerson_stale_aug18_aug19_v2(
  p_attendance_id uuid,
  p_actor_user_id uuid,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
set lock_timeout = '5s'
as $$
declare
  a public.attendance%rowtype;
  s public.payroll_attendance_snapshots%rowtype;
  after_a public.attendance%rowtype;
  period_row public.payroll_periods%rowtype;
  record_row public.payroll_records%rowtype;
  expected_version bigint;
  old_total integer;
  snapshot_id uuid;
  before_sources text;
  after_sources text;
  before_allocations text;
  after_allocations text;
  target_count bigint;
  target_minutes bigint;
  v_expected_sources constant text := 'e3b4f80cdad191046aa972603e3b2814';
  v_expected_allocations constant text := '1dd09f6c2eb1b9eab2a61c63355373c4';
  v_period constant uuid := 'dd6c75b4-4eb1-4b77-9aa7-82a536eeb15f';
  v_employee constant uuid := 'b303c569-c808-409f-958e-7bc89868b07f';
  v_payroll_record constant uuid := '1f60993d-1416-4576-a415-00909ba7e424';
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception using errcode='42501', message='service_role required';
  end if;
  if p_attendance_id not in (
    '0b622ed9-9c4c-4581-953a-778972097f57'::uuid,
    '4020d033-6ff6-4612-aa2e-9d814ea8f42b'::uuid
  ) then
    raise exception 'Unsupported Jerson V2 attendance';
  end if;
  if nullif(trim(p_reason),'') is null then
    raise exception 'Repair reason required';
  end if;
  if not exists (
    select 1 from public.profiles p
    where p.user_id=p_actor_user_id and p.is_system_admin
      and p.employment_status='active' and p.account_deleted_at is null
  ) then
    raise exception 'Active system administrator required';
  end if;

  -- One lock key per protected payroll period, followed by deterministic
  -- table/row locking. All contract checks below occur after the locks.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('jerson-v2:'||v_period::text,0)
  );
  lock table public.payroll_periods, public.payroll_records,
    public.attendance, public.payroll_attendance_snapshots,
    public.payroll_schedule_snapshots, public.payroll_prepaid_hours,
    public.payroll_hour_allocations, public.attendance_corrections,
    public.payroll_items, public.payslips
    in share row exclusive mode;

  select * into period_row from public.payroll_periods
    where id=v_period for update;
  if not found or period_row.status<>'draft'
     or period_row.finalization_version<>0 then
    raise exception 'Protected payroll period is not Draft';
  end if;
  select * into record_row from public.payroll_records
    where id=v_payroll_record and payroll_period_id=v_period
      and employee_id=v_employee for update;
  if not found or record_row.status<>'draft'
     or record_row.calculated_at is not null
     or record_row.calculated_by is not null
     or record_row.reviewed_at is not null
     or record_row.reviewed_by is not null
     or record_row.finalized_at is not null then
    raise exception 'Protected payroll record progressed';
  end if;
  if exists (select 1 from public.payroll_items i
             where i.payroll_record_id=v_payroll_record)
     or exists (select 1 from public.payslips y
                where y.payroll_record_id=v_payroll_record) then
    raise exception 'Protected payroll artifacts exist';
  end if;
  if exists (select 1 from public.payroll_audit_logs l
             where l.payroll_period_id=v_period
               and l.entity_id=p_attendance_id
               and l.action='payroll_jerson_stale_total_repaired_v2') then
    raise exception 'A successful V2 repair audit already exists';
  end if;

  -- Lock all protected sources and allocations in stable ID order before
  -- computing the contract hashes.
  perform 1 from public.payroll_prepaid_hours p
    where p.employee_id=v_employee order by p.id for update;
  perform 1 from public.payroll_hour_allocations x
    join public.payroll_prepaid_hours p on p.id=x.prepaid_hour_id
    where p.employee_id=v_employee order by x.id for update;

  if (select count(*) from public.payroll_prepaid_hours p
      where p.employee_id=v_employee)<>10
     or (select count(*) from public.payroll_prepaid_hours p
         where p.employee_id=v_employee and p.status='settled')<>9
     or (select count(*) from public.payroll_prepaid_hours p
         where p.employee_id=v_employee and p.status='void')<>1
     or (select coalesce(sum(p.prepaid_minutes),0)
         from public.payroll_prepaid_hours p where p.employee_id=v_employee)<>9600
     or (select coalesce(sum(p.settled_minutes),0)
         from public.payroll_prepaid_hours p where p.employee_id=v_employee)<>8640
     or (select coalesce(sum(p.remaining_minutes),0)
         from public.payroll_prepaid_hours p where p.employee_id=v_employee)<>960
     or exists (
       select 1 from public.payroll_prepaid_hours p
       where p.employee_id=v_employee and p.id not in (
         '133fe86b-109c-4822-b848-750b1cdb8f2d'::uuid,
         '1cf9618a-c3e1-4785-b57d-9681db00ffef'::uuid,
         '3444b168-1d5b-429a-83c3-e20500f5bc9d'::uuid,
         '4aee0543-b687-423c-aae5-c7b2e7bfa513'::uuid,
         '550d7adb-c2b4-45df-bca7-9d1979e6a4d1'::uuid,
         '58fbf104-544d-40d0-b65d-69cd97cd19c3'::uuid,
         '667a346b-902e-4ef5-bfb3-25e217924c89'::uuid,
         '9bf1621b-5d14-407b-bbb0-9c2d099dabdb'::uuid,
         'cfd1e104-ea77-41d1-9bd4-97bb18e3242f'::uuid,
         'e84e109f-6046-4d4d-b5ed-f20f0bd92064'::uuid
       )
     ) then
    raise exception 'Protected prepaid source set or aggregate drift';
  end if;
  select md5(coalesce(string_agg(jsonb_build_object(
    'id',p.id,'source_schedule_snapshot_id',p.source_schedule_snapshot_id,
    'employee_id',p.employee_id,'prepaid_minutes',p.prepaid_minutes,
    'settled_minutes',p.settled_minutes,'remaining_minutes',p.remaining_minutes,
    'status',p.status,'prepaid_version',p.prepaid_version,
    'superseded_by_id',p.superseded_by_id,'voided_at',p.voided_at
  )::text,'|' order by p.id),'')) into before_sources
  from public.payroll_prepaid_hours p where p.employee_id=v_employee;
  if before_sources<>v_expected_sources then
    raise exception 'Protected prepaid source contract drift';
  end if;

  if p_attendance_id='0b622ed9-9c4c-4581-953a-778972097f57'::uuid then
    expected_version:=12; old_total:=924;
    snapshot_id:='bd696e80-fd6a-4172-b541-f04f47e19c2a';
  else
    expected_version:=8; old_total:=935;
    snapshot_id:='40762649-a78f-43e1-90fc-0e1b048e016f';
  end if;
  select * into a from public.attendance
    where id=p_attendance_id and user_id=v_employee for update;
  if not found or a.attendance_version<>expected_version
     or a.total_worked_minutes<>old_total
     or a.review_status<>'approved' or a.payroll_approved_at is null
     or a.schedule_id is distinct from (case when p_attendance_id='0b622ed9-9c4c-4581-953a-778972097f57'::uuid
          then '586d8a19-81a4-4ffc-968b-8f1ddf7da869'::uuid
          else 'ed34aca9-86be-49ca-9ced-ddd21d8fde28'::uuid end)
     or a.work_date is distinct from (case when p_attendance_id='0b622ed9-9c4c-4581-953a-778972097f57'::uuid
          then date '2026-08-18' else date '2026-08-19' end)
     or a.clock_in is distinct from (case when p_attendance_id='0b622ed9-9c4c-4581-953a-778972097f57'::uuid
          then timestamptz '2026-08-17 15:46:12.193413+00'
          else timestamptz '2026-08-19 15:46:56.802475+00' end)
     or a.clock_out is distinct from (case when p_attendance_id='0b622ed9-9c4c-4581-953a-778972097f57'::uuid
          then timestamptz '2026-08-18 07:11:00.133669+00'
          else timestamptz '2026-08-20 07:22:37.354963+00' end)
     or a.billed_clock_in is distinct from (case when p_attendance_id='0b622ed9-9c4c-4581-953a-778972097f57'::uuid
          then timestamptz '2026-08-17 16:00:00+00'
          else timestamptz '2026-08-19 16:00:00+00' end)
     or a.billed_clock_out is distinct from (case when p_attendance_id='0b622ed9-9c4c-4581-953a-778972097f57'::uuid
          then timestamptz '2026-08-18 07:00:00+00'
          else timestamptz '2026-08-20 07:00:00+00' end)
     or a.reviewed_by is distinct from '9b11cbdf-9f09-46cb-bdbc-05ed75ef2b8e'::uuid
     or a.reviewed_at is null
     or not exists (
       select 1
       from public.profiles reviewer
       join public.user_permissions perm
         on perm.user_id=reviewer.user_id
        and perm.permission_key='approve_attendance'
        and perm.is_granted
       where reviewer.user_id=a.reviewed_by
         and reviewer.employment_status='active'
         and reviewer.account_deleted_at is null
     )
     or a.reviewed_at is distinct from (case when p_attendance_id='0b622ed9-9c4c-4581-953a-778972097f57'::uuid
          then timestamptz '2026-08-23 15:01:53.726674+00'
          else timestamptz '2026-08-23 15:02:03.042919+00' end)
     or public.workforce_canonical_billed_minutes(a.billed_clock_in,a.billed_clock_out)<>900
     or a.regular_minutes<>480 or a.pre_shift_overtime_minutes<>240
     or a.post_shift_overtime_minutes<>180 then
    raise exception 'Protected attendance contract drift';
  end if;
  select * into s from public.payroll_attendance_snapshots
    where id=snapshot_id and attendance_id=a.id
      and attendance_version=expected_version for update;
  if not found or s.payroll_record_id<>v_payroll_record
     or s.employee_id<>v_employee or s.attendance_id<>a.id
     or s.schedule_id is distinct from a.schedule_id
     or s.work_date is distinct from a.work_date
     or s.billed_clock_in is distinct from a.billed_clock_in
     or s.billed_clock_out is distinct from a.billed_clock_out
     or public.workforce_canonical_billed_minutes(s.billed_clock_in,s.billed_clock_out)<>900
     or s.regular_minutes<>480 or s.pre_shift_overtime_minutes<>240
     or s.post_shift_overtime_minutes<>180 then
    raise exception 'Protected snapshot contract drift';
  end if;
  if (select count(*) from public.payroll_attendance_snapshots x
      where x.attendance_id=a.id and x.attendance_version=expected_version)<>1 then
    raise exception 'Conflicting protected snapshot';
  end if;

  select count(*),coalesce(sum(x.allocated_minutes),0)
    into target_count,target_minutes
  from public.payroll_hour_allocations x
  where x.attendance_snapshot_id=s.id and x.allocation_type='settlement';
  if (p_attendance_id='0b622ed9-9c4c-4581-953a-778972097f57'::uuid
      and (target_count<>3 or target_minutes<>900))
     or (p_attendance_id='4020d033-6ff6-4612-aa2e-9d814ea8f42b'::uuid
      and (target_count<>4 or target_minutes<>900))
     or exists (select 1 from public.payroll_hour_allocations x
                where x.attendance_snapshot_id=s.id
                  and x.allocation_type<>'settlement') then
    raise exception 'Protected target allocation contract drift';
  end if;
  if p_attendance_id='4020d033-6ff6-4612-aa2e-9d814ea8f42b'::uuid
     and (select string_agg(x.minute_category||':'||x.allocated_minutes::text,','
                            order by x.minute_category,x.allocated_minutes,x.id)
          from public.payroll_hour_allocations x
          where x.attendance_snapshot_id=s.id)
          <> 'post_shift_overtime:180,pre_shift_overtime:240,regular:98,regular:382' then
    raise exception 'Aug 19 target classification split drift';
  end if;

  select md5(coalesce(string_agg(to_jsonb(x)::text,'|' order by x.id),''))
    into before_allocations
  from public.payroll_hour_allocations x
  join public.payroll_prepaid_hours p on p.id=x.prepaid_hour_id
  where p.employee_id=v_employee;
  if before_allocations<>v_expected_allocations then
    raise exception 'Protected allocation/reversal graph drift';
  end if;

  perform set_config('workforce.correction_recalculation','true',true);
  update public.attendance
    set total_worked_minutes=900
    where id=a.id and attendance_version=expected_version
      and total_worked_minutes=old_total
    returning * into after_a;
  if after_a.attendance_version<>expected_version+1
     or after_a.total_worked_minutes<>900 then
    raise exception 'Unexpected V2 versioned mutation';
  end if;

  select md5(coalesce(string_agg(jsonb_build_object(
    'id',p.id,'source_schedule_snapshot_id',p.source_schedule_snapshot_id,
    'employee_id',p.employee_id,'prepaid_minutes',p.prepaid_minutes,
    'settled_minutes',p.settled_minutes,'remaining_minutes',p.remaining_minutes,
    'status',p.status,'prepaid_version',p.prepaid_version,
    'superseded_by_id',p.superseded_by_id,'voided_at',p.voided_at
  )::text,'|' order by p.id),'')) into after_sources
  from public.payroll_prepaid_hours p where p.employee_id=v_employee;
  select md5(coalesce(string_agg(to_jsonb(x)::text,'|' order by x.id),''))
    into after_allocations
  from public.payroll_hour_allocations x
  join public.payroll_prepaid_hours p on p.id=x.prepaid_hour_id
  where p.employee_id=v_employee;
  if after_sources<>before_sources or after_allocations<>before_allocations
     or (select md5(to_jsonb(x)::text) from public.payroll_attendance_snapshots x
         where x.id=s.id)<>md5(to_jsonb(s)::text) then
    raise exception 'V2 unexpectedly changed protected financial state';
  end if;

  insert into public.payroll_audit_logs(
    actor_user_id,action,entity_type,entity_id,payroll_period_id,
    before_data,after_data,reason,metadata
  ) values (
    p_actor_user_id,'payroll_jerson_stale_total_repaired_v2','attendance',
    a.id,v_period,to_jsonb(a),to_jsonb(after_a),trim(p_reason),
    jsonb_build_object(
      'snapshot_id',s.id,'snapshot_unchanged',true,
      'prepaid_source_count',10,'prepaid_minutes',9600,
      'settled_minutes',8640,'remaining_minutes',960,
      'allocation_graph_hash',after_allocations,
      'reversal_graph_guarded',true,'reimport_required',true,
      'payroll_calculation_executed',false,'payroll_finalization_executed',false
    )
  );
  return jsonb_build_object(
    'version',2,'attendance_id',a.id,'before',to_jsonb(a),
    'after',to_jsonb(after_a),'prepaid_unchanged',true,
    'allocations_unchanged',true,'snapshot_unchanged',true,
    'reimport_required',true
  );
end;
$$;

alter function public.payroll_repair_jerson_stale_aug18_aug19_v2(uuid,uuid,text)
  owner to postgres;
revoke all on function public.payroll_repair_jerson_stale_aug18_aug19_v2(uuid,uuid,text)
  from public,anon,authenticated;
grant execute on function public.payroll_repair_jerson_stale_aug18_aug19_v2(uuid,uuid,text)
  to service_role;
commit;



;
