import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath = 'supabase/migrations/20260731065252_allow_next_day_special_schedule_clock_in.sql'

test('Attendance enables tomorrow special-day schedules after today is completed', async () => {
  const page = await read('attendance.html')
  const script = await read('scripts/attendance.js')

  assert.match(page, /scripts\/attendance\.js\?v=12/)
  assert.match(script, /function hasCompletedAttendanceForDate\(workDate\)/)
  assert.match(script, /schedule\.shift_date === tomorrow[\s\S]*hasCompletedAttendanceForDate\(today\)/)
  assert.match(script, /state: 'next-day-special'/)
  assert.match(script, /'next-day-special',[\s\S]*'special',[\s\S]*'early',[\s\S]*'active'/)
  assert.match(script, /clock in early for tomorrow’s rest day/)
  assert.match(script, /clock in early for tomorrow’s holiday/)
})

test('the chooser skips a used shift and prefers the next unused eligible schedule', async () => {
  const script = await read('scripts/attendance.js')

  assert.match(
    script,
    /const alreadyRecorded = recentAttendance\.some\(record =>[\s\S]*record\.schedule_id === schedule\.id && Boolean\(record\.clock_in\)/
  )
  assert.match(script, /return !alreadyRecorded && \[/)
  assert.match(script, /if \(selectedSchedule\(\)\) return attendanceForSelectedSchedule\(\)/)
})

test('clock-in RPC enforces completed today attendance for tomorrow special days', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /v_today_completed boolean := false/)
  assert.match(migration, /attendance_row\.work_date = v_local_date/)
  assert.match(migration, /attendance_row\.clock_out is not null/)
  assert.match(
    migration,
    /schedule\.shift_date = v_local_date \+ 1[\s\S]*and v_today_completed/
  )
  assert.match(
    migration,
    /v_schedule\.shift_date = v_local_date \+ 1[\s\S]*and v_today_completed/
  )
  assert.match(migration, /v_work_date := v_schedule\.shift_date/)
  assert.match(migration, /revoke all on function public\.workforce_clock_in\(uuid\) from public/)
  assert.match(migration, /grant execute on function public\.workforce_clock_in\(uuid\) to authenticated/)
})

test('attendance client remains valid JavaScript', () => {
  const result = spawnSync(process.execPath, ['--check', 'scripts/attendance.js'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8'
  })

  assert.equal(result.status, 0, result.stderr)
})
