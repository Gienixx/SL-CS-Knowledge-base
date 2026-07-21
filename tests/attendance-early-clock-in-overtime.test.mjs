import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('attendance page loads the unrestricted pre-shift client', async () => {
  const html = await read('attendance.html')

  assert.match(html, /scripts\/attendance\.js\?v=4/)
  assert.doesNotMatch(html, /attendance-clock-in-window\.js/)
  assert.match(html, /Clock-in is available before a published or changed shift/)
  assert.match(html, /20 hours in total per scheduled work date/)
})

test('attendance client loads yesterday through tomorrow without a 15-minute gate', async () => {
  const script = await read('scripts/attendance.js')

  assert.doesNotMatch(script, /EARLY_CLOCK_IN_WINDOW_MINUTES/)
  assert.doesNotMatch(script, /state: 'future'/)
  assert.match(script, /rangeStart = offsetDateKey\(today, -1\)/)
  assert.match(script, /rangeEnd = offsetDateKey\(today, 1\)/)
  assert.match(script, /if \(nowMs < startsAt\.getTime\(\)\) return \{ state: 'early'/)
  assert.match(script, /\['early', 'active'\]\.includes/)
  assert.match(script, /subject to the 20-hour work-date limit/)
})

test('latest database policy removes the early lower bound and caps work-date overtime', async () => {
  const migration = await read('supabase/migrations-legacy/2026070806_attendance_unrestricted_pre_shift_overtime_cap.sql')

  assert.doesNotMatch(migration, /interval '15 minutes'/)
  assert.doesNotMatch(migration, /v_clock_time < v_schedule\.shift_start/)
  assert.match(migration, /v_max_overtime_minutes constant integer := 1200/)
  assert.match(migration, /v_raw_pre_shift_overtime_minutes/)
  assert.match(migration, /v_post_shift_overtime_minutes/)
  assert.match(migration, /v_raw_overtime_minutes := v_pre_shift_overtime_minutes \+ v_post_shift_overtime_minutes/)
  assert.match(migration, /v_credited_overtime_minutes := least/)
  assert.match(migration, /attendance_row\.work_date = v_existing\.work_date/)
  assert.match(migration, /clock_out_remains_allowed_after_limit/)
})

test('latest attendance policy preserves overnight and multiple-shift safeguards', async () => {
  const migration = await read('supabase/migrations-legacy/2026070806_attendance_unrestricted_pre_shift_overtime_cap.sql')
  const multiShiftMigration = await read('supabase/migrations-legacy/2026070805_attendance_overnight_multi_shift.sql')

  assert.match(multiShiftMigration, /drop constraint if exists attendance_user_work_date_unique/)
  assert.match(multiShiftMigration, /attendance_user_schedule_unique/)
  assert.match(migration, /schedule\.shift_date between v_local_date - 1 and v_local_date \+ 1/)
  assert.match(migration, /pg_advisory_xact_lock/)
  assert.match(migration, /You are already clocked in to another shift/)
  assert.match(migration, /This shift has already ended/)
})
