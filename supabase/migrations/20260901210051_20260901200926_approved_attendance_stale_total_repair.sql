-- Repair only the derived canonical total on approved, unimported attendance.
-- This intentionally does not call the normal correction or recalculation
-- workflows, either of which would reopen approval for a payroll calculation
-- change.

begin;

create or replace function public.workforce_repair_approved_stale_total(
  p_attendance_id uuid,
  p_actor_user_id uuid,
  p_reason text,
  p_expected_total_worked_minutes integer,
  p_expected_attendance_version bigint
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
  v_before public.attendance%rowtype;
  v_after public.attendance%rowtype;
  v_canonical integer;
  v_classified integer;
  v_component_total integer;
  v_previous_correction_recalculation text;
  v_update_succeeded boolean := false;
begin
  if p_attendance_id is null then
    raise exception 'Exactly one explicit attendance ID is required.';
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

  if p_expected_total_worked_minutes is null
     or p_expected_attendance_version is null
     or p_expected_attendance_version <= 0 then
    raise exception 'Expected current attendance values are required.';
  end if;

  select attendance_row.*
  into v_before
  from public.attendance as attendance_row
  where attendance_row.id = p_attendance_id
  for update;

  if not found then
    raise exception 'Attendance record % was not found.', p_attendance_id;
  end if;

  if v_before.voided_at is not null then
    raise exception 'Attendance record % is voided.', p_attendance_id;
  end if;

  if v_before.review_status = 'locked' then
    raise exception 'Locked attendance cannot be changed.';
  end if;

  if v_before.review_status <> 'approved' then
    raise exception 'Attendance record % is not approved.', p_attendance_id;
  end if;

  if v_before.payroll_approved_at is null then
    raise exception 'Approved attendance record % has no payroll approval marker.', p_attendance_id;
  end if;

  if v_before.total_worked_minutes is distinct from p_expected_total_worked_minutes
     or v_before.attendance_version is distinct from p_expected_attendance_version then
    raise exception 'Attendance record % no longer matches the expected current values.', p_attendance_id;
  end if;

  if v_before.billed_clock_in is null
     or v_before.billed_clock_out is null
     or v_before.billed_clock_out < v_before.billed_clock_in then
    raise exception 'Attendance record % does not have valid billed timestamps.', p_attendance_id;
  end if;

  if exists (
    select 1
    from public.payroll_attendance_snapshots as snapshot
    where snapshot.attendance_id = p_attendance_id
  ) then
    raise exception 'Attendance record % already has a payroll snapshot.', p_attendance_id;
  end if;

  if exists (
    select 1
    from public.payroll_items as item
    join public.payroll_attendance_snapshots as snapshot
      on snapshot.id = item.source_attendance_snapshot_id
    where snapshot.attendance_id = p_attendance_id
  ) then
    raise exception 'Attendance record % already has a payroll item.', p_attendance_id;
  end if;

  if exists (
    select 1
    from public.payroll_hour_allocations as allocation
    join public.payroll_attendance_snapshots as snapshot
      on snapshot.id = allocation.attendance_snapshot_id
    where snapshot.attendance_id = p_attendance_id
  ) then
    raise exception 'Attendance record % already has a payroll hour allocation.', p_attendance_id;
  end if;

  if exists (
    select 1
    from public.attendance as other
    where other.id <> p_attendance_id
      and other.user_id = v_before.user_id
      and other.work_date = v_before.work_date
      and other.voided_at is null
      and (
        (
          other.clock_in is not null
          and other.clock_out is not null
          and v_before.clock_in is not null
          and v_before.clock_out is not null
          and v_before.clock_in < other.clock_out
          and v_before.clock_out > other.clock_in
        )
        or (
          other.billed_clock_in is not null
          and other.billed_clock_out is not null
          and v_before.billed_clock_in < other.billed_clock_out
          and v_before.billed_clock_out > other.billed_clock_in
        )
        or (
          other.clock_in is not distinct from v_before.clock_in
          and other.clock_out is not distinct from v_before.clock_out
        )
        or (
          other.billed_clock_in is not distinct from v_before.billed_clock_in
          and other.billed_clock_out is not distinct from v_before.billed_clock_out
        )
      )
  ) then
    raise exception 'Attendance record % has a duplicate or overlapping attendance record.', p_attendance_id;
  end if;

  v_canonical := public.workforce_canonical_billed_minutes(
    v_before.billed_clock_in,
    v_before.billed_clock_out
  );

  if v_before.pre_shift_overtime_minutes is null
     or v_before.regular_minutes is null
     or v_before.post_shift_overtime_minutes is null
     or v_before.rest_day_overtime_minutes is null
     or v_before.holiday_overtime_minutes is null
     or v_before.total_overtime_minutes is null
     or v_before.overtime_minutes is null then
    raise exception 'Attendance record % has incomplete structured calculations.', p_attendance_id;
  end if;

  v_component_total := v_before.pre_shift_overtime_minutes
    + v_before.post_shift_overtime_minutes
    + v_before.rest_day_overtime_minutes
    + v_before.holiday_overtime_minutes;
  v_classified := v_before.regular_minutes + v_before.total_overtime_minutes;

  if v_before.total_overtime_minutes is distinct from v_component_total
     or v_before.overtime_minutes is distinct from v_before.total_overtime_minutes then
    raise exception 'Attendance record % has an OT component mismatch.', p_attendance_id;
  end if;

  if v_classified is distinct from v_canonical then
    raise exception 'Attendance record % has a classification mismatch and requires review.', p_attendance_id;
  end if;

  if v_before.total_worked_minutes is not distinct from v_canonical then
    return query
    select
      p_attendance_id,
      'already_canonical'::text,
      v_before.total_worked_minutes,
      v_canonical,
      v_before.total_worked_minutes,
      v_before.attendance_version,
      v_before.attendance_version;
    return;
  end if;

  if not exists (
    select 1
    from public.workforce_attendance_payroll_readiness as readiness
    where readiness.id = p_attendance_id
      and cardinality(readiness.payroll_readiness_blockers) = 1
      and readiness.payroll_readiness_blockers[1] = 'total_worked_mismatch'
  ) then
    raise exception 'Attendance record % has readiness blockers beyond the stale total.', p_attendance_id;
  end if;

  -- The storage trigger otherwise derives total_worked_minutes from raw
  -- timestamps. This scoped setting permits the one canonical derived-field
  -- correction without invoking the normal attendance recalculation workflow.
  v_previous_correction_recalculation := current_setting(
    'workforce.correction_recalculation',
    true
  );
  perform set_config('workforce.correction_recalculation', 'true', true);
  begin
    update public.attendance
    set total_worked_minutes = v_canonical
    where id = v_before.id
      and total_worked_minutes = p_expected_total_worked_minutes
      and attendance_version = p_expected_attendance_version
    returning * into v_after;
    v_update_succeeded := found;
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

  if not v_update_succeeded then
    raise exception 'Attendance record % changed while the repair was running.', p_attendance_id;
  end if;

  if v_after.total_worked_minutes is distinct from v_canonical
     or v_after.attendance_version is distinct from v_before.attendance_version + 1
     or (to_jsonb(v_after) - array['total_worked_minutes', 'attendance_version', 'updated_at'])
          is distinct from (to_jsonb(v_before) - array['total_worked_minutes', 'attendance_version', 'updated_at']) then
    raise exception 'Attendance record % repair changed more than the stale total.', p_attendance_id;
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
    'attendance_approved_canonical_duration_repaired',
    'attendance',
    v_after.id,
    jsonb_build_object(
      'attendance_id', v_before.id,
      'attendance_version', v_before.attendance_version,
      'total_worked_minutes', v_before.total_worked_minutes,
      'canonical_billed_minutes', v_canonical,
      'review_status', v_before.review_status,
      'payroll_approved_at', v_before.payroll_approved_at,
      'payroll_snapshot_exists', false,
      'payroll_item_exists', false,
      'payroll_hour_allocation_exists', false
    ),
    jsonb_build_object(
      'attendance_id', v_after.id,
      'attendance_version', v_after.attendance_version,
      'total_worked_minutes', v_after.total_worked_minutes,
      'canonical_billed_minutes', v_canonical,
      'review_status', v_after.review_status,
      'payroll_approved_at', v_after.payroll_approved_at,
      'payroll_snapshot_exists', false,
      'payroll_item_exists', false,
      'payroll_hour_allocation_exists', false
    ),
    trim(p_reason)
  );

  return query
  select
    p_attendance_id,
    'repaired'::text,
    v_before.total_worked_minutes,
    v_canonical,
    v_after.total_worked_minutes,
    v_before.attendance_version,
    v_after.attendance_version;
end;
$$;

revoke all on function public.workforce_repair_approved_stale_total(
  uuid, uuid, text, integer, bigint
) from public, anon, authenticated;
grant execute on function public.workforce_repair_approved_stale_total(
  uuid, uuid, text, integer, bigint
) to service_role;

comment on function public.workforce_repair_approved_stale_total(
  uuid, uuid, text, integer, bigint
) is
  'Explicit-ID, service-only, audited repair of total_worked_minutes on approved attendance with no payroll artifacts; preserves approval and all attendance inputs.';

commit;

;
