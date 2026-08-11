begin;

create or replace function public.payroll_settle_restored_prepaid_attendance(
  p_prepaid_hour_id uuid,
  p_source_evidence text
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := public.workforce_current_profile_id();
  v_prepaid public.payroll_prepaid_hours%rowtype;
  v_record public.payroll_records%rowtype;
  v_period public.payroll_periods%rowtype;
  v_snapshot public.payroll_schedule_snapshots%rowtype;
  v_attendance_snapshot public.payroll_attendance_snapshots%rowtype;
  v_minutes integer;
  v_reason text := nullif(trim(p_source_evidence), '');
begin
  if auth.uid() is null or v_actor is null
     or not public.workforce_current_user_is_active()
     or not public.workforce_has_permission('create_payroll') then
    raise exception using errcode='42501', message='You do not have permission to settle restored prepaid hours.';
  end if;
  if p_prepaid_hour_id is null or v_reason is null then
    raise exception using errcode='22023', message='Prepaid source and settlement evidence are required.';
  end if;
  select * into v_prepaid from public.payroll_prepaid_hours where id=p_prepaid_hour_id for update;
  if not found or v_prepaid.voided_at is not null then raise exception using errcode='P0002', message='Active prepaid source was not found.'; end if;
  select * into v_record from public.payroll_records where id=v_prepaid.source_payroll_record_id for update;
  select * into v_period from public.payroll_periods where id=v_record.payroll_period_id for update;
  if v_period.status not in ('draft','reopened') or v_record.status in ('approved','finalized','void') then
    raise exception using errcode='55000', message='Restored prepaid settlement is allowed only for Draft or Reopened payroll.';
  end if;
  select * into v_snapshot from public.payroll_schedule_snapshots where id=v_prepaid.source_schedule_snapshot_id;
  select * into v_attendance_snapshot from public.payroll_attendance_snapshots s
  where s.payroll_record_id=v_record.id and s.employee_id=v_record.employee_id and s.work_date=v_snapshot.work_date
    and s.attendance_version=(select a.attendance_version from public.attendance a where a.id=s.attendance_id and a.review_status in ('approved','locked'))
  order by s.attendance_version desc limit 1;
  if not found then raise exception using errcode='55000', message='Matching approved billed attendance snapshot was not found.'; end if;
  v_minutes := floor(extract(epoch from (v_attendance_snapshot.clock_out-v_attendance_snapshot.clock_in))/60)::integer;
  if v_minutes <= 0 then raise exception using errcode='55000', message='Matching billed attendance duration is invalid.'; end if;
  if v_prepaid.remaining_minutes = 0 then raise exception using errcode='23505', message='Prepaid source is already fully settled.'; end if;
  if v_minutes < v_prepaid.remaining_minutes then
    -- Partial rendering settles only the available matching minutes.
    v_minutes := v_minutes;
  else
    v_minutes := v_prepaid.remaining_minutes;
  end if;
  if exists (select 1 from public.payroll_hour_allocations a where a.prepaid_hour_id=v_prepaid.id and a.attendance_snapshot_id=v_attendance_snapshot.id and a.allocation_type='settlement') then
    raise exception using errcode='23505', message='This restored prepaid source is already allocated to the attendance snapshot.';
  end if;
  insert into public.payroll_hour_allocations(prepaid_hour_id,employee_id,destination_payroll_record_id,attendance_snapshot_id,allocation_type,minute_category,allocated_minutes,calculation_version,reason,created_by)
  values(v_prepaid.id,v_record.employee_id,v_record.id,v_attendance_snapshot.id,'settlement','regular',v_minutes,greatest(v_record.calculation_version,1),v_reason,v_actor);
  update public.payroll_prepaid_hours set settled_minutes=settled_minutes+v_minutes,last_settled_at=statement_timestamp(),updated_at=statement_timestamp() where id=v_prepaid.id;
  insert into public.payroll_audit_logs(actor_user_id,action,entity_type,entity_id,payroll_period_id,payroll_record_id,after_data,reason,metadata)
  values(v_actor,'payroll_restored_prepaid_settled','payroll_prepaid_hours',v_prepaid.id,v_period.id,v_record.id,
    jsonb_build_object('allocated_minutes',v_minutes,'attendance_snapshot_id',v_attendance_snapshot.id,'remaining_minutes',v_prepaid.remaining_minutes-v_minutes),v_reason,
    jsonb_build_object('historical_restore',true));
  return jsonb_build_object('prepaid_hour_id',v_prepaid.id,'allocated_minutes',v_minutes,'remaining_minutes',v_prepaid.remaining_minutes-v_minutes);
end;
$$;

revoke all on function public.payroll_settle_restored_prepaid_attendance(uuid,text) from public,anon;
grant execute on function public.payroll_settle_restored_prepaid_attendance(uuid,text) to authenticated,service_role;
commit;
