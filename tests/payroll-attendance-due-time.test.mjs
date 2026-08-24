import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath = 'supabase/migrations/20260824125816_payroll_attendance_due_time.sql'

test('shared attendance due predicate uses canonical scheduled end and excludes non-attendance schedules', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /create or replace function public\.payroll_attendance_is_due\(/)
  assert.match(migration, /schedule\.shift_end <= coalesce\(p_as_of, statement_timestamp\(\)\)/)
  assert.match(migration, /schedule\.shift_end > schedule\.shift_start/)
  for (const field of ['is_leave', 'is_absent', 'is_rest_day', 'is_holiday']) {
    assert.match(migration, new RegExp(`schedule\\.${field} is false`))
  }
  assert.match(migration, /schedule\.shift_start is not null/)
  assert.match(migration, /schedule\.shift_end is not null/)
})

test('readiness and missing-attendance links use due time without changing scheduled-shift totals', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /payroll_get_period_employee_readiness_base\(uuid\)/)
  assert.match(migration, /payroll_attendance_is_due\(schedule\.id, statement_timestamp\(\)\)[\s\S]*not exists/)
  assert.match(migration, /scheduled-shift denominator|scheduled_shift_count/i)
  assert.match(migration, /payroll_get_period_missing_attendance_base\(uuid\)/)
  assert.match(migration, /Missing-attendance link function did not expose the expected due predicate/)
})

test('exception generation gates only missing attendance, preserving overlap and preplot controls', async () => {
  const migration = await read(migrationPath)
  const preplotMigration = await read('supabase/migrations/20260808103424_carry_forward_prepaid_not_blocking.sql')

  assert.match(migration, /from active_schedules as schedule[\s\S]*payroll_attendance_is_due\(schedule\.schedule_id, statement_timestamp\(\)\)[\s\S]*not exists/)
  assert.doesNotMatch(migration, /active_schedules as materialized[\s\S]*where public\.payroll_attendance_is_due/)
  assert.match(preplotMigration, /preplot_missing_payroll_approval/)
  assert.doesNotMatch(migration, /preplot_missing_payroll_approval[\s\S]*missing_attendance/)
})

test('import missing-attendance reporting uses the same due predicate without changing snapshot source selection', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /payroll_import_attendance\(uuid,uuid\)/)
  assert.match(migration, /Payroll import function did not expose the expected due predicate/)
  assert.match(migration, /payroll_attendance_is_due\(schedule\.id, statement_timestamp\(\)\)/)
  assert.doesNotMatch(migration, /insert into public\.payroll_attendance_snapshots/)
})

test('due-time cases use scheduled end, including overnight and prepaid schedules', () => {
  const due = ({ shiftStart, shiftEnd, asOf, isLeave = false, isAbsent = false, isRestDay = false, isHoliday = false }) => (
    !isLeave && !isAbsent && !isRestDay && !isHoliday &&
    shiftStart !== null && shiftEnd !== null && shiftEnd > shiftStart && shiftEnd <= asOf
  )

  assert.equal(due({ shiftStart: 10, shiftEnd: 18, asOf: 9 }), false)
  assert.equal(due({ shiftStart: 10, shiftEnd: 18, asOf: 14 }), false)
  assert.equal(due({ shiftStart: 10, shiftEnd: 18, asOf: 18 }), true)
  assert.equal(due({ shiftStart: 22, shiftEnd: 30, asOf: 23 }), false)
  assert.equal(due({ shiftStart: 22, shiftEnd: 30, asOf: 30 }), true)
  assert.equal(due({ shiftStart: 10, shiftEnd: 18, asOf: 17, isPrepaid: true }), false)
  assert.equal(due({ shiftStart: 10, shiftEnd: 18, asOf: 18, isPrepaid: true }), true)
  assert.equal(due({ shiftStart: 10, shiftEnd: 18, asOf: 20, isLeave: true }), false)
  assert.equal(due({ shiftStart: 10, shiftEnd: 18, asOf: 20, isAbsent: true }), false)
})
