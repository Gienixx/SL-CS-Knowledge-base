import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath = 'supabase/migrations/20260810063228_friday_monday_week_schedule_automation.sql'

const addDays = (date, days) => {
  const result = new Date(`${date}T00:00:00Z`)
  result.setUTCDate(result.getUTCDate() + days)
  return result.toISOString().slice(0, 10)
}

const nextMonday = date => {
  const result = new Date(`${date}T00:00:00Z`)
  const isoDay = result.getUTCDay() === 0 ? 7 : result.getUTCDay()
  result.setUTCDate(result.getUTCDate() + (8 - isoDay))
  return result.toISOString().slice(0, 10)
}

const generatedDate = (monday, templateWeekday) =>
  addDays(monday, (templateWeekday + 6) % 7)

test('Friday automation targets the upcoming Monday-Sunday week', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /8 - extract\(isodow from v_local_today\)/)
  assert.match(migration, /extract\(isodow from v_week_start\).*<> 1/s)
  assert.match(migration, /v_shift_date := v_week_start \+ \(\(v_day\.weekday \+ 6\) % 7\)/)
  assert.match(migration, /extract\(isodow from v_local_now\).*<> 5/s)
  assert.match(migration, /'0 \* \* \* 5'/)
})

test('weekly generation remains idempotent and preserves edited schedules', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /on conflict \(user_id, shift_date, shift_sequence\) do nothing/)
  assert.match(migration, /generated_by_automation, admin_override/)
  assert.match(migration, /schedule_template_id, generated_by_automation, admin_override/)
  assert.match(migration, /p_week_start date default null/)
})

test('Friday is the only required cron day, not Saturday', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /extract\(isodow from v_local_now\)::integer <> 5/s)
  assert.match(migration, /'0 \* \* \* 5'/)
  assert.doesNotMatch(migration, /extract\(isodow from v_local_now\)::integer <> 6/)
  assert.doesNotMatch(migration, /'0 \* \* \* 6'/)
})

test('Monday-based generation covers Monday through Sunday and excludes the prior Sunday', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /Weekly schedule generation must start on a Monday/)
  assert.match(migration, /v_shift_date := v_week_start \+ \(\(v_day\.weekday \+ 6\) % 7\)/)

  const monday = nextMonday('2026-08-20')
  assert.equal(monday, '2026-08-24')
  assert.deepEqual(
    Array.from({ length: 7 }, (_, weekday) => generatedDate(monday, weekday)).sort(),
    ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30']
  )
  assert.equal(generatedDate(monday, 0), '2026-08-30')
  assert.ok(!Array.from({ length: 7 }, (_, weekday) => generatedDate(monday, weekday)).includes('2026-08-23'))
})

test('week calculation crosses month and year boundaries correctly', () => {
  assert.equal(nextMonday('2026-08-31'), '2026-09-07')
  assert.equal(generatedDate('2026-08-31', 0), '2026-09-06')
  assert.equal(nextMonday('2026-12-31'), '2027-01-04')
  assert.equal(generatedDate('2027-01-04', 0), '2027-01-10')
})

test('overnight schedules retain the start-day work date and next-day end offset', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /v_shift_start := make_timestamptz\([\s\S]*?extract\(year from v_shift_date\)::integer[\s\S]*?v_day\.start_time/s)
  assert.match(migration, /v_shift_date \+ v_day\.end_day_offset/)
  assert.match(migration, /on conflict \(user_id, shift_date, shift_sequence\) do nothing/)
})

test('Rest Day generation remains untimed and the trigger contract is unchanged', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /if v_day\.is_rest_day then[\s\S]*?v_shift_start := null;[\s\S]*?v_shift_end := null;/s)
  assert.match(migration, /v_local_now timestamp := now\(\) at time zone 'America\/New_York'/)
  assert.match(migration, /extract\(isodow from v_local_now\)::integer <> 5/s)
  assert.match(migration, /extract\(hour from v_local_now\)::integer <> 6/s)
  assert.match(migration, /'0 \* \* \* 5'/)
  assert.match(migration, /return public\.workforce_generate_weekly_schedules\(\);/)
})
