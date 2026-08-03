import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL(
  '../supabase/migrations/20260803114212_correct_almar_july_schedule_from_timesheet.sql',
  import.meta.url
), 'utf8')

test('Almar July 30 and 31 schedules use the approved workbook login and logout values', () => {
  assert.match(migration, /date '2026-07-30'[\s\S]*make_timestamptz\(2026, 7, 30, 10, 15, 0, 'America\/New_York'\)[\s\S]*make_timestamptz\(2026, 7, 31, 4, 15, 0, 'America\/New_York'\)/)
  assert.match(migration, /date '2026-07-31'[\s\S]*make_timestamptz\(2026, 7, 31, 9, 0, 0, 'America\/New_York'\)[\s\S]*make_timestamptz\(2026, 8, 1, 3, 0, 0, 'America\/New_York'\)/)
  assert.match(migration, /'source_row', v_target\.source_row/)
  assert.match(migration, /'source_columns', 'E:F \(LOG IN \/ LOG OUT\)'/)
  assert.match(migration, /949d4e4547f92829a3a631e8d7b4712e45fedeac8a1ad14245cdcd231b47d590/)
})

test('the correction is guarded, audited, and preserves attendance punches', () => {
  assert.match(migration, /v_almar_user_id constant uuid/)
  assert.match(migration, /lower\(profile\.full_name\) like 'almar%contreras%'/)
  assert.match(migration, /schedule\.shift_sequence = 1/)
  assert.match(migration, /schedule % changed after validation; refusing to overwrite it/)
  assert.match(migration, /attendance_row\.review_status = 'locked'/)
  assert.match(migration, /perform public\.workforce_recalculate_attendance\(v_attendance_id\)/)
  assert.doesNotMatch(migration, /update public\.attendance\s+set[\s\S]*(clock_in|clock_out)/i)
  assert.match(migration, /'timesheet_schedule_correction'/)
  assert.match(migration, /without changing attendance punches/)
})
