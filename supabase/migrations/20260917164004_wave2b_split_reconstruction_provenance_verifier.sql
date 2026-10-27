-- Split Wave 2B reconstructed-attendance provenance from post-approval
-- readiness.  This is lifecycle wiring only: it does not create attendance,
-- calculate payroll, or change payroll/prepaid state.
begin;

create or replace function workforce_internal.wave2b_multi_session_has_valid_provenance(
  p_attendance_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attendance public.attendance%rowtype;
  v_evidence workforce_internal.wave2b_multi_session_evidence%rowtype;
  v_header workforce_internal.wave2b_multi_session_reconstructions%rowtype;
  v_schedule public.work_schedules%rowtype;
  v_evidence_count bigint;
  v_evidence_minutes bigint;
  v_visible boolean := false;
begin
  if p_attendance_id is null then return false; end if;

  select a.* into v_attendance from public.attendance a where a.id = p_attendance_id;
  if not found or v_attendance.attendance_status <> 'present'
     or v_attendance.voided_at is not null
     or v_attendance.clock_in is not null or v_attendance.clock_out is not null
     or v_attendance.original_clock_in is not null
     or v_attendance.original_clock_out is not null then return false; end if;

  if session_user in ('postgres', 'service_role')
     or current_setting('request.jwt.claim.role', true) = 'service_role' then
    v_visible := true;
  else
    v_visible := public.workforce_is_current_identity(v_attendance.user_id)
      or public.workforce_can_view_user(v_attendance.user_id, 'view_team_attendance')
      or public.workforce_can_view_user(v_attendance.user_id, 'manage_schedules');
  end if;
  if not v_visible then return false; end if;

  select e.* into v_evidence
  from workforce_internal.wave2b_multi_session_evidence e
  where e.attendance_id = p_attendance_id;
  if not found then return false; end if;
  select h.* into v_header
  from workforce_internal.wave2b_multi_session_reconstructions h
  where h.id = v_evidence.reconstruction_id;
  if not found or v_header.reconstruction_state <> 'complete' then return false; end if;

  if v_attendance.user_id is distinct from v_header.user_id
     or v_attendance.work_date is distinct from v_header.work_date
     or v_evidence.source_schedule_id is distinct from v_header.source_schedule_id
     or v_attendance.schedule_id is distinct from v_evidence.physical_schedule_id
     or v_attendance.billed_clock_in is distinct from v_evidence.target_billed_clock_in
     or v_attendance.billed_clock_out is distinct from v_evidence.target_billed_clock_out
     or public.workforce_canonical_billed_minutes(v_attendance.billed_clock_in, v_attendance.billed_clock_out)
          is distinct from v_evidence.canonical_minutes_fingerprint
     or v_attendance.total_worked_minutes is distinct from v_evidence.stored_minutes_fingerprint
     or v_attendance.pre_shift_overtime_minutes is distinct from (v_evidence.classification_fingerprint->>'pre_shift_overtime')::integer
     or v_attendance.regular_minutes is distinct from (v_evidence.classification_fingerprint->>'regular')::integer
     or v_attendance.post_shift_overtime_minutes is distinct from (v_evidence.classification_fingerprint->>'post_shift_overtime')::integer
     or v_attendance.rest_day_overtime_minutes is distinct from (v_evidence.classification_fingerprint->>'rest_day_overtime')::integer
     or v_attendance.holiday_overtime_minutes is distinct from (v_evidence.classification_fingerprint->>'holiday_overtime')::integer
     or v_attendance.total_overtime_minutes is distinct from (v_evidence.classification_fingerprint->>'total_overtime')::integer
     or v_attendance.attendance_version < v_evidence.attendance_version_after_reconstruction then return false; end if;

  select * into v_schedule from public.work_schedules s where s.id = v_header.source_schedule_id;
  if not found or v_schedule.user_id is distinct from v_header.user_id
     or v_schedule.shift_date is distinct from v_header.work_date
     or v_schedule.schedule_version is distinct from v_header.source_schedule_version then return false; end if;
  if v_evidence.physical_schedule_id is not null
     and v_evidence.physical_schedule_id is distinct from v_header.source_schedule_id then return false; end if;

  select count(*) into v_evidence_count from workforce_internal.wave2b_multi_session_evidence e where e.reconstruction_id = v_header.id;
  select coalesce(sum(e.expected_billed_minutes), 0) into v_evidence_minutes from workforce_internal.wave2b_multi_session_evidence e where e.reconstruction_id = v_header.id;
  if v_evidence_count <> v_header.expected_session_count or v_evidence_minutes <> v_header.expected_total_minutes then return false; end if;
  if exists (select 1 from workforce_internal.wave2b_multi_session_evidence x where x.reconstruction_id = v_header.id and (x.target_billed_clock_out <= x.target_billed_clock_in or x.expected_billed_minutes <> floor(extract(epoch from (x.target_billed_clock_out-x.target_billed_clock_in))/60)::integer)) then return false; end if;
  if exists (select 1 from workforce_internal.wave2b_multi_session_evidence x join workforce_internal.wave2b_multi_session_evidence y on y.reconstruction_id=x.reconstruction_id and y.session_sequence>x.session_sequence where x.reconstruction_id=v_header.id and y.target_billed_clock_in<=x.target_billed_clock_out) then return false; end if;
  if exists (
    select 1 from public.attendance other_row
    where other_row.user_id=v_attendance.user_id and other_row.work_date=v_attendance.work_date
      and other_row.id<>v_attendance.id and other_row.voided_at is null
      and coalesce(other_row.billed_clock_in,other_row.clock_in) is not null
      and coalesce(other_row.billed_clock_out,other_row.clock_out) is not null
      and coalesce(other_row.billed_clock_in,other_row.clock_in)<v_evidence.target_billed_clock_out
      and v_evidence.target_billed_clock_in<coalesce(other_row.billed_clock_out,other_row.clock_out)
      and not exists (select 1 from workforce_internal.wave2b_multi_session_evidence z where z.reconstruction_id=v_header.id and z.attendance_id=other_row.id)
  ) then return false; end if;

  return exists (select 1 from workforce_internal.wave2b_approved_source_evidence source
    where source.period_id=v_header.period_id and source.source_type=v_header.source_type
      and source.source_filename=v_header.source_filename and source.source_sha256=v_header.source_sha256);
exception when others then return false;
end;
$$;

revoke all on function workforce_internal.wave2b_multi_session_has_valid_provenance(uuid) from public, anon, authenticated;
grant execute on function workforce_internal.wave2b_multi_session_has_valid_provenance(uuid) to service_role;

create or replace function public.workforce_is_valid_reconstructed_attendance(p_attendance_id uuid)
returns boolean language sql security definer set search_path = '' as $$
  select workforce_internal.wave2b_single_session_is_verified_attendance(p_attendance_id)
      or workforce_internal.wave2b_multi_session_has_valid_provenance(p_attendance_id);
$$;
revoke all on function public.workforce_is_valid_reconstructed_attendance(uuid) from public, anon;
grant execute on function public.workforce_is_valid_reconstructed_attendance(uuid) to authenticated, service_role;

do $$
declare v_definition text := replace(pg_get_functiondef('public.workforce_review_attendance(uuid,text,text)'::regprocedure), chr(13), '');
begin
  if position('public.workforce_is_valid_reconstructed_attendance' in v_definition)>0 then return; end if;
  if position('public.workforce_is_verified_reconstructed_attendance' in v_definition)=0 then raise exception 'Approval verifier anchor was not found.'; end if;
  v_definition := replace(v_definition, 'public.workforce_is_verified_reconstructed_attendance', 'public.workforce_is_valid_reconstructed_attendance');
  if position('public.workforce_is_valid_reconstructed_attendance' in v_definition)=0 or position('public.workforce_is_verified_reconstructed_attendance' in v_definition)>0 then raise exception 'Approval verifier split was not installed.'; end if;
  execute v_definition;
end;
$$;

create or replace function workforce_internal.wave2b_multi_session_is_ready(p_reconstruction_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from workforce_internal.wave2b_multi_session_reconstructions h
    where h.id=p_reconstruction_id
      and (select count(*) from workforce_internal.wave2b_multi_session_evidence e where e.reconstruction_id=h.id)=h.expected_session_count
      and not exists (select 1 from workforce_internal.wave2b_multi_session_evidence e join public.attendance a on a.id=e.attendance_id where e.reconstruction_id=h.id and (a.review_status not in ('approved','locked') or a.payroll_approved_at is null or not public.workforce_is_verified_reconstructed_attendance(a.id)))
      and not exists (select 1 from workforce_internal.wave2b_multi_session_evidence e join public.workforce_attendance_payroll_readiness r on r.id=e.attendance_id where e.reconstruction_id=h.id and exists (select 1 from unnest(coalesce(r.payroll_readiness_blockers,'{}'::text[])) b where b<>'missing_schedule'))
  );
$$;
revoke all on function workforce_internal.wave2b_multi_session_is_ready(uuid) from public, anon, authenticated;
grant execute on function workforce_internal.wave2b_multi_session_is_ready(uuid) to service_role;

comment on function workforce_internal.wave2b_multi_session_has_valid_provenance(uuid) is 'Pre-approval immutable multi-session provenance verifier; intentionally excludes review/payroll lifecycle state.';
comment on function public.workforce_is_valid_reconstructed_attendance(uuid) is 'Pre-approval provenance validity for single- and multi-session Wave 2B reconstructed attendance.';
commit;

;
