-- Scope the existing correction-recalculation trigger bypass to the trusted
-- historical repair recalculation only. This migration does not invoke repair.

begin;
create or replace function public.workforce_repair_billed_duration(
  p_attendance_ids uuid[],
  p_actor_user_id uuid,
  p_reason text
)
returns table (
  attendance_id uuid,
  repair_status text,
  previous_total_worked_minutes integer,
  canonical_billed_minutes integer,
  new_total_worked_minutes integer,
  previous_attendance_version bigint,
  new_attendance_version bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_before public.attendance%rowtype;
  v_after public.attendance%rowtype;
  v_canonical integer;
  v_previous_classified integer;
  v_new_classified integer;
  v_previous_correction_recalculation text;
begin
  if p_attendance_ids is null or cardinality(p_attendance_ids) = 0 then
    raise exception 'At least one explicit attendance ID is required.';
  end if;

  if p_actor_user_id is null
     or not exists (
       select 1
       from public.profiles as actor
       where actor.user_id = p_actor_user_id
         and actor.is_system_admin is true
         and actor.account_deleted_at is null
     ) then
    raise exception 'A non-deleted system administrator actor is required.';
  end if;

  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'A remediation reason is required.';
  end if;

  for v_id in
    select distinct candidate_id
    from unnest(p_attendance_ids) as candidate_id
  loop
    select attendance_row.*
    into v_before
    from public.attendance as attendance_row
    where attendance_row.id = v_id
    for update;

    if not found then
      raise exception 'Attendance record % was not found.', v_id;
    end if;

    if v_before.voided_at is not null then
      raise exception 'Attendance record % is voided.', v_id;
    end if;

    if v_before.review_status <> 'corrected' then
      raise exception 'Attendance record % is not in corrected review state.', v_id;
    end if;

    if v_before.payroll_approved_at is not null then
      raise exception 'Attendance record % already has payroll approval.', v_id;
    end if;

    if v_before.billed_clock_in is null
       or v_before.billed_clock_out is null
       or v_before.billed_clock_out < v_before.billed_clock_in then
      raise exception 'Attendance record % does not have valid billed timestamps.', v_id;
    end if;

    if exists (
      select 1
      from public.payroll_attendance_snapshots as snapshot
      where snapshot.attendance_id = v_id
    ) then
      raise exception 'Attendance record % already has a payroll snapshot.', v_id;
    end if;

    v_canonical := public.workforce_canonical_billed_minutes(
      v_before.billed_clock_in,
      v_before.billed_clock_out
    );
    v_previous_classified := coalesce(v_before.regular_minutes, 0)
      + coalesce(v_before.total_overtime_minutes, 0);

    if v_previous_classified is distinct from v_canonical then
      raise exception 'Attendance record % has a classification mismatch and requires review.', v_id;
    end if;

    if v_before.total_worked_minutes is not distinct from v_canonical then
      return query
      select
        v_id,
        'already_canonical'::text,
        v_before.total_worked_minutes,
        v_canonical,
        v_before.total_worked_minutes,
        v_before.attendance_version::bigint,
        v_before.attendance_version::bigint;
      continue;
    end if;

    v_previous_correction_recalculation := current_setting(
      'workforce.correction_recalculation',
      true
    );
    perform set_config('workforce.correction_recalculation', 'true', true);
    begin
      v_after := public.workforce_recalculate_attendance(v_id);
    exception when others then
      perform set_config(
        'workforce.correction_recalculation',
        coalesce(v_previous_correction_recalculation, 'false'),
        true
      );
      raise;
    end;
    perform set_config(
      'workforce.correction_recalculation',
      coalesce(v_previous_correction_recalculation, 'false'),
      true
    );

    v_new_classified := coalesce(v_after.regular_minutes, 0)
      + coalesce(v_after.total_overtime_minutes, 0);

    if v_after.total_worked_minutes is distinct from v_canonical
       or v_new_classified is distinct from v_previous_classified
       or v_after.pre_shift_overtime_minutes is distinct from v_before.pre_shift_overtime_minutes
       or v_after.post_shift_overtime_minutes is distinct from v_before.post_shift_overtime_minutes
       or v_after.rest_day_overtime_minutes is distinct from v_before.rest_day_overtime_minutes
       or v_after.holiday_overtime_minutes is distinct from v_before.holiday_overtime_minutes
       or v_after.total_overtime_minutes is distinct from v_before.total_overtime_minutes then
      raise exception 'Attendance record % recalculation changed more than the stale total.', v_id;
    end if;

    insert into public.workforce_audit_logs (
      actor_user_id,
      action,
      entity_type,
      entity_id,
      before_data,
      after_data,
      reason
    ) values (
      p_actor_user_id,
      'attendance_canonical_duration_repaired',
      'attendance',
      v_after.id,
      jsonb_build_object(
        'attendance_id', v_before.id,
        'attendance_version', v_before.attendance_version,
        'total_worked_minutes', v_before.total_worked_minutes,
        'canonical_billed_minutes', v_canonical,
        'review_status', v_before.review_status,
        'payroll_snapshot_exists', false
      ),
      jsonb_build_object(
        'attendance_id', v_after.id,
        'attendance_version', v_after.attendance_version,
        'total_worked_minutes', v_after.total_worked_minutes,
        'canonical_billed_minutes', v_canonical,
        'review_status', v_after.review_status,
        'payroll_snapshot_exists', false
      ),
      trim(p_reason)
    );

    return query
    select
      v_id,
      'repaired'::text,
      v_before.total_worked_minutes,
      v_canonical,
      v_after.total_worked_minutes,
      v_before.attendance_version::bigint,
      v_after.attendance_version::bigint;
  end loop;
end;
$$;
revoke all on function public.workforce_repair_billed_duration(uuid[], uuid, text)
  from public, anon, authenticated;
grant execute on function public.workforce_repair_billed_duration(uuid[], uuid, text)
  to service_role;
comment on function public.workforce_repair_billed_duration(uuid[], uuid, text) is
  'Explicit-ID, idempotent, audited repair for corrected billed-duration rows without payroll snapshots; never approves or imports attendance.';
commit;
