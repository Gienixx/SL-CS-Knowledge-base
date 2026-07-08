import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('attendance page loads the integrated shift-window client', async () => {
  const html = await read('attendance.html')

  assert.match(html, /scripts\/attendance\.js\?v=2/)
  assert.doesNotMatch(html, /attendance-clock-in-window\.js/)
  assert.match(html, /Active overnight shifts and multiple shifts on the same work date are supported/)
})

test('attendance client loads yesterday through tomorrow and applies the 15-minute window', async () => {
  const script = await read('scripts/attendance.js')

  assert.match(script, /EARLY_CLOCK_IN_WINDOW_MINUTES = 15/)
  assert.match(script, /rangeStart = offsetDateKey\(today, -1\)/)
  assert.match(script, /rangeEnd = offsetDateKey\(today, 1\)/)
  assert.match(script, /scheduleWindow\(schedule/)
  assert.match(script, /\['early', 'active'\]\.includes/)
  assert.match(script, /This shift is currently active\. You can clock in now\./)
})

test('database policy enforces early overtime and combines pre-shift and post-shift overtime', async () => {
  const migration = await read('supabase/migrations/2026070803_attendance_early_clock_in_overtime.sql')

  assert.match(migration, /interval '15 minutes'/)
  assert.match(migration, /v_clock_time < v_schedule\.shift_start - v_early_clock_in_window/)
  assert.match(migration, /v_early_overtime_minutes/)
  assert.match(migration, /v_post_shift_overtime_minutes/)
  assert.match(migration, /v_overtime_minutes := v_early_overtime_minutes \+ v_post_shift_overtime_minutes/)
})

test('latest attendance migration supports overnight and multiple shifts', async () => {
  const migration = await read('supabase/migrations/2026070805_attendance_overnight_multi_shift.sql')

  assert.match(migration, /drop constraint if exists attendance_user_work_date_unique/)
  assert.match(migration, /attendance_user_schedule_unique/)
  assert.match(migration, /schedule\.shift_date = v_local_date - 1/)
  assert.match(migration, /schedule\.shift_end > v_clock_time/)
  assert.match(migration, /You are already clocked in to another shift/)
  assert.match(migration, /This shift has already ended/)
})
