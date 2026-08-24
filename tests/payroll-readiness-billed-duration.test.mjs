import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath = 'supabase/migrations/20260824143000_payroll_readiness_canonical_billed_duration.sql'

test('readiness uses canonical billed timestamps for duration validation', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /coalesce\(attendance_row\.billed_clock_in, attendance_row\.clock_in\)/)
  assert.match(migration, /coalesce\(attendance_row\.billed_clock_out, attendance_row\.clock_out\)/)
  assert.match(migration, /worked_minutes_unclassified/)
  assert.match(migration, /total_worked_mismatch/)
  assert.match(migration, /regular_minutes, 0\)[\s\S]*total_overtime_minutes, 0/)
  assert.doesNotMatch(migration, /update\s+public\.attendance/i)
  assert.doesNotMatch(migration, /insert\s+into\s+public\.attendance/i)
  assert.doesNotMatch(migration, /delete\s+from\s+public\.attendance/i)
})

test('stale total_worked_minutes is non-blocking when classified billed duration agrees', async () => {
  const migration = await read(migrationPath)
  const totalMismatch = migration.match(/when coalesce\(attendance_row\.billed_clock_in[\s\S]*?then 'total_worked_mismatch'/)?.[0] ?? ''

  assert.match(totalMismatch, /total_worked_minutes is distinct from/)
  assert.match(totalMismatch, /is distinct from floor\(/)
  assert.match(totalMismatch, /regular_minutes, 0\)[\s\S]*total_overtime_minutes, 0/)
})

test('valid overnight linkage is accepted while ordinary schedule-date mismatches remain blockers', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /schedule_row\.shift_date = attendance_row\.work_date - 1/)
  assert.match(migration, /schedule_row\.shift_end > schedule_row\.shift_start/)
  assert.match(migration, /schedule_row\.shift_end at time zone/)
  assert.match(migration, /then 'schedule_work_date_mismatch'/)
})

test('existing attendance protections remain in the readiness view', async () => {
  const migration = await read(migrationPath)

  for (const blocker of [
    'missing_clock_in',
    'missing_clock_out',
    'calculations_missing',
    'total_overtime_mismatch',
    'invalid_attendance_status',
    'review_required'
  ]) {
    assert.match(migration, new RegExp(`'${blocker}'`))
  }

  assert.match(migration, /attendance_row\.voided_at is null/)
  assert.match(migration, /review_status <> all \(array\['approved'::text, 'locked'::text\]\)/)
  assert.match(migration, /rest_day_overtime_minutes/)
  assert.match(migration, /holiday_overtime_minutes/)
})
