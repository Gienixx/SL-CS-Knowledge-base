-- Payroll readiness must validate the same effective timestamps and
-- classification totals used by attendance recalculation and payroll import.
-- This migration is intentionally read-only with respect to attendance data.

create or replace view public.workforce_attendance_payroll_readiness
with (security_invoker = true)
as
with evaluated as (
  select
    attendance_row.id,
    attendance_row.user_id,
    attendance_row.schedule_id,
    attendance_row.work_date,
    attendance_row.clock_in,
    attendance_row.clock_out,
    attendance_row.attendance_status,
    attendance_row.is_late,
    attendance_row.minutes_late,
    attendance_row.overtime_minutes,
    attendance_row.undertime_minutes,
    attendance_row.correction_reason,
    attendance_row.admin_notes,
    attendance_row.corrected_by,
    attendance_row.corrected_at,
    attendance_row.created_by,
    attendance_row.updated_by,
    attendance_row.created_at,
    attendance_row.updated_at,
    attendance_row.original_clock_in,
    attendance_row.original_clock_out,
    attendance_row.pre_shift_overtime_minutes,
    attendance_row.regular_minutes,
    attendance_row.post_shift_overtime_minutes,
    attendance_row.total_overtime_minutes,
    attendance_row.total_worked_minutes,
    attendance_row.is_corrected,
    attendance_row.review_status,
    attendance_row.reviewed_by,
    attendance_row.reviewed_at,
    attendance_row.rest_day_overtime_minutes,
    attendance_row.holiday_overtime_minutes,
    attendance_row.attendance_version,
    array_remove(array[
      case
        when attendance_row.clock_in is null then 'missing_clock_in'::text
        else null::text
      end,
      case
        when attendance_row.clock_out is null then 'missing_clock_out'::text
        else null::text
      end,
      case
        when attendance_row.clock_in is not null
         and attendance_row.clock_out is not null
         and attendance_row.clock_out < attendance_row.clock_in
          then 'invalid_clock_order'::text
        else null::text
      end,
      case
        when attendance_row.schedule_id is null then 'missing_schedule'::text
        else null::text
      end,
      case
        when attendance_row.schedule_id is not null and schedule_row.id is null
          then 'invalid_schedule'::text
        else null::text
      end,
      case
        when schedule_row.id is not null
         and schedule_row.user_id is distinct from attendance_row.user_id
          then 'schedule_employee_mismatch'::text
        else null::text
      end,
      case
        when schedule_row.id is not null
         and schedule_row.shift_date is distinct from attendance_row.work_date
         and not (
           schedule_row.shift_date = attendance_row.work_date - 1
           and schedule_row.shift_start is not null
           and schedule_row.shift_end is not null
           and schedule_row.shift_end > schedule_row.shift_start
           and (
             schedule_row.shift_end at time zone coalesce(nullif(schedule_row.timezone, ''), 'America/New_York')
           )::date > (
             schedule_row.shift_start at time zone coalesce(nullif(schedule_row.timezone, ''), 'America/New_York')
           )::date
         )
          then 'schedule_work_date_mismatch'::text
        else null::text
      end,
      case
        when schedule_row.id is not null
         and schedule_row.status <> all (array['published'::text, 'changed'::text, 'completed'::text])
          then 'invalid_schedule_status'::text
        else null::text
      end,
      case
        when schedule_row.id is not null
         and not schedule_row.is_rest_day
         and (
           (schedule_row.shift_start is null) <> (schedule_row.shift_end is null)
           or schedule_row.shift_start is not null
              and schedule_row.shift_end <= schedule_row.shift_start
         )
          then 'invalid_schedule_shift'::text
        else null::text
      end,
      case
        when schedule_row.id is not null
         and not schedule_row.is_rest_day
         and not schedule_row.is_holiday
         and schedule_row.shift_start is null
         and schedule_row.shift_end is null
         and (
           schedule_row.planned_paid_minutes is null
           or schedule_row.planned_paid_minutes < 15
           or schedule_row.planned_paid_minutes > 1440
         )
          then 'open_schedule_planned_time_missing'::text
        else null::text
      end,
      case
        when attendance_row.pre_shift_overtime_minutes is null
          or attendance_row.regular_minutes is null
          or attendance_row.post_shift_overtime_minutes is null
          then 'calculations_missing'::text
        else null::text
      end,
      case
        when coalesce(attendance_row.billed_clock_in, attendance_row.clock_in) is not null
         and coalesce(attendance_row.billed_clock_out, attendance_row.clock_out) is not null
         and attendance_row.total_worked_minutes is distinct from
           greatest(
             coalesce(attendance_row.regular_minutes, 0),
             0
           ) + greatest(coalesce(attendance_row.total_overtime_minutes, 0), 0)
         and (
           greatest(coalesce(attendance_row.regular_minutes, 0), 0)
           + greatest(coalesce(attendance_row.total_overtime_minutes, 0), 0)
         ) is distinct from floor(
           extract(
             epoch from (
               coalesce(attendance_row.billed_clock_out, attendance_row.clock_out)
               - coalesce(attendance_row.billed_clock_in, attendance_row.clock_in)
             )
           ) / 60::numeric
         )::integer
          then 'total_worked_mismatch'::text
        else null::text
      end,
      case
        when coalesce(attendance_row.billed_clock_out, attendance_row.clock_out) is not null
         and (
           greatest(coalesce(attendance_row.regular_minutes, 0), 0)
           + greatest(coalesce(attendance_row.total_overtime_minutes, 0), 0)
         ) is distinct from floor(
           extract(
             epoch from (
               coalesce(attendance_row.billed_clock_out, attendance_row.clock_out)
               - coalesce(attendance_row.billed_clock_in, attendance_row.clock_in)
             )
           ) / 60::numeric
         )::integer
          then 'worked_minutes_unclassified'::text
        else null::text
      end,
      case
        when attendance_row.pre_shift_overtime_minutes is not null
         and attendance_row.post_shift_overtime_minutes is not null
         and attendance_row.total_overtime_minutes is distinct from (
           attendance_row.pre_shift_overtime_minutes
           + attendance_row.post_shift_overtime_minutes
           + attendance_row.rest_day_overtime_minutes
           + attendance_row.holiday_overtime_minutes
         )
          then 'total_overtime_mismatch'::text
        else null::text
      end,
      case
        when attendance_row.total_overtime_minutes < 0
          or attendance_row.total_overtime_minutes > 1200
          then 'attendance_overtime_limit_exceeded'::text
        else null::text
      end,
      case
        when sum(attendance_row.total_overtime_minutes) over (
          partition by attendance_row.user_id, attendance_row.work_date
        ) > 1200
          then 'work_date_overtime_limit_exceeded'::text
        else null::text
      end,
      case
        when attendance_row.attendance_status <> all (array['present'::text, 'absent'::text, 'on_leave'::text, 'excused'::text])
          then 'invalid_attendance_status'::text
        else null::text
      end,
      case
        when attendance_row.review_status <> all (array['approved'::text, 'locked'::text])
          then 'review_required'::text
        else null::text
      end
    ], null::text) as payroll_readiness_blockers
  from public.attendance as attendance_row
  left join public.work_schedules as schedule_row
    on schedule_row.id = attendance_row.schedule_id
  where attendance_row.voided_at is null
)
select
  evaluated.id,
  evaluated.user_id,
  evaluated.schedule_id,
  evaluated.work_date,
  evaluated.clock_in,
  evaluated.clock_out,
  evaluated.attendance_status,
  evaluated.is_late,
  evaluated.minutes_late,
  evaluated.overtime_minutes,
  evaluated.undertime_minutes,
  evaluated.correction_reason,
  evaluated.admin_notes,
  evaluated.corrected_by,
  evaluated.corrected_at,
  evaluated.created_by,
  evaluated.updated_by,
  evaluated.created_at,
  evaluated.updated_at,
  evaluated.original_clock_in,
  evaluated.original_clock_out,
  evaluated.pre_shift_overtime_minutes,
  evaluated.regular_minutes,
  evaluated.post_shift_overtime_minutes,
  evaluated.total_overtime_minutes,
  evaluated.total_worked_minutes,
  evaluated.is_corrected,
  evaluated.review_status,
  evaluated.reviewed_by,
  evaluated.reviewed_at,
  evaluated.rest_day_overtime_minutes,
  evaluated.holiday_overtime_minutes,
  cardinality(evaluated.payroll_readiness_blockers) = 0 as is_payroll_ready,
  evaluated.payroll_readiness_blockers
from evaluated;

comment on view public.workforce_attendance_payroll_readiness is
  'Read-only payroll readiness using canonical billed attendance duration and valid overnight schedule linkage.';
