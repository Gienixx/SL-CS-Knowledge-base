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

test('attendance client uses workforce access scope and secure RPC functions', async () => {
  const script = await read('scripts/attendance.js')

  assert.match(script, /loadCurrentWorkforceAccess/)
  assert.match(script, /linked_profile_ids/)
  assert.match(script, /\.rpc\('workforce_clock_in'/)
  assert.match(script, /\.rpc\('workforce_clock_out'/)
  assert.match(script, /access\.is_agent !== true/)
  assert.match(script, /\.in\('user_id', profileIds\)/)
})

test('attendance migration is identity-link aware and calculates shift adjustments', async () => {
  const migration = await read('supabase/migrations/2026070801_agent_attendance_interface.sql')

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
