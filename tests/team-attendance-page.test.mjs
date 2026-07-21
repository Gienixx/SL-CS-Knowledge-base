import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath = 'supabase/migrations-legacy/2026070902_team_attendance_page.sql'
const manualEntryMigrationPath = 'supabase/migrations/20260714070649_manual_attendance_entry.sql'
const approvalLockingMigrationPath = 'supabase/migrations/20260717171751_attendance_approval_locking.sql'

test('Step 10 page contains every required attendance column and filter', async () => {
  const page = await read('team-attendance.html')

  assert.match(page, /href="\.\/home\.html">← Back to Home<\/a>/)

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

test('Team Attendance lets schedule administrators delete an attendance record with confirmation', async () => {
  const page = await read('team-attendance.html')
  const script = await read('scripts/team-attendance.js')

  assert.match(page, /permanently delete invalid test and timing records/)
  assert.match(script, /access\?\.is_admin === true && hasWorkforcePermission\(access, 'manage_schedules'\)/)
  assert.match(script, /window\.confirm\(/)
  assert.match(script, /\.from\('attendance'\)\s*\.delete\(\)\s*\.eq\('id', row\.attendance_id\)\s*\.select\('id'\)/)
  assert.match(script, /Attendance record deleted successfully\./)
})

test('Team Attendance lets schedule administrators add an audited manual record', async () => {
  const page = await read('team-attendance.html')
  const script = await read('scripts/team-attendance.js')
  const migration = await read(manualEntryMigrationPath)

  for (const id of [
    'teamAttendanceAddButton',
    'teamAttendanceAddModal',
    'teamAttendanceAddForm',
    'teamAttendanceAddEmployee',
    'teamAttendanceAddWorkDate',
    'teamAttendanceAddSchedule',
    'teamAttendanceAddClockIn',
    'teamAttendanceAddClockOut',
    'teamAttendanceAddReason'
  ]) {
    assert.match(page, new RegExp(`id="${id}"`))
  }

  assert.match(script, /supabase\.rpc\('workforce_create_manual_attendance'/)
  assert.match(script, /hasWorkforcePermission\(access, 'manage_schedules'\)/)
  assert.match(migration, /create or replace function public\.workforce_create_manual_attendance\(/)
  assert.match(migration, /security definer\s+set search_path = ''/)
  assert.match(migration, /workforce_current_user_is_active\(\)/)
  assert.match(migration, /workforce_is_admin\(\)/)
  assert.match(migration, /workforce_has_permission\('manage_schedules'\)/)
  assert.match(migration, /workforce_can_manage_user\(p_user_id, 'manage_schedules'\)/)
  assert.match(migration, /workforce_recalculate_attendance\(v_inserted\.id\)/)
  assert.match(migration, /'manual_attendance_created'/)
  assert.match(migration, /revoke all on function public\.workforce_create_manual_attendance[\s\S]*from public/)
  assert.match(migration, /grant execute on function public\.workforce_create_manual_attendance[\s\S]*to authenticated/)
})

test('Team Attendance uses the compact card design and paginates five records at a time', async () => {
  const page = await read('team-attendance.html')
  const script = await read('scripts/team-attendance.js')
  const styles = await read('styles/team-attendance.css')

  assert.match(page, /id="teamAttendancePagination"/)
  assert.match(page, /id="teamAttendancePreviousPage"/)
  assert.match(page, /id="teamAttendanceNextPage"/)
  assert.match(script, /const ATTENDANCE_PAGE_SIZE = 5/)
  assert.match(script, /rows\.slice\(pageStart, pageStart \+ ATTENDANCE_PAGE_SIZE\)/)
  assert.match(script, /function createAttendanceCard\(/)
  assert.match(script, /function createTimeline\(/)
  assert.match(styles, /\.team-attendance-record\{/)
  assert.match(styles, /\.team-attendance-timeline\{/)
  assert.match(styles, /\.team-attendance-filter-grid\{[^}]*repeat\(6/)
  assert.match(styles, /\.team-attendance-record-mid \.team-attendance-meta:nth-child\(n\+2\) strong\{font-family:'IBM Plex Mono','Courier New',monospace/)
  assert.match(styles, /#teamAttendanceCorrectionModal \.team-attendance-correction-dialog\{[^}]*width:min\(100%,620px\)/)
  assert.match(styles, /#teamAttendanceCorrectionModal \.wf-dialog-header h2\{[^}]*font-family:'Poppins'/)
  assert.match(styles, /#teamAttendanceCorrectionModal \.wf-dialog-actions #teamAttendanceCorrectionSubmit\{[^}]*background:#15203b/)
})

test('Team Attendance shows a compact filtered total billed hours summary', async () => {
  const page = await read('team-attendance.html')
  const script = await read('scripts/team-attendance.js')
  const styles = await read('styles/team-attendance.css')

  assert.match(page, /Total billed hours/)
  assert.match(page, /id="teamAttendanceBilledHours"/)
  assert.match(page, /styles\/team-attendance\.css\?v=9/)
  assert.match(script, /billedHours: document\.getElementById\('teamAttendanceBilledHours'\)/)
  assert.match(script, /row\.total_worked_minutes/)
  assert.match(script, /elements\.billedHours\.textContent = formatMinutes/)
  assert.match(styles, /\.team-attendance-page \.wf-summary-grid\{grid-template-columns:repeat\(5/)
  assert.match(styles, /\.team-attendance-page \.wf-summary\{[^}]*min-height:70px/)
  assert.match(styles, /\.team-attendance-page \.wf-summary span\{[^}]*font-size:9px[^}]*white-space:nowrap/)
  assert.match(styles, /\.team-attendance-page \.wf-summary strong\{[^}]*font-size:18px[^}]*white-space:nowrap/)
  assert.match(styles, /\.team-attendance-page \.wf-summary:nth-child\(5\)>span\{[^}]*max-width:70px[^}]*white-space:normal/)
})

test('Team Attendance does not flag fully classified long overtime records', async () => {
  const page = await read('team-attendance.html')
  const script = await read('scripts/team-attendance.js')

  assert.match(page, /scripts\/team-attendance\.js\?v=5/)
  assert.match(script, /const hasUnclassifiedWorkedMinutes = workedMinutes > regularMinutes \+ overtimeMinutes/)
  assert.match(script, /record\.schedule_id && hasUnclassifiedWorkedMinutes/)
  assert.match(script, /if \(overtimeMinutes > 0\) return \{ label: 'Overtime'/)
})

test('Team Attendance provides authorized audited approval and locking actions', async () => {
  const page = await read('team-attendance.html')
  const script = await read('scripts/team-attendance.js')
  const migration = await read(approvalLockingMigrationPath)
  const verification = await read('supabase/verification/attendance_approval_locking_check.sql')
  const documentation = await read('docs/attendance-approval-locking.md')

  assert.match(page, /irreversibly lock finalized attendance/)
  assert.match(script, /access\?\.can_approve_attendance/)
  assert.match(script, /reviewAttendance\(row, 'approved'/)
  assert.match(script, /reviewAttendance\(row, 'locked'/)
  assert.match(script, /supabase\.rpc\('workforce_review_attendance'/)
  assert.match(script, /locked attendance cannot be corrected or deleted/)

  assert.match(migration, /create or replace function public\.workforce_review_attendance\(/)
  assert.match(migration, /security definer\s+set search_path = ''/)
  assert.match(migration, /workforce_current_profile_id\(\)/)
  assert.match(migration, /workforce_can_approve_attendance\(v_attendance\.user_id\)/)
  assert.match(migration, /review_status = p_review_status/)
  assert.match(migration, /'attendance_approved'/)
  assert.match(migration, /'attendance_locked'/)
  assert.match(migration, /create trigger zz_attendance_locked_immutable/)
  assert.match(migration, /revoke all on function public\.workforce_review_attendance[\s\S]*from public, anon/)
  assert.match(migration, /grant execute on function public\.workforce_review_attendance[\s\S]*to authenticated/)
  assert.match(verification, /review_rpc_acl_is_safe/)
  assert.match(verification, /reviewed_by is null or reviewed_at is null/)
  assert.match(documentation, /Locked attendance cannot be updated, corrected, or deleted/)
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
  assert.match(page, /id="teamAttendanceCorrectionSchedule"/)
  assert.match(page, /class="team-attendance-correction-summary"/)
  assert.match(page, /class="team-attendance-change-row"/)
  assert.match(page, /id="teamAttendanceCorrectionCurrentStatus"/)
  assert.match(page, /id="teamAttendanceReasonCode"/)
  assert.match(script, /supabase\.rpc\('workforce_correct_attendance'/)
  assert.match(script, /function openCorrectionModal\(/)
  assert.match(script, /function loadCorrectionSchedules\(/)
  assert.match(script, /\.eq\('shift_date', row\.work_date\)/)
  assert.match(script, /modal\.dataset\.attendanceId = row\.attendance_id \|\| ''/)
  assert.match(script, /function handleCorrectionSubmit\(/)
  assert.match(script, /p_new_clock_in: dateTimeLocalToIso\(newClockIn\)/)
  assert.match(script, /p_schedule_id: scheduleId \|\| null/)
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
