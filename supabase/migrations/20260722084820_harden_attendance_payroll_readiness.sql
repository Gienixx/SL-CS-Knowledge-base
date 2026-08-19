-- Phase 1 Step 15: expose a trusted, self-updating payroll-readiness
-- indicator and the exact reasons that block a record from payroll.

create or replace view public.workforce_attendance_payroll_readiness
with (security_invoker = true)
as
with evaluated as (
  select
    attendance_row.*,
    array_remove(array[
      case when attendance_row.clock_in is null then 'missing_clock_in' end,
      case when attendance_row.clock_out is null then 'missing_clock_out' end,
      case
        when attendance_row.clock_in is not null
         and attendance_row.clock_out is not null
         and attendance_row.clock_out < attendance_row.clock_in
        then 'invalid_clock_order'
      end,
      case when attendance_row.schedule_id is null then 'missing_schedule' end,
      case
        when attendance_row.schedule_id is not null and schedule_row.id is null
        then 'invalid_schedule'
      end,
      case
        when schedule_row.id is not null
         and schedule_row.user_id is distinct from attendance_row.user_id
        then 'schedule_employee_mismatch'
      end,
      case
        when schedule_row.id is not null
         and schedule_row.shift_date is distinct from attendance_row.work_date
        then 'schedule_work_date_mismatch'
      end,
      case
        when schedule_row.id is not null
         and schedule_row.status not in ('published', 'changed', 'completed')
        then 'invalid_schedule_status'
      end,
      case
        when schedule_row.id is not null
         and not schedule_row.is_rest_day
         and (
           schedule_row.shift_start is null
           or schedule_row.shift_end is null
           or schedule_row.shift_end <= schedule_row.shift_start
         )
        then 'invalid_schedule_shift'
      end,
      case
        when attendance_row.pre_shift_overtime_minutes is null
          or attendance_row.regular_minutes is null
          or attendance_row.post_shift_overtime_minutes is null
        then 'calculations_missing'
      end,
      case
        when attendance_row.clock_in is not null
         and attendance_row.clock_out is not null
         and attendance_row.total_worked_minutes is distinct from greatest(
           0,
           floor(extract(epoch from (attendance_row.clock_out - attendance_row.clock_in)) / 60)::integer
         )
        then 'total_worked_mismatch'
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
        then 'total_overtime_mismatch'
      end,
      case
        when attendance_row.total_overtime_minutes < 0
          or attendance_row.total_overtime_minutes > 1200
        then 'attendance_overtime_limit_exceeded'
      end,
      case
        when sum(attendance_row.total_overtime_minutes) over (
          partition by attendance_row.user_id, attendance_row.work_date
        ) > 1200
        then 'work_date_overtime_limit_exceeded'
      end,
      case
        when attendance_row.attendance_status not in ('present', 'absent', 'on_leave', 'excused')
        then 'invalid_attendance_status'
      end,
      case
        when attendance_row.review_status not in ('approved', 'locked')
        then 'review_required'
      end
    ], null)::text[] as payroll_readiness_blockers
  from public.attendance attendance_row
  left join public.work_schedules schedule_row
    on schedule_row.id = attendance_row.schedule_id
)
select
  id,
  user_id,
  schedule_id,
  work_date,
  clock_in,
  clock_out,
  attendance_status,
  is_late,
  minutes_late,
  overtime_minutes,
  undertime_minutes,
  correction_reason,
  admin_notes,
  corrected_by,
  corrected_at,
  created_by,
  updated_by,
  created_at,
  updated_at,
  original_clock_in,
  original_clock_out,
  pre_shift_overtime_minutes,
  regular_minutes,
  post_shift_overtime_minutes,
  total_overtime_minutes,
  total_worked_minutes,
  is_corrected,
  review_status,
  reviewed_by,
  reviewed_at,
  rest_day_overtime_minutes,
  holiday_overtime_minutes,
  cardinality(payroll_readiness_blockers) = 0 as is_payroll_ready,
  payroll_readiness_blockers
from evaluated;

comment on view public.workforce_attendance_payroll_readiness is
  'Phase 1 Step 15 payroll-readiness projection. The boolean and blocker codes are derived from current attendance, schedule, calculation, overtime, and review state.';

revoke all on public.workforce_attendance_payroll_readiness from public, anon;
grant select on public.workforce_attendance_payroll_readiness to authenticated, service_role;
