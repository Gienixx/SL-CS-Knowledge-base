import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath = 'supabase/migrations-legacy/2026070902_team_attendance_page.sql'
const manualEntryMigrationPath = 'supabase/migrations/20260714070649_manual_attendance_entry.sql'
const approvalLockingMigrationPath = 'supabase/migrations/20260717172240_attendance_approval_locking.sql'
const writeBoundaryMigrationPath = 'supabase/migrations/20260721153218_harden_attendance_write_boundaries.sql'
const timestampHistoryMigrationPath = 'supabase/migrations/20260806120000_team_attendance_original_timestamps.sql'
const billedRpcMigrationPath = 'supabase/migrations/20260808113000_expose_billed_attendance_in_team_rpc.sql'

test('Team Attendance listing RPC returns billed timestamps without changing its scope contract', async () => {
  const migration = await read(billedRpcMigrationPath)

  assert.match(migration, /billed_clock_in timestamptz,\s*billed_clock_out timestamptz/)
  assert.match(migration, /attendance_row\.billed_clock_in/)
  assert.match(migration, /attendance_row\.billed_clock_out/)
  assert.match(migration, /workforce_can_manage_user\(attendance_row\.user_id, 'view_team_attendance'\)/)
  assert.match(migration, /not v_is_admin and attendance_row\.clock_in is not null/)
  assert.match(migration, /order by attendance_row\.work_date desc/)
  assert.match(migration, /revoke all on function public\.workforce_list_team_attendance\(date, date\)/)
  assert.match(migration, /grant execute on function public\.workforce_list_team_attendance\(date, date\)[\s\S]*to authenticated, service_role/)
})

test('Team Attendance returns immutable original timestamps for edited-card history', async () => {
  const [migration, baseline] = await Promise.all([
    read(timestampHistoryMigrationPath),
    read('supabase/migrations/20260711083340_remote_schema_baseline.sql')
  ])
  const script = await read('scripts/team-attendance.js')

  assert.match(migration, /original_clock_in timestamptz,\s*original_clock_out timestamptz/)
  assert.match(migration, /attendance_row\.original_clock_in/)
  assert.match(migration, /attendance_row\.original_clock_out/)
  assert.match(script, /record\.original_clock_in/)
  assert.match(script, /record\.original_clock_out/)
  assert.match(baseline, /original_clock_in is immutable after capture/)
})

