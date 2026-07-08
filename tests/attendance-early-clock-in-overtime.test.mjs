import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('attendance page loads the early clock-in window guard', async () => {
  const html = await read('attendance.html')

  assert.match(html, /scripts\/attendance-clock-in-window\.js/)
  assert.match(html, /15 minutes before your published or changed shift/)
})

test('clock-in window guard blocks the browser before the allowed window', async () => {
  const script = await read('scripts/attendance-clock-in-window.js')

  assert.match(script, /EARLY_CLOCK_IN_WINDOW_MINUTES = 15/)
  assert.match(script, /clockInOpens = shiftStart - EARLY_CLOCK_IN_WINDOW_MINUTES/)
  assert.match(script, /clockWindowBlocked/)
  assert.match(script, /Early clock-in minutes are recorded as overtime/)
})

test('database policy enforces the window and combines pre-shift and post-shift overtime', async () => {
  const migration = await read('supabase/migrations/2026070803_attendance_early_clock_in_overtime.sql')

  assert.match(migration, /interval '15 minutes'/)
  assert.match(migration, /v_clock_time < v_schedule\.shift_start - v_early_clock_in_window/)
  assert.match(migration, /v_early_overtime_minutes/)
  assert.match(migration, /v_post_shift_overtime_minutes/)
  assert.match(migration, /v_overtime_minutes := v_early_overtime_minutes \+ v_post_shift_overtime_minutes/)
  assert.match(migration, /status not in \('published', 'changed'\)/)
})
