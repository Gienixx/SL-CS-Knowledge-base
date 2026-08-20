import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('attendance page exposes agent clock actions and history', async () => {
  const html = await read('attendance.html')

  assert.match(html, /id="attendanceClockInButton"/)
  assert.match(html, /id="attendanceClockOutButton"/)
  assert.match(html, /id="attendanceHistoryBody"/)
  assert.match(html, /scripts\/attendance\.js/)
})

test('agents can use the unscheduled attendance path when no released schedule exists', async () => {
  const script = await read('scripts/attendance.js')
  const migration = await read('supabase/migrations/20260731065252_allow_next_day_special_schedule_clock_in.sql')
  assert.match(script, /No assigned schedule\. Your time will be recorded as unscheduled attendance\./)
  assert.match(script, /SCHEDULE_PLACEHOLDER = '__SCHEDULE_PLACEHOLDER__'/)
  assert.match(script, /ADDITIONAL_WORK_SESSION = '__ADDITIONAL_WORK_SESSION__'/)
  assert.match(script, /const preferred = optionValues\.includes\(previous\) && previous[\s\S]*?: ''/)
  assert.match(script, /const workOnVLSelected = isWorkOnVLSelected\(\)/)
  assert.match(script, /const scheduleId = selectedValue === ADDITIONAL_WORK_SESSION \|\| workOnVLSelected \? null : selectedValue/)
  assert.match(migration, /if p_schedule_id is null then/)
  assert.match(migration, /schedule_id,\s*\n\s*work_date,\s*\n\s*clock_in/)
  assert.match(migration, /already clocked in to another shift/)
})

