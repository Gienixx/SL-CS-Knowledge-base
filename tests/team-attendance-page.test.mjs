import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const readMigrationPath = 'supabase/migrations/2026070902_team_attendance_page.sql'
const correctionMigrationPath = 'supabase/migrations/2026070904_attendance_correction_workflow.sql'

test('Team Attendance contains every required attendance column and filter', async () => {
  const page = await read('team-attendance.html')

  for (const heading of [
    'Employee',
    'Team',
    'Work date',
    'Assigned shift',
    'Clock-in',
    'Clock-out',
    'Regular time',
    'Pre-shift overtime',
    'Post-shift overtime',
    'Total overtime',
    'Late minutes',
    'Undertime',
    'Status',
    'Correction status',
    'Last corrected by',
    'Last corrected date',
    'Action'
  ]) {
    assert.match(page, new RegExp(`>${heading}<`))
  }

  for (const id of [
    'teamAttendanceStartDate',
    'teamAttendanceEndDate',
    'teamAttendanceEmployeeFilter',
    'teamAttendanceTeamFilter',
    'teamAttendanceStatusFilter',
    'teamAttendanceCorrectedFilter',
    'teamAttendanceOpenFilter',
    'teamAttendanceMissingFilter',
    'teamAttendanceOvertimeFilter'
  ]) {
    assert.match(page, new RegExp(`id="${id}"`))
  }
})

test('Team Attendance keeps view and correction permissions separate', async () => {
  const script = await read('scripts/team-attendance.js')

  assert.match(script, /hasWorkforcePermission\(access, 'view_team_attendance'\)/)
  assert.match(script, /hasWorkforcePermission\(access, 'correct_attendance'\)/)
  assert.match(script, /hasWorkforcePermission\(access, 'approve_attendance'\)/)
  assert.match(script, /workforce_list_team_attendance/)
  assert.match(script, /workforce_correct_attendance/)
  assert.doesNotMatch(script, /\.from\('attendance'\)\s*\.update\(/)
  assert.doesNotMatch(script, /\.from\('attendance'\)\s*\.insert\(/)
  assert.doesNotMatch(script, /\.from\('attendance'\)\s*\.delete\(/)
})

test('Team Attendance read service enforces permission and supervisor scope', async () => {
  const migration = await read(readMigrationPath)

  assert.match(migration, /create or replace function public\.workforce_list_team_attendance\(/)
  assert.match(migration, /workforce_has_permission\('view_team_attendance'\)/)
  assert.match(migration, /workforce_can_manage_user\(/)
  assert.match(migration, /'view_team_attendance'/)
  assert.match(migration, /revoke all on function public\.workforce_list_team_attendance\(date, date\) from anon/)
  assert.match(migration, /grant execute on function public\.workforce_list_team_attendance\(date, date\) to authenticated/)
})

test('Team Attendance uses structured calculations and identifies open attendance exceptions', async () => {
  const migration = await read(readMigrationPath)
  const script = await read('scripts/team-attendance.js')

  for (const field of [
    'regular_minutes',
    'pre_shift_overtime_minutes',
    'post_shift_overtime_minutes',
    'total_overtime_minutes',
    'total_worked_minutes',
    'minutes_late',
    'undertime_minutes',
    'is_corrected',
    'review_status',
    'corrected_by_name',
    'corrected_at',
    'is_open',
    'is_missing_clock_out'
  ]) {
    assert.match(migration, new RegExp(`\\b${field}\\b`))
    assert.match(script, new RegExp(`\\b${field}\\b`))
  }
})

test('Step 12 correction form includes every editable field and mandatory reason option', async () => {
  const page = await read('team-attendance.html')

  for (const id of [
    'attendanceCorrectionStatus',
    'attendanceCorrectionSchedule',
    'attendanceCorrectionClockIn',
    'attendanceCorrectionClockOut',
    'attendanceCorrectionAdminNotes',
    'attendanceCorrectionReason',
    'attendanceCorrectionReasonNotes'
  ]) {
    assert.match(page, new RegExp(`id="${id}"`))
  }

  for (const reason of [
    'forgot_clock_in',
    'forgot_clock_out',
    'system_issue',
    'connection_issue',
    'incorrect_schedule',
    'approved_overtime',
    'manager_confirmed',
    'other'
  ]) {
    assert.match(page, new RegExp(`value="${reason}"`))
  }
})

test('Step 12 correction transaction is server-authorized, audited, and recalculated', async () => {
  const migration = await read(correctionMigrationPath)

  assert.match(migration, /create or replace function public\.workforce_correct_attendance\(/)
  assert.match(migration, /workforce_can_correct_attendance\(v_target_user_id\)/)
  assert.match(migration, /workforce_can_approve_attendance\(v_attendance\.user_id\)/)
  assert.match(migration, /workforce_recalculate_attendance_work_date/)
  assert.match(migration, /workforce_recalculate_attendance\(v_attendance\.id\)/)
  assert.match(migration, /v_before := to_jsonb\(v_attendance\)/)
  assert.match(migration, /'attendance_corrected'/)
  assert.match(migration, /'reason_code'/)
  assert.match(migration, /'reason_notes'/)
})

test('Step 12 removes direct authenticated attendance mutation privileges', async () => {
  const migration = await read(correctionMigrationPath)

  assert.match(migration, /drop policy if exists "Authorized users can insert attendance"/)
  assert.match(migration, /drop policy if exists "Authorized users can update attendance"/)
  assert.match(migration, /drop policy if exists "Authorized users can delete attendance"/)
  assert.match(migration, /revoke insert, update, delete on public\.attendance from authenticated/)
  assert.match(migration, /grant select on public\.attendance to authenticated/)
})

test('Team Attendance includes verification, documentation, and Home navigation', async () => {
  const verification = await read('supabase/verification/team_attendance_page_check.sql')
  const documentation = await read('docs/workforce-step-10-team-attendance.md')
  const navigation = await read('scripts/home-workforce-nav.js')

  assert.match(verification, /Every blocker query in section 5 must return zero rows/)
  assert.match(documentation, /Step 10 is intentionally read-only/)
  assert.match(navigation, /homeTeamAttendanceBtn/)
  assert.match(navigation, /view_team_attendance/)
})
