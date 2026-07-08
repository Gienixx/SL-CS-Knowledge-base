import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath = 'supabase/migrations/2026070807_attendance_review_storage.sql'

test('Step 8 migration adds every required attendance storage field', async () => {
  const migration = await read(migrationPath)

  for (const column of [
    'original_clock_in',
    'original_clock_out',
    'pre_shift_overtime_minutes',
    'regular_minutes',
    'post_shift_overtime_minutes',
    'total_overtime_minutes',
    'total_worked_minutes',
    'is_corrected',
    'review_status',
    'reviewed_by',
    'reviewed_at'
  ]) {
    assert.match(migration, new RegExp(`add column if not exists ${column}\\b`))
  }
})

test('review states and structured minute constraints are database enforced', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /attendance_review_status_check/)
  assert.match(migration, /review_status in \('pending', 'approved', 'corrected', 'rejected', 'locked'\)/)
  assert.match(migration, /attendance_review_metadata_pair_check/)
  assert.match(migration, /attendance_structured_minutes_nonnegative/)
  assert.match(migration, /attendance_original_clock_order_check/)
  assert.match(migration, /validate constraint attendance_review_status_check/)
})

test('original timestamps are captured once and protected from later changes', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /create or replace function public\.workforce_prepare_attendance_storage\(\)/)
  assert.match(migration, /new\.original_clock_in := new\.clock_in/)
  assert.match(migration, /new\.original_clock_out := new\.clock_out/)
  assert.match(migration, /original_clock_in is immutable after capture/)
  assert.match(migration, /original_clock_out is immutable after capture/)
  assert.match(migration, /before insert or update on public\.attendance/)
})

test('legacy and structured overtime totals remain compatible before Step 9', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /attendance_total_overtime_legacy_match/)
  assert.match(migration, /total_overtime_minutes = overtime_minutes/)
  assert.match(migration, /v_legacy_overtime_changed/)
  assert.match(migration, /v_total_overtime_changed/)
  assert.match(migration, /new\.total_overtime_minutes := coalesce\(new\.overtime_minutes, 0\)/)
  assert.match(migration, /new\.overtime_minutes := new\.total_overtime_minutes/)
})

test('historical records are preserved without inventing component splits', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /Do not fabricate historical pre\/post/)
  assert.match(migration, /historical_structured_recalculation_pending_step_9/)
  assert.doesNotMatch(migration, /set pre_shift_overtime_minutes =/)
  assert.doesNotMatch(migration, /set post_shift_overtime_minutes =/)
  assert.match(migration, /total_worked_minutes = case/)
})

test('Step 8 has a database verification script', async () => {
  const verification = await read('supabase/verification/attendance_review_storage_check.sql')

  assert.match(verification, /Expected: 11 rows/)
  assert.match(verification, /Every query below should return zero rows/)
  assert.match(verification, /records_pending_structured_recalculation/)
  assert.match(verification, /attendance_review_storage_added/)
})
