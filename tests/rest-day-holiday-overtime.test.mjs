import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath = 'supabase/migrations-legacy/2026070906_rest_day_holiday_overtime.sql'

test('attendance page allows released rest-day and holiday schedules', async () => {
  const page = await read('attendance.html')
  const script = await read('scripts/attendance.js')

  assert.match(page, /Rest-day work is recorded as RDOT/)
  assert.match(page, /holiday work is recorded as overtime/)
  assert.match(script, /schedule\.is_rest_day/)
  assert.match(script, /schedule\.is_holiday/)
  assert.match(script, /\['special', 'early', 'active'\]/)
  assert.doesNotMatch(script, /Clock-in is disabled/)
  assert.doesNotMatch(script, /every\(schedule => schedule\.is_rest_day\)/)
})

test('agent attendance displays RDOT separately from normal overtime', async () => {
  const script = await read('scripts/attendance.js')

  assert.match(script, /rest_day_overtime_minutes/)
  assert.match(script, /holiday_overtime_minutes/)
  assert.match(script, /\['RDOT', restDayOvertime\]/)
  assert.match(script, /\['OT', normalOvertime\]/)
  assert.match(script, /Rest-day overtime/)
  assert.match(script, /Holiday overtime/)
})

test('attendance script remains valid JavaScript', () => {
  const result = spawnSync(process.execPath, ['--check', 'scripts/attendance.js'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8'
  })

  assert.equal(result.status, 0, result.stderr)
})

test('migration adds special-day overtime storage and total validation', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /add column if not exists rest_day_overtime_minutes integer not null default 0/)
  assert.match(migration, /add column if not exists holiday_overtime_minutes integer not null default 0/)
  assert.match(migration, /total_overtime_minutes =[\s\S]*rest_day_overtime_minutes[\s\S]*holiday_overtime_minutes/)
  assert.match(migration, /total_overtime_minutes <= 1200/)
})

test('rest day takes precedence over holiday without double counting', async () => {
  const migration = await read(migrationPath)
  const calculator = migration.match(
    /create or replace function public\.workforce_calculate_attendance\([\s\S]*?p_is_holiday boolean[\s\S]*?\n\$\$;/
  )?.[0] || ''

  assert.match(calculator, /if coalesce\(p_is_rest_day, false\) then/)
  assert.match(calculator, /rest_day_overtime_minutes := v_credited_special_minutes/)
  assert.match(calculator, /else[\s\S]*holiday_overtime_minutes := v_credited_special_minutes/)
  assert.match(calculator, /total_overtime_minutes := v_credited_special_minutes/)
})

test('clock-in RPC accepts special work dates and preserves released-schedule enforcement', async () => {
  const migration = await read(migrationPath)
  const clockIn = migration.match(
    /create or replace function public\.workforce_clock_in\([\s\S]*?\n\$\$;/
  )?.[0] || ''

  assert.match(clockIn, /v_schedule\.is_rest_day or v_schedule\.is_holiday/)
  assert.match(clockIn, /v_schedule\.status not in \('published', 'changed'\)/)
  assert.match(clockIn, /Rest-day and holiday clock-in is available only on the scheduled work date/)
  assert.match(clockIn, /A released shift or special work date is available/)
  assert.match(clockIn, /workforce_recalculate_attendance\(v_result\.id\)/)
})

test('special-day calculation stays within the aggregate work-date overtime limit', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /1200 - v_other_overtime_minutes/)
  assert.match(migration, /least\([\s\S]*total_worked_minutes,[\s\S]*v_available_overtime_minutes/)
  assert.match(migration, /workforce_recalculate_attendance_work_date/)
})

test('preflight audits and normalizes only legacy unclassified overtime', async () => {
  const preflight = await read('supabase/maintenance/rest_day_holiday_overtime_preflight.sql')

  assert.match(preflight, /pre_shift_overtime_minutes is null/)
  assert.match(preflight, /regular_minutes is null/)
  assert.match(preflight, /post_shift_overtime_minutes is null/)
  assert.match(preflight, /legacy_unclassified_overtime_normalized/)
  assert.match(preflight, /before_data/)
  assert.match(preflight, /total_overtime_minutes = 0/)
  assert.match(preflight, /overtime_minutes = 0/)
  assert.match(preflight, /Legacy unclassified overtime remains after normalization/)
})

test('verification covers RDOT, holiday OT, precedence, and blockers', async () => {
  const verification = await read('supabase/verification/rest_day_holiday_overtime_check.sql')

  assert.match(verification, /Rest day: all 480 minutes must be RDOT/)
  assert.match(verification, /Holiday: all 480 minutes must be normal holiday overtime/)
  assert.match(verification, /Rest day plus holiday/)
  assert.match(verification, /Every blocker query in section 5 must return zero rows/)
  assert.match(verification, /having sum\(total_overtime_minutes\) > 1200/)
  assert.match(verification, /timestamptz,timestamptz,timestamptz,timestamptz/)
})
