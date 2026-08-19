import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath = 'supabase/migrations/20260731065252_allow_next_day_special_schedule_clock_in.sql'

test('Attendance enables tomorrow special-day schedules after today is completed', async () => {
  const page = await read('attendance.html')
  const script = await read('scripts/attendance.js')

   assert.match(page, /scripts\/attendance\.js\?v=26/)
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

test('agent clock-in uses explicit work schedule labels and excludes leave schedules', async () => {
  const [page, script] = await Promise.all([
    read('attendance.html'),
    read('scripts/attendance.js')
  ])

  assert.match(page, /Available shift or work date \(America\/New_York\)/)
  assert.match(script, /visibleSchedules = todaySchedules\.filter\(schedule => !schedule\.is_leave && !schedule\.is_absent\)/)
  assert.match(script, /formatScheduleOptionLabel\(schedule, access\?\.timezone\)/)
  assert.match(script, /displayedSchedules\.length === 1/)
  assert.match(script, /new Option\('Select a schedule', SCHEDULE_PLACEHOLDER\)/)
  assert.match(script, /schedule_id === schedule\.id/)
  assert.match(script, /Work Schedule · Sequence \$\{displaySchedule\.shift_sequence \|\| 1\}/)
  assert.match(script, /shift_sequence, shift_start, shift_end/)
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

test('same-day additional unscheduled sessions stay separate and pending', async () => {
  const migration = await read('supabase/migrations/20260813173636_allow_additional_unscheduled_attendance_session.sql')
  const script = await read('scripts/attendance.js')
  assert.match(script, /Additional work session · Needs review/)
  assert.match(script, /No assigned second shift found\. Clock in as an additional work session for admin review\./)
  assert.match(migration, /v_has_completed_session/)
  assert.match(migration, /and not v_has_completed_session/)
  assert.match(migration, /a\.clock_in is null/)
  assert.match(migration, /review_status, created_by, updated_by/)
  assert.match(migration, /'pending', v_auth_user_id, v_auth_user_id/)
})

test('attendance client remains valid JavaScript', () => {
  const result = spawnSync(process.execPath, ['--check', 'scripts/attendance.js'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8'
  })

  assert.equal(result.status, 0, result.stderr)
})
