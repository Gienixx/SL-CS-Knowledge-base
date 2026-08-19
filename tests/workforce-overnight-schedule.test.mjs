import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { isOvernightShift, scheduleEndDate } from '../scripts/workforce-schedule-times.js'

const migration = await readFile(new URL(
  '../supabase/migrations/20260818193224_normalize_overnight_template_offsets.sql',
  import.meta.url
), 'utf8')
const weeklyMigration = await readFile(new URL(
  '../supabase/migrations/20260810063228_friday_monday_week_schedule_automation.sql',
  import.meta.url
), 'utf8')
const schedulesClient = await readFile(new URL('../scripts/workforce-schedules.js', import.meta.url), 'utf8')

test('21:00 to 05:00 uses the next-day end date', () => {
  assert.equal(isOvernightShift('21:00', '05:00'), true)
  assert.equal(scheduleEndDate('2026-08-18', '21:00', '05:00'), '2026-08-19')
})

test('09:00 to 17:00 keeps the same-day end date', () => {
  assert.equal(isOvernightShift('09:00', '17:00'), false)
  assert.equal(scheduleEndDate('2026-08-18', '09:00', '17:00'), '2026-08-18')
})

test('changing a daytime shift into overnight recalculates the end date', () => {
  const startDate = '2026-08-18'
  assert.equal(scheduleEndDate(startDate, '09:00', '17:00'), startDate)
  assert.equal(scheduleEndDate(startDate, '21:00', '05:00'), '2026-08-19')
  assert.match(schedulesClient, /input\.addEventListener\('input', updateScheduleFrequency\)/)
})

test('changing an overnight shift back to daytime restores the same-day end date', () => {
  const startDate = '2026-08-18'
  assert.equal(scheduleEndDate(startDate, '21:00', '05:00'), '2026-08-19')
  assert.equal(scheduleEndDate(startDate, '09:00', '17:00'), startDate)
})

test('weekly-template overnight schedules normalize and use the next-day offset', () => {
  assert.match(migration, /set end_day_offset = 1/)
  assert.match(migration, /where not is_rest_day[\s\S]*and end_time < start_time[\s\S]*and end_day_offset <> 1/)
  assert.doesNotMatch(migration, /when end_time > start_time then 0/)
  assert.match(migration, /if not new\.is_rest_day and new\.end_time < new\.start_time/)
  assert.doesNotMatch(migration, /new\.end_time > new\.start_time/)
  assert.match(migration, /work_schedule_template_days_normalize_offset/)
  assert.match(weeklyMigration, /v_shift_date \+ v_day\.end_day_offset/)
  assert.match(schedulesClient, /const targetEndDate = scheduleEndDate\(targetDate, startTime, endTime\)/)
  assert.match(schedulesClient, /zonedDateTimeToIso\(`\$\{targetEndDate\}T\$\{endTime\}`, timezone\)/)
  assert.match(schedulesClient, /p_shift_end: targetEnd/)
})

test('schedule management labels the workforce work date and complete overnight interval', async () => {
  const page = await readFile(new URL('../workforce.html', import.meta.url), 'utf8')
  assert.match(page, /Work Date \(America\/New_York\)/)
  assert.match(page, /shift intervals below use the workforce timezone: <strong>America\/New_York<\/strong>/)
  assert.match(schedulesClient, /if \(startDate !== endDate\)/)
  assert.match(schedulesClient, /dateTimeFormatter\.format\(start\)/)
  assert.match(schedulesClient, /dateTimeFormatter\.format\(end\)/)
})
