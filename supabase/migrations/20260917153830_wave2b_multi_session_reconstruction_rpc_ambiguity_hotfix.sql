-- Narrow Wave 2B hotfix: qualify every RPC variable/column reference.
-- This finalizes the undeployed ambiguity hotfix with the narrow approved
-- multi-session evidence contract required to reject altered submissions.
begin;

-- Approved multi-session evidence is established separately from execution
-- provenance.  The reconstruction caller receives SELECT-only access; no
-- client or service-role caller can create, update, or delete approval data.
create table if not exists workforce_internal.wave2b_approved_multi_session_headers (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references public.payroll_periods(id),
  user_id uuid not null references public.profiles(user_id),
  work_date date not null,
  source_schedule_id uuid not null references public.work_schedules(id),
  source_schedule_version bigint not null,
  approved_source_registry_id uuid not null references workforce_internal.wave2b_approved_source_evidence(period_id),
  source_type text not null check (source_type = 'historical_workbook'),
  source_filename text not null,
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_sheet text not null,
  source_row_reference text not null,
  source_reference text not null,
  expected_session_count smallint not null check (expected_session_count > 1),
  expected_total_minutes integer not null check (expected_total_minutes > 0),
  created_at timestamptz not null default now(),
  constraint wave2b_approved_multi_session_header_identity_uq unique (period_id, user_id, work_date),
  constraint wave2b_approved_multi_session_header_source_uq unique (approved_source_registry_id, source_schedule_id, work_date)
);

create table if not exists workforce_internal.wave2b_approved_multi_session_sessions (
  id uuid primary key default gen_random_uuid(),
  header_id uuid not null references workforce_internal.wave2b_approved_multi_session_headers(id),
  session_sequence smallint not null check (session_sequence >= 1),
  billed_clock_in timestamptz not null,
  billed_clock_out timestamptz not null,
  duration_minutes integer not null check (duration_minutes > 0),
  created_at timestamptz not null default now(),
  constraint wave2b_approved_multi_session_session_sequence_uq unique (header_id, session_sequence),
  constraint wave2b_approved_multi_session_session_interval_uq unique (header_id, billed_clock_in, billed_clock_out),
  constraint wave2b_approved_multi_session_session_interval_ck check (billed_clock_out > billed_clock_in),
  constraint wave2b_approved_multi_session_session_duration_ck check (
    duration_minutes = floor(extract(epoch from (billed_clock_out - billed_clock_in)) / 60)::integer
  )
);

alter table workforce_internal.wave2b_approved_multi_session_headers enable row level security;
alter table workforce_internal.wave2b_approved_multi_session_sessions enable row level security;
revoke all on table workforce_internal.wave2b_approved_multi_session_headers from public, anon, authenticated, service_role;
revoke all on table workforce_internal.wave2b_approved_multi_session_sessions from public, anon, authenticated, service_role;
grant select on table workforce_internal.wave2b_approved_multi_session_headers to service_role;
grant select on table workforce_internal.wave2b_approved_multi_session_sessions to service_role;

create or replace function workforce_internal.reject_immutable_wave2b_approved_multi_session_manifest()
returns trigger
language plpgsql
security invoker
set search_path = public, workforce_internal, pg_temp
as $$
begin
  raise exception 'Wave 2B approved multi-session manifest is append-only.';
end;
$$;

drop trigger if exists wave2b_approved_multi_session_headers_immutable on workforce_internal.wave2b_approved_multi_session_headers;
drop trigger if exists wave2b_approved_multi_session_sessions_immutable on workforce_internal.wave2b_approved_multi_session_sessions;
create trigger wave2b_approved_multi_session_headers_immutable
before update or delete on workforce_internal.wave2b_approved_multi_session_headers
for each row execute function workforce_internal.reject_immutable_wave2b_approved_multi_session_manifest();
create trigger wave2b_approved_multi_session_sessions_immutable
before update or delete on workforce_internal.wave2b_approved_multi_session_sessions
for each row execute function workforce_internal.reject_immutable_wave2b_approved_multi_session_manifest();

comment on table workforce_internal.wave2b_approved_multi_session_headers is 'Controlled, immutable approved evidence for verified historical multi-session repairs; populated separately from execution.';
comment on table workforce_internal.wave2b_approved_multi_session_sessions is 'Exact immutable approved billed intervals for verified historical multi-session repairs.';

