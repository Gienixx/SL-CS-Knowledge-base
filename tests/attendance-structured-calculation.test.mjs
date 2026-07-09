import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath = 'supabase/migrations/2026070901_attendance_structured_calculation.sql'

test('Step 9 adds one trusted structured attendance calculator', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /create or replace function public\.workforce_calculate_attendance\(/)
  for (const parameter of [
    'p_scheduled_start',
    'p_scheduled_end',
    'p_clock_in',
    'p_clock_out',
    'p_scheduled_work_date',
    'p_timezone'
  ]) {
    assert.match(migration, new RegExp(`\\b${parameter}\\b`))
  }

  for (const result of [
    'pre_shift_overtime_minutes',
    'regular_minutes',
    'post_shift_overtime_minutes',
    'total_overtime_minutes',
    'total_worked_minutes',
    'minutes_late',
    'undertime_minutes'
  ]) {
    assert.match(migration, new RegExp(`\\b${result}\\b`))
  }
})

test('calculator rejects invalid time data and preserves the schedule work date', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /Clock-out cannot be earlier than clock-in/)
  assert.match(migration, /Scheduled end must be later than scheduled start/)
  assert.match(migration, /valid IANA timezone/)
  assert.match(migration, /Scheduled start does not match the scheduled work date/)
  assert.match(migration, /Attendance work date must remain the linked schedule work date/)
  assert.match(migration, /Attendance cannot be calculated for overlapping scheduled shifts/)
})

test('Step 9 enforces one open session and aggregate 20-hour overtime', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /attendance_one_open_session_per_user_idx/)
  assert.match(migration, /Only one attendance session may remain open at a time/)
  assert.match(migration, /1200 - v_other_overtime_minutes/)
  assert.match(migration, /total_overtime_minutes <= 1200/)
  assert.match(migration, /workforce_recalculate_attendance_work_date/)
})

test('clock-in and clock-out delegate calculation to PostgreSQL', async () => {
  const migration = await read(migrationPath)

  const calls = migration.match(/return public\.workforce_recalculate_attendance\(v_result\.id\);/g) || []
  assert.equal(calls.length, 2)
  assert.match(migration, /create or replace function public\.workforce_clock_in/)
  assert.match(migration, /create or replace function public\.workforce_clock_out/)
  assert.doesNotMatch(migration, /v_raw_overtime_minutes/)
})

test('internal calculation functions are not exposed to browser roles', async () => {
  const migration = await read(migrationPath)

  for (const role of ['public', 'anon', 'authenticated']) {
    assert.match(
      migration,
      new RegExp(`revoke all on function public\\.workforce_recalculate_attendance\\(uuid\\) from ${role}`)
    )
  }

  assert.match(migration, /grant execute on function public\.workforce_clock_in\(uuid\) to authenticated/)
  assert.match(migration, /grant execute on function public\.workforce_clock_out\(\) to authenticated/)
})

test('Step 9 includes deployment verification and documentation', async () => {
  const verification = await read('supabase/verification/attendance_structured_calculation_check.sql')
  const documentation = await read('docs/workforce-step-9-attendance-calculations.md')

  assert.match(verification, /Every blocker query in section 5 must return zero rows/)
  assert.match(verification, /sum\(total_overtime_minutes\) > 1200/)
  assert.match(verification, /workforce_recalculate_attendance/)
  assert.match(documentation, /20-hour overtime ceiling/)
  assert.match(documentation, /America\/New_York/)
})
