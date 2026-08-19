import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync(
  new URL('../supabase/reconciliation-archive/pre-canonical-migrations-20260819/live-production-definitions-20260819.sql', import.meta.url),
  'utf8'
)

const currentFlagFunction = migration.match(/-- signature: workforce_flag_current_open_attendance_over_duration\(\)[\s\S]*?(?=-- LIVE PRODUCTION SNAPSHOT|$)/)?.[0] || ''
const managerFlagFunction = migration.match(/-- signature: workforce_flag_open_attendance_over_duration\(\)[\s\S]*?(?=-- LIVE PRODUCTION SNAPSHOT|$)/)?.[0] || ''
const teamAttendanceFunction = migration.match(/-- signature: workforce_list_team_attendance\(date,date\)[\s\S]*?(?=-- LIVE PRODUCTION SNAPSHOT|$)/)?.[0] || ''
const attendanceReviewFunctions = `${currentFlagFunction}\n${managerFlagFunction}\n${teamAttendanceFunction}`

const liveTeamAttendanceColumns = [
  'attendance_id uuid', 'employee_user_id uuid', 'employee_name text',
  'employee_email text', 'employee_id text', 'employee_timezone text',
  'team_id uuid', 'team_name text', 'work_date date', 'schedule_id uuid',
  'shift_sequence smallint', 'scheduled_start timestamp with time zone', 'scheduled_end timestamp with time zone',
  'schedule_timezone text', 'schedule_status text', 'clock_in timestamp with time zone',
  'clock_out timestamp with time zone', 'original_clock_in timestamp with time zone',
  'original_clock_out timestamp with time zone', 'billed_clock_in timestamp with time zone',
  'billed_clock_out timestamp with time zone', 'regular_minutes integer',
  'pre_shift_overtime_minutes integer', 'post_shift_overtime_minutes integer',
  'total_overtime_minutes integer', 'total_worked_minutes integer',
  'minutes_late integer', 'undertime_minutes integer', 'attendance_status text',
  'is_corrected boolean', 'review_status text', 'corrected_by uuid',
  'corrected_by_name text', 'corrected_at timestamp with time zone', 'correction_reason text',
  'admin_notes text', 'is_open boolean', 'is_missing_clock_out boolean'
]

test('production-forward migration targets the live Team Attendance RPC shape', () => {
  assert.ok(teamAttendanceFunction)
  for (const column of liveTeamAttendanceColumns) {
    assert.match(teamAttendanceFunction, new RegExp(column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.match(attendanceReviewFunctions, /manager_review_reason text/)
  assert.match(attendanceReviewFunctions, /v_now timestamptz := statement_timestamp\(\)/)
  assert.match(attendanceReviewFunctions, /manager_review_reason = 'open_session_over_20_hours'/)
  assert.match(attendanceReviewFunctions, /language plpgsql\s+stable\s+security definer/i)
})

test('production-forward migration preserves existing Attendance RPCs and adds only the new flag RPC', () => {
  assert.doesNotMatch(attendanceReviewFunctions, /create or replace function public\.workforce_clock_in\(/i)
  assert.doesNotMatch(attendanceReviewFunctions, /create or replace function public\.workforce_clock_out\(/i)
  assert.doesNotMatch(attendanceReviewFunctions, /create or replace function public\.workforce_recalculate_attendance\(/i)
  assert.doesNotMatch(attendanceReviewFunctions, /create or replace function public\.workforce_review_attendance\(/i)
  assert.match(currentFlagFunction, /signature: workforce_flag_current_open_attendance_over_duration\(\)/)
  assert.match(managerFlagFunction, /signature: workforce_flag_open_attendance_over_duration\(\)/)
  assert.match(managerFlagFunction, /workforce_has_permission\('view_team_attendance'\)/)
  assert.match(managerFlagFunction, /returns integer[\s\S]*?get diagnostics v_flagged_count = row_count/i)
})

test('manager sweep is permission-gated and cannot target arbitrary attendance ids', () => {
  const managerFunction = managerFlagFunction

  assert.ok(managerFunction)
  assert.match(managerFunction, /auth\.uid\(\) is null/)
  assert.match(managerFunction, /workforce_current_user_is_active\(\)/)
  assert.match(managerFunction, /workforce_is_admin\(\)/)
  assert.match(managerFunction, /workforce_has_permission\('view_team_attendance'\)/)
  assert.doesNotMatch(managerFunction, /p_attendance_id|uuid\)/)
  assert.match(managerFunction, /clock_out is null/)
  assert.match(managerFunction, /manager_review_reason is null/)
  assert.match(managerFunction, /clock_in < v_now - interval '20 hours'/)
})

test('production-forward migration keeps strict boundary, idempotency, and payroll neutrality', () => {
  assert.match(attendanceReviewFunctions, /clock_in < v_now - interval '20 hours'/)
  assert.match(attendanceReviewFunctions, /manager_review_reason is null/)
  assert.doesNotMatch(attendanceReviewFunctions, /manager_review_reason[\s\S]{0,300}clock_out\s*=/)
  const teamFunction = teamAttendanceFunction
  assert.doesNotMatch(teamFunction, /update public\.attendance/)
})
