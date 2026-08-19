-- Phase 1 Step 15: derive payroll readiness from trusted attendance state.
-- A security-invoker view preserves the attendance table's RLS and can enforce
-- the overtime ceiling across every record for an employee work date.

create or replace view public.workforce_attendance_payroll_readiness
with (security_invoker = true)
as
select
  attendance_row.*,
  (
    clock_in is not null
    and clock_out is not null
    and clock_out >= clock_in
    and schedule_id is not null
    and pre_shift_overtime_minutes is not null
    and regular_minutes is not null
    and post_shift_overtime_minutes is not null
    and total_worked_minutes >= 0
    and total_overtime_minutes >= 0
    and total_overtime_minutes <= 1200
    and total_overtime_minutes = (
      pre_shift_overtime_minutes
      + post_shift_overtime_minutes
      + rest_day_overtime_minutes
      + holiday_overtime_minutes
    )
    and attendance_status in ('present', 'absent', 'on_leave', 'excused')
    and review_status in ('approved', 'locked')
    and sum(total_overtime_minutes) over (
      partition by user_id, work_date
    ) <= 1200
  ) as is_payroll_ready
from public.attendance as attendance_row;

comment on view public.workforce_attendance_payroll_readiness is
  'RLS-preserving attendance projection with a payroll-readiness indicator that includes the aggregate 1,200-minute employee work-date overtime ceiling.';

revoke all on public.workforce_attendance_payroll_readiness from public;
revoke all on public.workforce_attendance_payroll_readiness from anon;
grant select on public.workforce_attendance_payroll_readiness to authenticated;
grant select on public.workforce_attendance_payroll_readiness to service_role;
