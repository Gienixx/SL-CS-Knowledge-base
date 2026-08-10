import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath = 'supabase/migrations/20260810113000_friday_monday_week_schedule_automation.sql'

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