test('attendance redesign preserves functional hooks and accessible theme controls', async () => {
  const [html, styles, lightStyles] = await Promise.all([
    read('attendance.html'),
    read('styles/attendance.css'),
    read('styles/attendance-theme-fix.css')
  ])

  for (const id of [
    'attendanceLiveClock',
    'attendanceScheduleSelect',
    'attendanceRefreshButton',
    'attendanceHistoryMonth',
    'attendanceHistoryPeriod',
    'attendanceHistoryStatus',
    'attendanceHistoryPrevious',
    'attendanceHistoryNext',
    'attendanceHistoryPageStatus',
    'attendanceMonthCount',
    'attendancePresentCount',
    'attendanceLateCount',
    'attendanceWorkedTotal'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`))
  }

  assert.match(html, /class="attendance-console"/)
  // Theme selection is owned by Home's global site-theme control; Attendance
  // must not introduce a duplicate page-specific toggle.
  assert.doesNotMatch(html, /id="attendanceThemeToggle"/)
  assert.doesNotMatch(styles, /#attendanceThemeToggle:checked ~ \.attendance-app/)
  assert.match(styles, /@media \(max-width: 680px\)/)
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/)
  assert.match(
    lightStyles,
    /html\[data-site-theme="light"\] \.attendance-note-cell\s*\{[\s\S]*color:\s*var\(--site-text\) !important/
  )
})

test('clock-in and clock-out share the enabled gold action styling', async () => {
  const [styles, lightStyles] = await Promise.all([
    read('styles/attendance.css'),
    read('styles/attendance-theme-fix.css')
  ])

  assert.match(
    styles,
    /:is\(#attendanceClockInButton, #attendanceClockOutButton\):not\(:disabled\)/
  )
  assert.match(
    styles,
    /:is\(#attendanceClockInButton, #attendanceClockOutButton\):hover:not\(:disabled\)/
  )
  assert.match(
    lightStyles,
    /\.attendance-action-primary,\s*\.attendance-action-secondary\s*\):not\(:disabled\)/
  )
})

test('attendance history defaults to a half-month and paginates five entries at a time', async () => {
  const [html, script, styles] = await Promise.all([
    read('attendance.html'),
    read('scripts/attendance.js'),
    read('styles/attendance.css')
  ])

  assert.match(html, /<option value="first">Days 1–15<\/option>/)
  assert.match(html, /<option value="second">Days 16–end<\/option>/)
  assert.match(script, /const HISTORY_PAGE_SIZE = 5/)
  assert.match(script, /Number\(String\(dateKey\)\.slice\(-2\)\) <= 15 \? 'first' : 'second'/)
  assert.match(script, /rows\.slice\(pageStart, pageStart \+ HISTORY_PAGE_SIZE\)/)
  assert.match(script, /\.rpc\(\s*'workforce_list_my_attendance_log'/)
  assert.match(script, /p_start_date: range\.start/)
  assert.match(script, /p_end_date: range\.end/)
  assert.match(styles, /\.attendance-console \{[\s\S]*min-height: 390px/)
  assert.match(styles, /\.attendance-app \.wf-table td \{[\s\S]*height: 48px/)
  assert.match(styles, /\.attendance-history-footer \{[\s\S]*display: flex/)
})

test('attendance client allows every active workforce role and uses secure RPC functions', async () => {
  const script = await read('scripts/attendance.js')

  assert.match(script, /loadCurrentWorkforceAccess/)
  assert.match(script, /linked_profile_ids/)
  assert.match(script, /\.rpc\('workforce_clock_in'/)
  assert.match(script, /\.rpc\('workforce_clock_out'/)
  assert.match(script, /if \(!access\.allowed\)/)
  assert.doesNotMatch(script, /access\.is_agent !== true/)
  assert.match(script, /\.in\('user_id', profileIds\)/)
})

test('attendance notes show one human-readable correction reason', async () => {
  const script = await read('scripts/attendance.js')

  assert.match(script, /forgot_to_clock_out: 'Forgot to clock out'/)
  assert.match(script, /replace\(\/\^reason\\s\*:\\s\*\/i, ''\)/)
  assert.match(script, /split\(\/\\s\*\(\?:\:\|·\|\\\|\)\\s\*\//)
  assert.match(script, /noteCell\.textContent = formatCorrectionReason\(record\.correction_reason\)/)
  assert.doesNotMatch(script, /\[record\.admin_notes, record\.correction_reason\]/)
})

test('attendance summary does not fall back to an ended prior-day schedule', async () => {
  const script = await read('scripts/attendance.js')

  assert.match(script, /const fallbackSchedule = selectedSchedule\(\) \|\| null/)
  assert.doesNotMatch(script, /selectedSchedule\(\) \|\| visibleSchedules\[0\]/)
  assert.match(script, /const scheduleClockInOpen = adminAssistMode/)
  assert.match(script, /availability\.state === 'open'/)
  assert.match(script, /isAdditionalWorkSessionSelected\(\) && canClockAdditionalSession\(\)/)
  assert.match(script, /isWorkOnVLSelected\(\) && paidLeaveWorkOptionEligible\(\)/)
})

test('attendance requires an explicit eligible schedule and supports tomorrow early shifts', async () => {
  const script = await read('scripts/attendance.js')

  assert.match(script, /state: 'next-day-overnight'/)
  assert.match(script, /'next-day-overnight', 'special', 'early', 'active'/)
  assert.match(script, /new Option\('Select a schedule', SCHEDULE_PLACEHOLDER\)/)
  assert.match(script, /new Option\('Unscheduled attendance', SCHEDULE_PLACEHOLDER\)/)
})

test('attendance automatically refreshes when the agent work date changes', async () => {
  const [html, script] = await Promise.all([
    read('attendance.html'),
    read('scripts/attendance.js')
  ])

   assert.match(html, /scripts\/attendance\.js\?v=27/)
  assert.match(script, /const nextLocalDate = localDateKey\(now\)/)
  assert.match(script, /nextLocalDate !== activeLocalDate/)
  assert.match(script, /localDateRefreshPending = true/)
  assert.match(script, /elements\.historyPeriod\.value = defaultHistoryPeriod\(nextLocalDate\)/)
  assert.match(script, /if \(localDateRefreshPending && !busy\)[\s\S]*void refreshAll\(\)/)
})

test('attendance migration is identity-link aware and calculates shift adjustments', async () => {
  const migration = await read('supabase/migrations-legacy/2026070801_agent_attendance_interface.sql')

  assert.match(migration, /function public\.workforce_current_profile_id\(\)/)
  assert.match(migration, /public\.workforce_is_current_identity\(schedule\.user_id\)/)
  assert.match(migration, /public\.workforce_is_current_identity\(attendance_row\.user_id\)/)
  assert.match(migration, /v_minutes_late/)
  assert.match(migration, /v_overtime_minutes/)
  assert.match(migration, /v_undertime_minutes/)
})

test('home and schedule navigation include attendance', async () => {
  const [home, navigation, schedule] = await Promise.all([
    read('home.html'),
    read('scripts/home-workforce-nav.js'),
    read('my-schedule.html')
  ])

  assert.match(home, /id="homeAttendanceBtn"/)
  assert.match(navigation, /homeAttendanceBtn/)
  assert.match(schedule, /href="\.\/attendance\.html"/)
})
