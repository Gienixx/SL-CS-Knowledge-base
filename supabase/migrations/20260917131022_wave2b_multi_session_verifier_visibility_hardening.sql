-- Narrow forward hardening for the Wave 2B multi-session verifier.
-- No data rows are inserted or changed.
begin;

create or replace function workforce_internal.wave2b_multi_session_is_verified_attendance(p_attendance_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.attendance%rowtype;
  e workforce_internal.wave2b_multi_session_evidence%rowtype;
  h workforce_internal.wave2b_multi_session_reconstructions%rowtype;
  s public.work_schedules%rowtype;
  n bigint;
  visible boolean := false;
  current_schedule_fingerprint jsonb;
begin
  if p_attendance_id is null then return false; end if;
  select * into a from public.attendance where id = p_attendance_id;
  if not found or a.attendance_status <> 'present' or a.voided_at is not null
     or a.clock_in is not null or a.clock_out is not null
     or a.original_clock_in is not null or a.original_clock_out is not null then return false; end if;
  if session_user in ('postgres', 'service_role') or current_setting('request.jwt.claim.role', true) = 'service_role' then
    visible := true;
  else
    visible := public.workforce_is_current_identity(a.user_id)
      or public.workforce_can_view_user(a.user_id, 'view_team_attendance')
      or public.workforce_can_view_user(a.user_id, 'manage_schedules');
  end if;
  if not visible then return false; end if;
  select e0.* into e from workforce_internal.wave2b_multi_session_evidence e0 where e0.attendance_id = a.id;
  if not found then return false; end if;
  select h0.* into h from workforce_internal.wave2b_multi_session_reconstructions h0 where h0.id = e.reconstruction_id;
  if not found or h.reconstruction_state <> 'complete' then return false; end if;
  if a.user_id is distinct from h.user_id or a.work_date is distinct from h.work_date
     or e.source_schedule_id is distinct from h.source_schedule_id
     or a.schedule_id is distinct from e.physical_schedule_id
     or a.billed_clock_in is distinct from e.target_billed_clock_in
     or a.billed_clock_out is distinct from e.target_billed_clock_out
     or public.workforce_canonical_billed_minutes(a.billed_clock_in, a.billed_clock_out) is distinct from e.canonical_minutes_fingerprint
     or a.total_worked_minutes is distinct from e.stored_minutes_fingerprint then return false; end if;
  select * into s from public.work_schedules where id = h.source_schedule_id;
  if not found or s.user_id is distinct from h.user_id or s.shift_date is distinct from h.work_date
     or s.schedule_version is distinct from h.source_schedule_version then return false; end if;
  current_schedule_fingerprint := jsonb_build_object(
    'id',s.id,'user_id',s.user_id,'shift_date',s.shift_date,'schedule_version',s.schedule_version,
    'shift_start',s.shift_start,'shift_end',s.shift_end,'timezone',s.timezone,'status',s.status,
    'is_rest_day',s.is_rest_day,'is_holiday',s.is_holiday,'is_leave',s.is_leave,'is_absent',s.is_absent);
  if current_schedule_fingerprint is distinct from h.source_schedule_fingerprint then return false; end if;
  if e.physical_schedule_id is not null and e.physical_schedule_id is distinct from h.source_schedule_id then return false; end if;
  select count(*) into n from workforce_internal.wave2b_multi_session_evidence where reconstruction_id = h.id;
  if n <> h.expected_session_count then return false; end if;
  if exists (
    select 1 from workforce_internal.wave2b_multi_session_evidence x
    where x.reconstruction_id = h.id and x.target_billed_clock_out <= x.target_billed_clock_in
  ) then return false; end if;
  if exists (
    select 1 from workforce_internal.wave2b_multi_session_evidence x
    join workforce_internal.wave2b_multi_session_evidence y on y.reconstruction_id = x.reconstruction_id and y.session_sequence > x.session_sequence
    where x.reconstruction_id = h.id and y.target_billed_clock_in <= x.target_billed_clock_out
  ) then return false; end if;
  if exists (
    select 1 from public.attendance other_row
    where other_row.user_id = a.user_id and other_row.work_date = a.work_date and other_row.id <> a.id and other_row.voided_at is null
      and coalesce(other_row.billed_clock_in, other_row.clock_in) is not null and coalesce(other_row.billed_clock_out, other_row.clock_out) is not null
      and coalesce(other_row.billed_clock_in, other_row.clock_in) < e.target_billed_clock_out
      and e.target_billed_clock_in < coalesce(other_row.billed_clock_out, other_row.clock_out)
      and not exists (select 1 from workforce_internal.wave2b_multi_session_evidence z where z.reconstruction_id = h.id and z.attendance_id = other_row.id)
  ) then return false; end if;
  return exists (
    select 1 from workforce_internal.wave2b_approved_source_evidence source
    where source.period_id = h.period_id and source.source_type = h.source_type
      and source.source_filename = h.source_filename and source.source_sha256 = h.source_sha256
  ) and a.review_status in ('approved','locked') and a.payroll_approved_at is not null;
end;
$$;

revoke all on function workforce_internal.wave2b_multi_session_is_verified_attendance(uuid) from public, anon, authenticated;
grant execute on function workforce_internal.wave2b_multi_session_is_verified_attendance(uuid) to service_role;
commit;

;
