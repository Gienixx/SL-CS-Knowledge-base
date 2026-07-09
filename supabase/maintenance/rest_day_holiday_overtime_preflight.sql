-- Preflight for 2026070906_rest_day_holiday_overtime.sql.
--
-- The original structured-attendance constraint allowed rows with all three
-- structured components null even when total_overtime_minutes was nonzero.
-- Such overtime is unclassified and cannot satisfy the new RDOT/holiday-aware
-- totals constraint. This script preserves every affected row in the audit log
-- before resetting only the unclassified overtime totals.
--
-- This implementation intentionally uses one data-modifying CTE rather than a
-- temporary table so it works in SQL runners that execute statements through
-- transaction-pooler boundaries.

begin;

with affected as materialized (
  select attendance_row.*
  from public.attendance attendance_row
  where attendance_row.pre_shift_overtime_minutes is null
    and attendance_row.regular_minutes is null
    and attendance_row.post_shift_overtime_minutes is null
    and (
      coalesce(attendance_row.total_overtime_minutes, 0) <> 0
      or coalesce(attendance_row.overtime_minutes, 0) <> 0
    )
  for update
), audit_rows as (
  insert into public.workforce_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    before_data,
    after_data,
    reason
  )
  select
    auth.uid(),
    'legacy_unclassified_overtime_normalized',
    'attendance',
    affected.id,
    to_jsonb(affected),
    to_jsonb(affected) || jsonb_build_object(
      'total_overtime_minutes', 0,
      'overtime_minutes', 0
    ),
    'Normalized legacy unclassified overtime before enabling RDOT and holiday overtime'
  from affected
  returning entity_id
), updated_rows as (
  update public.attendance attendance_row
  set total_overtime_minutes = 0,
      overtime_minutes = 0,
      updated_at = now()
  from affected
  where attendance_row.id = affected.id
  returning attendance_row.id
)
select
  (select count(*) from affected) as affected_rows,
  (select count(*) from audit_rows) as audited_rows,
  (select count(*) from updated_rows) as normalized_rows;

-- Raising an exception rolls the transaction back if any incompatible legacy
-- overtime remains after the atomic normalization statement.
do $$
begin
  if exists (
    select 1
    from public.attendance attendance_row
    where attendance_row.pre_shift_overtime_minutes is null
      and attendance_row.regular_minutes is null
      and attendance_row.post_shift_overtime_minutes is null
      and (
        coalesce(attendance_row.total_overtime_minutes, 0) <> 0
        or coalesce(attendance_row.overtime_minutes, 0) <> 0
      )
  ) then
    raise exception 'Legacy unclassified overtime remains after normalization.';
  end if;
end
$$;

commit;

-- Idempotency note:
-- A successful rerun returns zero affected, audited, and normalized rows because
-- the incompatible overtime values were already cleared by the first run.
