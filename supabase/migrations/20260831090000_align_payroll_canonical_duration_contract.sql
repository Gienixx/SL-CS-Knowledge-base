-- Keep readiness, approval, and the historical repair path on one canonical
-- billed-duration contract. This migration does not invoke the repair path.

begin;
create or replace function public.workforce_canonical_billed_minutes(
  p_effective_clock_in timestamptz,
  p_effective_clock_out timestamptz
)
returns integer
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when p_effective_clock_in is null
      or p_effective_clock_out is null
      or p_effective_clock_out < p_effective_clock_in
      then null::integer
    else floor(
      extract(epoch from (p_effective_clock_out - p_effective_clock_in)) / 60
    )::integer
  end;
$$;
revoke all on function public.workforce_canonical_billed_minutes(timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.workforce_canonical_billed_minutes(timestamptz, timestamptz)
  to authenticated, service_role;
-- Replace the inline duration expression in the already-deployed readiness
-- view. The guard intentionally checks the stored total directly: a matching
-- classification does not make a stale total safe for payroll import.
do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := pg_get_viewdef(
    'public.workforce_attendance_payroll_readiness'::regclass,
    true
  );

  v_updated := replace(
    v_definition,
    'floor(EXTRACT(epoch FROM COALESCE(attendance_row.billed_clock_out, attendance_row.clock_out) - COALESCE(attendance_row.billed_clock_in, attendance_row.clock_in)) / 60::numeric)::integer',
    'public.workforce_canonical_billed_minutes(COALESCE(attendance_row.billed_clock_in, attendance_row.clock_in), COALESCE(attendance_row.billed_clock_out, attendance_row.clock_out))'
  );

  if v_updated = v_definition
     or position('public.workforce_canonical_billed_minutes(' in v_updated) = 0 then
    raise exception 'Payroll readiness view did not expose its canonical duration expressions.';
  end if;

  execute 'create or replace view public.workforce_attendance_payroll_readiness with (security_invoker = true) as ' || v_updated;
end;
$$;
-- Patch only the canonical-duration assignment in the existing approval RPC;
-- all authorization, locking, audit, and status checks remain unchanged.
do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := pg_get_functiondef(
    'public.workforce_review_attendance(uuid,text,text)'::regprocedure
  );

  v_updated := replace(
    v_definition,
    $anchor$      v_canonical_billed_minutes := floor(
        extract(epoch from (v_effective_clock_out - v_effective_clock_in)) / 60
      )::integer;$anchor$,
    $replacement$      v_canonical_billed_minutes := public.workforce_canonical_billed_minutes(
        v_effective_clock_in,
        v_effective_clock_out
      );$replacement$
  );

  if v_updated = v_definition
     or position('public.workforce_canonical_billed_minutes(' in v_updated) = 0 then
    raise exception 'Attendance approval function did not expose its canonical duration assignment.';
  end if;

  execute v_updated;
end;
$$;
-- Service-only, explicit-ID remediation for the historical trigger cohort.
-- It is idempotent, refuses voided/approved/snapshotted rows, preserves the
-- existing billed classification, and never approves or imports attendance.
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

    v_after := public.workforce_recalculate_attendance(v_id);
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
