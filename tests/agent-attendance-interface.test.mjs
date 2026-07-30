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

test('attendance redesign preserves functional hooks and accessible theme controls', async () => {
  const [html, styles] = await Promise.all([
    read('attendance.html'),
    read('styles/attendance.css')
  ])

  for (const id of [
    'attendanceLiveClock',
    'attendanceScheduleSelect',
    'attendanceRefreshButton',
    'attendanceHistoryMonth',
    'attendanceHistoryStatus',
    'attendanceMonthCount',
    'attendancePresentCount',
    'attendanceLateCount',
    'attendanceWorkedTotal'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`))
  }

  assert.match(html, /class="attendance-console"/)
  assert.match(html, /id="attendanceThemeToggle"[\s\S]*aria-label="Use light attendance theme"/)
  assert.match(styles, /#attendanceThemeToggle:checked ~ \.attendance-app/)
  assert.match(styles, /@media \(max-width: 680px\)/)
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/)
})

test('attendance client uses workforce access scope and secure RPC functions', async () => {
  const script = await read('scripts/attendance.js')

  assert.match(script, /loadCurrentWorkforceAccess/)
  assert.match(script, /linked_profile_ids/)
  assert.match(script, /\.rpc\('workforce_clock_in'/)
  assert.match(script, /\.rpc\('workforce_clock_out'/)
  assert.match(script, /access\.is_agent !== true/)
  assert.match(script, /\.in\('user_id', profileIds\)/)
})

test('attendance summary does not fall back to an ended prior-day schedule', async () => {
  const script = await read('scripts/attendance.js')

  assert.match(script, /const fallbackSchedule = selectedSchedule\(\) \|\| null/)
  assert.doesNotMatch(script, /selectedSchedule\(\) \|\| visibleSchedules\[0\]/)
  assert.match(script, /const scheduleClockInOpen = schedule[\s\S]*: true/)
  assert.doesNotMatch(script, /: visibleSchedules\.length === 0/)
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
