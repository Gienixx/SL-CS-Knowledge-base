-- Preflight for 2026070906_rest_day_holiday_overtime.sql.
--
-- The original structured-attendance constraint allowed rows with all three
-- structured components null even when total_overtime_minutes was nonzero.
-- Such overtime is unclassified and cannot satisfy the new RDOT/holiday-aware
-- totals constraint. This script preserves every affected row in the audit log
-- before resetting only the unclassified overtime totals.

begin;

create temporary table special_day_overtime_preflight_rows
on commit drop
as
select attendance_row.*
from public.attendance attendance_row
where attendance_row.pre_shift_overtime_minutes is null
  and attendance_row.regular_minutes is null
  and attendance_row.post_shift_overtime_minutes is null
  and (
    coalesce(attendance_row.total_overtime_minutes, 0) <> 0
    or coalesce(attendance_row.overtime_minutes, 0) <> 0
  );

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
from special_day_overtime_preflight_rows affected;

update public.attendance attendance_row
set total_overtime_minutes = 0,
    overtime_minutes = 0,
    updated_at = now()
where attendance_row.id in (
  select affected.id
  from special_day_overtime_preflight_rows affected
);

-- This must return zero rows before commit. Raising an exception rolls the
-- entire preflight back if any legacy unclassified overtime remains.
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

-- Report how many rows were normalized in the current database audit history.
select count(*) as normalized_rows
from public.workforce_audit_logs
where action = 'legacy_unclassified_overtime_normalized';
