import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath = 'supabase/migrations-legacy/2026070902_team_attendance_page.sql'

test('Step 10 page contains every required attendance column and filter', async () => {
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
    'Last corrected date'
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

test('Team Attendance requires view permission and only corrects attendance through the RPC', async () => {
  const script = await read('scripts/team-attendance.js')

  assert.match(script, /hasWorkforcePermission\(access, 'view_team_attendance'\)/)
  assert.match(script, /workforce_list_team_attendance/)
  assert.doesNotMatch(script, /\.from\('attendance'\)\s*\.update\(/)
  assert.doesNotMatch(script, /\.from\('attendance'\)\s*\.insert\(/)
  assert.match(script, /supabase\.rpc\('workforce_correct_attendance'/)
})

test('Step 10 data service enforces permission and supervisor scope', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /create or replace function public\.workforce_list_team_attendance\(/)
  assert.match(migration, /workforce_has_permission\('view_team_attendance'\)/)
  assert.match(migration, /workforce_can_manage_user\(/)
  assert.match(migration, /'view_team_attendance'/)
  assert.match(migration, /revoke all on function public\.workforce_list_team_attendance\(date, date\) from anon/)
  assert.match(migration, /grant execute on function public\.workforce_list_team_attendance\(date, date\) to authenticated/)
})

test('Team Attendance displays correction modal and submits through correction RPC', async () => {
  const page = await read('team-attendance.html')
  const script = await read('scripts/team-attendance.js')

  assert.match(page, /id="teamAttendanceCorrectionModal"/)
  assert.match(page, /id="teamAttendanceCorrectionForm"/)
  assert.match(page, /id="teamAttendanceNewClockIn"/)
  assert.match(page, /id="teamAttendanceReasonCode"/)
  assert.match(script, /supabase\.rpc\('workforce_correct_attendance'/)
  assert.match(script, /function openCorrectionModal\(/)
  assert.match(script, /modal\.dataset\.attendanceId = row\.attendance_id \|\| ''/)
  assert.match(script, /function handleCorrectionSubmit\(/)
  assert.match(script, /p_new_clock_in: parseInput\(newClockIn\)/)
})

test('Step 10 uses structured calculations and identifies open attendance exceptions', async () => {
  const migration = await read(migrationPath)
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

test('Step 10 includes verification, documentation, and Home navigation', async () => {
  const verification = await read('supabase/verification/team_attendance_page_check.sql')
  const documentation = await read('docs/workforce-step-10-team-attendance.md')
  const navigation = await read('scripts/home-workforce-nav.js')

  assert.match(verification, /Every blocker query in section 5 must return zero rows/)
  assert.match(documentation, /Step 10 is intentionally read-only/)
  assert.match(navigation, /homeTeamAttendanceBtn/)
  assert.match(navigation, /view_team_attendance/)
})
