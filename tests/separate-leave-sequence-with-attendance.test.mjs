import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const migration = fs.readFileSync('supabase/migrations/20260810170000_allow_separate_leave_sequence_with_attendance.sql', 'utf8')

test('attended schedules remain protected from direct conversion', () => {
  assert.match(migration, /if v_schedule_type <> 'leave' then/)
  assert.match(migration, /A schedule with attendance cannot be changed to leave or absent/)
})

test('attended leave selection creates a separate next sequence', () => {
  assert.match(migration, /select coalesce\(max\(schedule\.shift_sequence\), 0\) \+ 1/)
  assert.match(migration, /separate_leave_sequence_created/)
  assert.match(migration, /is_leave, is_absent,/)
})

test('duplicate same-type leave is rejected and leave remains untimed', () => {
  assert.match(migration, /already has this leave type on the selected date/)
  assert.match(migration, /v_subtype, null, null, v_notes, null/)
})