test('Team Attendance displays original and billed timestamp fields without strikethrough', async () => {
  const [script, page, styles] = await Promise.all([
    read('scripts/team-attendance.js'),
    read('team-attendance.html'),
    read('styles/team-attendance.css')
  ])

  assert.match(script, /'Original Clock-in'/)
  assert.match(script, /'Original Clock-out'/)
  assert.match(script, /'Billed Clock-in'/)
  assert.match(script, /'Billed Clock-out'/)
  assert.match(script, /effectiveAttendanceClocks/)
  assert.match(script, /'Total Rendered Hours'/)
  assert.match(script, /'Total Billed Hours'/)
  assert.doesNotMatch(script, /createElement\('del'\)/)
  assert.doesNotMatch(styles, /text-decoration:line-through/)
  assert.match(script, /'Total Billed Hours'/)
  assert.match(script, /team-attendance-prepaid-caret/)
  assert.match(script, /aria-expanded/)
  assert.match(script, /prepaid\.addEventListener\('toggle'/)
  assert.match(styles, /\.team-attendance-prepaid-values\{display:grid;grid-template-columns:repeat\(3/)
  assert.match(page, /Total billed hours/)
})

test('Team Attendance edits billed timestamps only and locks final edits after approval', async () => {
  const [script, page] = await Promise.all([
    read('scripts/team-attendance.js'),
    read('team-attendance.html')
  ])

  assert.match(script, /row\.billed_clock_in \|\| row\.clock_in/)
  assert.match(script, /row\.billed_clock_out \|\| row\.clock_out/)
  assert.match(script, /row\.review_status === 'locked'/)
  assert.match(script, /Remarks are required when billed time or schedule changes/)
  assert.match(script, /supabase\.rpc\('workforce_review_attendance'/)
  assert.match(page, /Billed Clock-in/)
  assert.match(page, /Billed Clock-out/)
  assert.match(page, /Original · read-only/)
  assert.match(page, /id="teamAttendanceCorrectionSchedule"/)
  assert.doesNotMatch(page, /id="teamAttendanceCorrectionSchedule"[^>]*disabled/)
  assert.match(page, /id="teamAttendanceNewStatus"[^>]*disabled/)
})

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
    'Prepaid login',
    'Prepaid logout',
    'Prepaid time',
    'Actual eligible',
    'Applied to prepaid',
    'Remaining prepaid',
    'Prepaid status',
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

test('administrator Team Attendance defaults to the current half-month attendance period', async () => {
  const script = await read('scripts/team-attendance.js')
  const functionSource = script.match(/function defaultDateRange\(\) \{[\s\S]*?\n\}/)?.[0]

  assert.ok(functionSource, 'defaultDateRange should remain independently testable')
  const defaultRangeFor = dateKey => Function(
    'localDateKey',
    `${functionSource}\nreturn defaultDateRange()`
  )(() => dateKey)

  assert.deepEqual(defaultRangeFor('2026-07-01'), {
    start: '2026-07-01',
    end: '2026-07-15'
  })
  assert.deepEqual(defaultRangeFor('2026-07-15'), {
    start: '2026-07-01',
    end: '2026-07-15'
  })
  assert.deepEqual(defaultRangeFor('2026-07-16'), {
    start: '2026-07-16',
    end: '2026-07-31'
  })
  assert.deepEqual(defaultRangeFor('2026-04-30'), {
    start: '2026-04-16',
    end: '2026-04-30'
  })
  assert.deepEqual(defaultRangeFor('2028-02-16'), {
    start: '2028-02-16',
    end: '2028-02-29'
  })
  assert.deepEqual(defaultRangeFor('2027-02-16'), {
    start: '2027-02-16',
    end: '2027-02-28'
  })
})

test('Team Attendance gives regular agents live access while retaining admin permission checks', async () => {
  const script = await read('scripts/team-attendance.js')

  assert.match(script, /const hasAdminAttendanceAccess = access\.is_admin === true/)
  assert.match(script, /const hasAgentLiveAccess = access\.is_admin !== true && access\.is_agent === true/)
  assert.match(script, /hasWorkforcePermission\(access, 'view_team_attendance'\)/)
  assert.match(script, /workforce_list_team_attendance/)
  assert.doesNotMatch(script, /\.from\('attendance'\)\s*\.update\(/)
  assert.doesNotMatch(script, /\.from\('attendance'\)\s*\.insert\(/)
  assert.match(script, /workforce_assign_attendance_schedule/)
  assert.match(script, /workforce_correct_attendance/)
})

test('Team Attendance lets schedule administrators delete an attendance record with confirmation', async () => {
  const page = await read('team-attendance.html')
  const script = await read('scripts/team-attendance.js')
  const migration = await read(writeBoundaryMigrationPath)
  const visibilityMigration = await read('supabase/migrations/20260814130000_exclude_voided_team_attendance.sql')

  assert.match(page, /permanently delete invalid test and timing records/)
  assert.match(script, /access\?\.is_admin === true && hasWorkforcePermission\(access, 'manage_schedules'\)/)
  assert.match(page, /teamAttendanceDeleteModal/)
  assert.match(script, /teamAttendanceDeleteForm/)
  assert.match(script, /deleteForm\?\.addEventListener\('submit'/)
  assert.match(script, /supabase\.rpc\('workforce_delete_attendance'/)
  assert.doesNotMatch(script, /\.from\('attendance'\)\s*\.delete\(/)
  assert.match(script, /Attendance record deleted\./)
  assert.match(migration, /create or replace function public\.workforce_delete_attendance\(/)
  assert.match(migration, /security definer\s+set search_path = ''/)
  assert.match(migration, /workforce_can_manage_user\(v_attendance\.user_id, 'manage_schedules'\)/)
  assert.match(migration, /'attendance_deleted'/)
  assert.match(migration, /revoke all on function public\.workforce_delete_attendance\(uuid, text\)[\s\S]*from public, anon, authenticated/)
  assert.match(visibilityMigration, /attendance_row\.voided_at is null/)
  assert.match(script, /review_status === 'voided'/)
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
  assert.match(page, /styles\/team-attendance\.css\?v=13/)
  assert.match(styles, /#teamAttendanceCorrectionModal \.team-attendance-correction-dialog\{[^}]*background:var\(--site-surface-solid\)/)
  assert.match(styles, /#teamAttendanceCorrectionModal \.wf-control\{[^}]*background:var\(--site-surface-solid\)[^}]*color:var\(--site-text\)/)
  assert.match(styles, /#teamAttendanceCorrectionModal \.wf-dialog-actions #teamAttendanceCorrectionSubmit\{[^}]*background:var\(--site-blue-strong\)/)
})

test('Team Attendance shows a compact filtered total billed hours summary', async () => {
  const page = await read('team-attendance.html')
  const script = await read('scripts/team-attendance.js')
  const styles = await read('styles/team-attendance.css')

  assert.match(page, /Total billed hours/)
  assert.match(page, /id="teamAttendanceBilledHours"/)
  assert.match(page, /styles\/team-attendance\.css\?v=13/)
  assert.match(script, /billedHours: document\.getElementById\('teamAttendanceBilledHours'\)/)
  assert.match(script, /attendanceHours\(row\)\.billedMinutes/)
  assert.match(script, /elements\.billedHours\.textContent = formatMinutes/)
  assert.match(styles, /\.team-attendance-stats\{[\s\S]*grid-template-columns:repeat\(5,minmax\(85px,max-content\)\)/)
  assert.match(styles, /\.team-attendance-page \.wf-summary-grid\{grid-template-columns:repeat\(5/)
  assert.match(styles, /\.team-attendance-page \.wf-summary\{[^}]*min-height:70px/)
  assert.match(styles, /\.team-attendance-page \.wf-summary span\{[^}]*font-size:9px[^}]*white-space:nowrap/)
  assert.match(styles, /\.team-attendance-page \.wf-summary strong\{[^}]*font-size:18px[^}]*white-space:nowrap/)
  assert.match(styles, /\.team-attendance-page \.wf-summary:nth-child\(5\)>span\{[^}]*max-width:70px[^}]*white-space:normal/)
})

test('Team Attendance exposes unscheduled filtering and audited schedule assignment', async () => {
  const [page, script, migration] = await Promise.all([
    read('team-attendance.html'),
    read('scripts/team-attendance.js'),
    read('supabase/migrations/20260810100000_unscheduled_attendance_schedule_assignment.sql')
  ])
  assert.match(page, /id="teamAttendanceUnscheduledFilter"/)
  assert.match(page, />Unscheduled</)
  assert.match(script, /correctButton\.textContent = row\.schedule_id \? 'Edit' : 'Assign Schedule'/)
  assert.match(script, /\.rpc\(rpcName, rpcParams\)/)
  assert.match(script, /\.eq\('shift_date', row\.work_date\)/)
  assert.match(migration, /workforce_assign_attendance_schedule/)
  assert.match(migration, /previous_schedule_id/)
  assert.match(migration, /Only published or changed schedules may be assigned/)
  assert.match(migration, /attendance_schedule_assigned/)
})

test('Team Attendance uses rendered hours until correction, then billed hours', async () => {
  const script = await read('scripts/team-attendance.js')

  assert.match(script, /if \(!hasBilledOverride\(record\)\)/)
  assert.match(script, /billedClockIn: originalClockIn, billedClockOut: originalClockOut/)
  assert.match(script, /billedClockIn: record\?\.billed_clock_in \|\| null/)
  assert.match(script, /renderedMinutes: durationMinutes\(clocks\.renderedClockIn, clocks\.renderedClockOut\)/)
  assert.match(script, /billedMinutes: durationMinutes\(clocks\.billedClockIn, clocks\.billedClockOut\)/)
  assert.match(script, /durationMinutes\(clockIn, clockOut\)/)
})

test('Team Attendance uses the required hour stat color mapping', async () => {
  const styles = await read('styles/team-attendance.css')
  assert.match(styles, /nth-child\(1\) strong,[\s\S]*nth-child\(2\) span\{\s*color:#fff/)
  assert.match(styles, /nth-child\(3\) strong,[\s\S]*color:var\(--ta-red\)/)
  assert.match(styles, /nth-child\(4\) strong,[\s\S]*color:var\(--ta-green\)/)
  assert.match(styles, /nth-child\(5\) strong,[\s\S]*color:var\(--ta-amber\)/)
})

test('Team Attendance preserves a distinct dark-mode card hierarchy', async () => {
  const styles = await read('styles/team-attendance.css')

  assert.match(styles, /html\[data-site-theme="dark"\] body:has\(\.team-attendance-page\)\{background:var\(--site-bg\)/)
  assert.match(styles, /html\[data-site-theme="dark"\] \.team-attendance-record\{[^}]*background:#10243a/)
  assert.match(styles, /html\[data-site-theme="dark"\] \.team-attendance-prepaid-title\{[^}]*background:#1a3149/)
  assert.doesNotMatch(styles, /html\[data-site-theme="dark"\] \.team-attendance-prepaid-title\{[^}]*background:#fff/)
  assert.match(styles, /html\[data-site-theme="dark"\] \.team-attendance-record-mid \.team-attendance-meta:nth-child\(n\+2\) strong\{font-family:'Poppins',Arial,sans-serif/)
  assert.match(styles, /html\[data-site-theme="dark"\] \.team-attendance-track\{background:#243a51/)
})

test('Team Attendance does not flag fully classified long overtime records', async () => {
  const page = await read('team-attendance.html')
  const script = await read('scripts/team-attendance.js')

  assert.match(page, /scripts\/team-attendance\.js\?v=20/)
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

test('Team Attendance keeps the employee search editable after approval reloads the records', async () => {
  const script = await read('scripts/team-attendance.js')

  assert.match(script, /const searchValue = elements\.search\.value/)
  assert.match(script, /await loadAttendance\(\)[\s\S]*elements\.search\.value = searchValue/)
  assert.match(script, /elements\.search\.disabled = false/)
  assert.match(script, /elements\.search\.readOnly = false/)
  assert.match(script, /elements\.search\.focus\(\{ preventScroll: true \}\)/)
  assert.match(script, /elements\.search\.setSelectionRange\(searchCaret, searchCaret\)/)
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
  assert.match(page, /class="wf-backdrop" type="button" data-close="teamAttendanceCorrectionModal" aria-label="Close attendance correction dialog"/)
  assert.match(script, /event\.target\.closest\('\.team-attendance-record-actions'\)/)
  assert.match(script, /menu\.open = false/)
  assert.match(page, /id="teamAttendanceCorrectionForm"/)
  assert.match(page, /id="teamAttendanceNewClockIn"/)
  assert.match(page, /id="teamAttendanceCorrectionSchedule"/)
  assert.match(page, /class="team-attendance-correction-summary"/)
  assert.match(page, /class="team-attendance-change-row"/)
  assert.match(page, /id="teamAttendanceCorrectionCurrentStatus"/)
  assert.match(page, /id="teamAttendanceReasonCode"/)
  assert.match(script, /workforce_assign_attendance_schedule/)
  assert.match(script, /workforce_correct_attendance/)
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