create or replace function public.workforce_wave2b_reconstruct_multi_session_attendance(
  p_manifest jsonb,
  p_actor_user_id uuid
)
returns table(
  reconstruction_id uuid, session_sequence smallint, attendance_id uuid,
  billed_clock_in timestamptz, billed_clock_out timestamptz,
  canonical_billed_minutes integer, total_worked_minutes integer,
  regular_minutes integer, pre_shift_overtime_minutes integer,
  post_shift_overtime_minutes integer, rest_day_overtime_minutes integer,
  holiday_overtime_minutes integer, total_overtime_minutes integer,
  schedule_id uuid, attendance_version bigint, review_status text,
  payroll_approved_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
declare
  v_period_id uuid := nullif(p_manifest->>'period_id','')::uuid;
  v_user_id uuid := nullif(p_manifest->>'user_id','')::uuid;
  v_work_date date := nullif(p_manifest->>'work_date','')::date;
  v_source_schedule_id uuid := nullif(p_manifest->>'source_schedule_id','')::uuid;
  v_schedule_version bigint := nullif(p_manifest->>'schedule_version','')::bigint;
  v_approved_manifest_id uuid := nullif(p_manifest->>'approved_manifest_id','')::uuid;
  v_source_mode text := p_manifest->>'source_schedule_mode';
  v_target_sessions jsonb := p_manifest->'sessions';
  v_session record;
  v_approved_header workforce_internal.wave2b_approved_multi_session_headers%rowtype;
  v_approved_session workforce_internal.wave2b_approved_multi_session_sessions%rowtype;
  v_attendance public.attendance%rowtype;
  v_header workforce_internal.wave2b_multi_session_reconstructions%rowtype;
  v_schedule public.work_schedules%rowtype;
  v_calc jsonb;
  v_seq smallint := 0;
  v_total integer := 0;
  v_duration integer;
  v_previous_out timestamptz;
  v_expected_count smallint;
  v_expected_total integer;
  v_actor_ok boolean;
begin
  if current_user not in ('postgres','service_role') then
    raise exception 'Wave 2B multi-session reconstruction is service-role only.';
  end if;
  if p_manifest is null or p_actor_user_id is null then
    raise exception 'Manifest and actor are required.';
  end if;
  select exists(
    select 1 from public.profiles as pr
    where pr.user_id = p_actor_user_id
      and pr.is_system_admin is true
      and pr.account_deleted_at is null
  ) into v_actor_ok;
  if not v_actor_ok then
    raise exception 'A non-deleted system administrator actor is required.';
  end if;

  v_expected_count := nullif(p_manifest->>'expected_session_count','')::smallint;
  v_expected_total := nullif(p_manifest->>'expected_total_minutes','')::integer;
  if v_period_id is null or v_user_id is null or v_work_date is null
     or v_source_schedule_id is null or v_schedule_version is null
     or v_approved_manifest_id is null
     or v_source_mode not in ('rest_day','timed_workday')
     or v_expected_count is null or v_expected_total is null
     or v_target_sessions is null or jsonb_typeof(v_target_sessions) <> 'array'
     or p_manifest->>'source_type' <> 'historical_workbook'
     or nullif(p_manifest->>'source_filename','') is null
     or nullif(p_manifest->>'source_sha256','') is null
     or nullif(p_manifest->>'source_sheet','') is null
     or nullif(p_manifest->>'source_row_reference','') is null
     or nullif(p_manifest->>'source_reference','') is null
     or nullif(p_manifest->>'idempotency_key','') is null
     or p_manifest->'pre_state' is null then
    raise exception 'Manifest is incomplete.';
  end if;

  select approved_header.* into v_approved_header
  from workforce_internal.wave2b_approved_multi_session_headers as approved_header
  where approved_header.id = v_approved_manifest_id
  for share;
  if not found
     or v_approved_header.period_id is distinct from v_period_id
     or v_approved_header.user_id is distinct from v_user_id
     or v_approved_header.work_date is distinct from v_work_date
     or v_approved_header.source_schedule_id is distinct from v_source_schedule_id
     or v_approved_header.source_schedule_version is distinct from v_schedule_version
     or v_approved_header.source_type is distinct from p_manifest->>'source_type'
     or v_approved_header.source_filename is distinct from p_manifest->>'source_filename'
     or v_approved_header.source_sha256 is distinct from lower(p_manifest->>'source_sha256')
     or v_approved_header.source_sheet is distinct from p_manifest->>'source_sheet'
     or v_approved_header.source_row_reference is distinct from p_manifest->>'source_row_reference'
     or v_approved_header.source_reference is distinct from p_manifest->>'source_reference'
     or v_approved_header.expected_session_count is distinct from v_expected_count
     or v_approved_header.expected_total_minutes is distinct from v_expected_total then
    raise exception 'Approved multi-session manifest identity/duration guard failed.';
  end if;
  if (select count(*) from workforce_internal.wave2b_approved_multi_session_sessions as approved_session
      where approved_session.header_id = v_approved_header.id)
       is distinct from v_approved_header.expected_session_count then
    raise exception 'Approved multi-session manifest session-count guard failed.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('wave2b-multi:' || (p_manifest->>'idempotency_key'),0));
  if exists(
    select 1
    from workforce_internal.wave2b_multi_session_reconstructions as existing_reconstruction
    where existing_reconstruction.idempotency_key = p_manifest->>'idempotency_key'
       or (existing_reconstruction.period_id = v_period_id
           and existing_reconstruction.user_id = v_user_id
           and existing_reconstruction.work_date = v_work_date)
  ) then
    raise exception 'Multi-session reconstruction already exists.';
  end if;

  select ws.* into v_schedule
  from public.work_schedules as ws
  where ws.id = v_source_schedule_id
  for share;
  if not found
     or v_schedule.user_id is distinct from v_user_id
     or v_schedule.shift_date is distinct from v_work_date
     or v_schedule.schedule_version is distinct from v_schedule_version
     or v_schedule.status not in ('published','changed','completed')
     or v_schedule.is_leave or v_schedule.is_absent or v_schedule.is_holiday
     or (v_source_mode = 'rest_day' and (not v_schedule.is_rest_day or v_schedule.shift_start is not null or v_schedule.shift_end is not null))
     or (v_source_mode = 'timed_workday' and (v_schedule.is_rest_day or v_schedule.shift_start is null or v_schedule.shift_end is null or v_schedule.shift_end <= v_schedule.shift_start)) then
    raise exception 'Source schedule guard failed.';
  end if;
  if not exists(
    select 1 from public.payroll_periods as pp
    where pp.id = v_period_id and pp.status = 'draft'
      and v_work_date between pp.period_start and pp.period_end
  ) then
    raise exception 'Draft period/date guard failed.';
  end if;
  if not exists(
    select 1 from workforce_internal.wave2b_approved_source_evidence as source
    where source.period_id = v_period_id
      and v_work_date between source.period_start and source.period_end
      and source.source_type = p_manifest->>'source_type'
      and source.source_filename = p_manifest->>'source_filename'
      and source.source_sha256 = lower(p_manifest->>'source_sha256')
  ) then
    raise exception 'Approved source guard failed.';
  end if;
  if workforce_internal.wave2b_multi_session_pre_state(v_period_id,v_user_id,v_work_date,v_source_schedule_id) is distinct from p_manifest->'pre_state' then
    raise exception 'Pre-state fingerprint guard failed.';
  end if;
  if (select count(*) from public.payroll_records as payroll_record where payroll_record.payroll_period_id = v_period_id)
       is distinct from nullif(p_manifest #>> '{financial,payroll_record_count}','')::bigint
     or exists(select 1 from public.payroll_records as payroll_record where payroll_record.payroll_period_id = v_period_id and payroll_record.status <> 'draft')
     or exists(select 1 from public.payroll_items as payroll_item join public.payroll_records as payroll_record on payroll_record.id = payroll_item.payroll_record_id where payroll_record.payroll_period_id = v_period_id)
     or exists(select 1 from public.payroll_attendance_snapshots as attendance_snapshot join public.payroll_records as payroll_record on payroll_record.id = attendance_snapshot.payroll_record_id where payroll_record.payroll_period_id = v_period_id)
     or exists(select 1 from public.payroll_schedule_snapshots as schedule_snapshot join public.payroll_records as payroll_record on payroll_record.id = schedule_snapshot.payroll_record_id where payroll_record.payroll_period_id = v_period_id)
     or exists(select 1 from public.payroll_hour_allocations as allocation join public.payroll_records as payroll_record on payroll_record.id = allocation.destination_payroll_record_id where payroll_record.payroll_period_id = v_period_id)
     or exists(select 1 from public.payroll_prepaid_commitments as commitment where commitment.payroll_period_id = v_period_id) then
    raise exception 'Payroll artifact guard failed.';
  end if;
  if exists(
    select 1 from public.attendance as existing_attendance
    where existing_attendance.user_id = v_user_id
      and existing_attendance.work_date = v_work_date
      and existing_attendance.voided_at is null
  ) then
    raise exception 'Active attendance exists for this work date.';
  end if;
  if (select count(*) from public.attendance as voided_attendance
      where voided_attendance.user_id = v_user_id
        and voided_attendance.work_date = v_work_date
        and voided_attendance.voided_at is not null)
       is distinct from coalesce(nullif(p_manifest->>'expected_void_history_count','')::bigint,0) then
    raise exception 'Void history guard failed.';
  end if;

  for v_session in
    select session_row.*
    from jsonb_to_recordset(v_target_sessions) as session_row(
      session_sequence smallint,
      physical_schedule_id uuid,
      billed_clock_in timestamptz,
      billed_clock_out timestamptz,
      expected_billed_minutes integer
    )
    order by session_row.session_sequence
  loop
    v_seq := v_seq + 1;
    if v_session.session_sequence <> v_seq
       or v_session.billed_clock_in is null
       or v_session.billed_clock_out is null
       or v_session.billed_clock_out <= v_session.billed_clock_in then
      raise exception 'Session order/interval guard failed.';
    end if;
    v_duration := floor(extract(epoch from (v_session.billed_clock_out - v_session.billed_clock_in))/60)::integer;
    if v_duration <> v_session.expected_billed_minutes or v_session.expected_billed_minutes <= 0 then
      raise exception 'Session duration guard failed.';
    end if;
    select approved_session.* into v_approved_session
    from workforce_internal.wave2b_approved_multi_session_sessions as approved_session
    where approved_session.header_id = v_approved_header.id
      and approved_session.session_sequence = v_session.session_sequence
    for share;
    if not found
       or v_approved_session.billed_clock_in is distinct from v_session.billed_clock_in
       or v_approved_session.billed_clock_out is distinct from v_session.billed_clock_out
       or v_approved_session.duration_minutes is distinct from v_session.expected_billed_minutes then
      raise exception 'Approved multi-session session evidence guard failed.';
    end if;
    if v_previous_out is not null and v_session.billed_clock_in <= v_previous_out then
      raise exception 'Session overlap/order guard failed.';
    end if;
    if v_seq = 1 and v_session.physical_schedule_id is distinct from v_source_schedule_id then
      raise exception 'First session must retain source schedule linkage.';
    end if;
    if v_seq > 1 and v_session.physical_schedule_id is not null then
      raise exception 'Only the first session may retain physical schedule linkage.';
    end if;
    v_previous_out := v_session.billed_clock_out;
    v_total := v_total + v_duration;
  end loop;
  if v_seq <> v_expected_count or v_total <> v_expected_total then
    raise exception 'Session count/aggregate duration guard failed.';
  end if;

  insert into workforce_internal.wave2b_multi_session_reconstructions(
    period_id,user_id,work_date,source_schedule_id,source_schedule_version,source_schedule_mode,source_schedule_fingerprint,
    source_type,source_filename,source_sha256,source_sheet,source_row_reference,source_reference,expected_session_count,expected_total_minutes,pre_state_fingerprint,created_by,idempotency_key
  ) values(
    v_period_id,v_user_id,v_work_date,v_source_schedule_id,v_schedule_version,v_source_mode,
    jsonb_build_object('id',v_schedule.id,'user_id',v_schedule.user_id,'shift_date',v_schedule.shift_date,'schedule_version',v_schedule.schedule_version,'shift_start',v_schedule.shift_start,'shift_end',v_schedule.shift_end,'timezone',v_schedule.timezone,'status',v_schedule.status,'is_rest_day',v_schedule.is_rest_day,'is_holiday',v_schedule.is_holiday,'is_leave',v_schedule.is_leave,'is_absent',v_schedule.is_absent),
    p_manifest->>'source_type',p_manifest->>'source_filename',lower(p_manifest->>'source_sha256'),p_manifest->>'source_sheet',p_manifest->>'source_row_reference',p_manifest->>'source_reference',v_expected_count,v_expected_total,p_manifest->'pre_state',p_actor_user_id,p_manifest->>'idempotency_key'
  ) returning * into v_header;

  for v_session in
    select session_row.*
    from jsonb_to_recordset(v_target_sessions) as session_row(
      session_sequence smallint,
      physical_schedule_id uuid,
      billed_clock_in timestamptz,
      billed_clock_out timestamptz,
      expected_billed_minutes integer
    )
    order by session_row.session_sequence
  loop
    insert into public.attendance(
      user_id,schedule_id,work_date,clock_in,clock_out,original_clock_in,original_clock_out,
      billed_clock_in,billed_clock_out,attendance_status,is_corrected,correction_reason,corrected_by,corrected_at,created_by,updated_by,review_status,payroll_approved_at
    ) values(
      v_user_id,v_session.physical_schedule_id,v_work_date,null,null,null,null,
      v_session.billed_clock_in,v_session.billed_clock_out,'present',true,'Verified historical multi-session reconstruction',p_actor_user_id,clock_timestamp(),p_actor_user_id,p_actor_user_id,'corrected',null
    ) returning * into v_attendance;
    perform public.workforce_recalculate_attendance(v_attendance.id);
    select current_attendance.* into v_attendance
    from public.attendance as current_attendance
    where current_attendance.id = v_attendance.id;
    if v_attendance.clock_in is not null or v_attendance.clock_out is not null
       or v_attendance.original_clock_in is not null or v_attendance.original_clock_out is not null
       or v_attendance.billed_clock_in is distinct from v_session.billed_clock_in
       or v_attendance.billed_clock_out is distinct from v_session.billed_clock_out
       or public.workforce_canonical_billed_minutes(v_attendance.billed_clock_in,v_attendance.billed_clock_out) is distinct from v_session.expected_billed_minutes
       or v_attendance.total_worked_minutes is distinct from v_session.expected_billed_minutes
       or v_attendance.regular_minutes + v_attendance.total_overtime_minutes is distinct from v_session.expected_billed_minutes
       or v_attendance.total_overtime_minutes is distinct from (v_attendance.pre_shift_overtime_minutes + v_attendance.post_shift_overtime_minutes + v_attendance.rest_day_overtime_minutes + v_attendance.holiday_overtime_minutes) then
      raise exception 'Multi-session attendance postcondition failed.';
    end if;
    v_calc := jsonb_build_object('regular',v_attendance.regular_minutes,'pre_shift_overtime',v_attendance.pre_shift_overtime_minutes,'post_shift_overtime',v_attendance.post_shift_overtime_minutes,'rest_day_overtime',v_attendance.rest_day_overtime_minutes,'holiday_overtime',v_attendance.holiday_overtime_minutes,'total_overtime',v_attendance.total_overtime_minutes);
    insert into workforce_internal.wave2b_multi_session_evidence(
      reconstruction_id,session_sequence,source_schedule_id,physical_schedule_id,physical_schedule_linkage,target_billed_clock_in,target_billed_clock_out,expected_billed_minutes,attendance_id,attendance_version_after_reconstruction,canonical_minutes_fingerprint,stored_minutes_fingerprint,classification_fingerprint,state_fingerprint
    ) values(
      v_header.id,v_session.session_sequence,v_source_schedule_id,v_session.physical_schedule_id,case when v_session.physical_schedule_id is null then 'scheduleless' else 'source_schedule' end,v_session.billed_clock_in,v_session.billed_clock_out,v_session.expected_billed_minutes,v_attendance.id,v_attendance.attendance_version,public.workforce_canonical_billed_minutes(v_attendance.billed_clock_in,v_attendance.billed_clock_out),v_attendance.total_worked_minutes,v_calc,workforce_internal.attendance_state_fingerprint(v_attendance.id)
    );
  end loop;

  insert into public.workforce_audit_logs(actor_user_id,action,entity_type,entity_id,after_data,reason,metadata)
  values(p_actor_user_id,'wave2b_multi_session_reconstructed','wave2b_multi_session_reconstruction',v_header.id,jsonb_build_object('reconstruction_id',v_header.id,'session_count',v_expected_count,'total_minutes',v_expected_total),p_manifest->>'reason',jsonb_build_object('source_type',p_manifest->>'source_type','source_filename',p_manifest->>'source_filename','source_sha256',lower(p_manifest->>'source_sha256'),'source_reference',p_manifest->>'source_reference','raw_timestamps_intentionally_null',true));

  return query
  select v_header.id,e.session_sequence,e.attendance_id,a.billed_clock_in,a.billed_clock_out,public.workforce_canonical_billed_minutes(a.billed_clock_in,a.billed_clock_out),a.total_worked_minutes,a.regular_minutes,a.pre_shift_overtime_minutes,a.post_shift_overtime_minutes,a.rest_day_overtime_minutes,a.holiday_overtime_minutes,a.total_overtime_minutes,a.schedule_id,a.attendance_version,a.review_status,a.payroll_approved_at
  from workforce_internal.wave2b_multi_session_evidence as e
  join public.attendance as a on a.id=e.attendance_id
  where e.reconstruction_id=v_header.id
  order by e.session_sequence;
end;
$$;

revoke all on function public.workforce_wave2b_reconstruct_multi_session_attendance(jsonb,uuid) from public, anon, authenticated;
grant execute on function public.workforce_wave2b_reconstruct_multi_session_attendance(jsonb,uuid) to service_role;
comment on function public.workforce_wave2b_reconstruct_multi_session_attendance(jsonb,uuid) is 'Service-role-only, guarded Wave 2B historical multi-session reconstruction; infrastructure supports a separately authorized repair.';

commit;

;
