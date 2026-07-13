import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath = 'supabase/migrations/20260713150918_weekly_schedule_automation.sql'

test('weekly automation seeds only the Arby test account and New York template', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /Arby weekly schedule test/)
  assert.match(migration, /lower\(profile\.email\) = 'arby@eurekasurveys\.com'/)
  assert.match(migration, /America\/New_York/)
  assert.doesNotMatch(migration, /team_id,\s*true,\s*\(now\(\)/)
})

test('template matches the confirmed Sunday through Saturday schedule', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /\(v_template_id, 0, 1, null, null, 0, true\)/)
  assert.match(migration, /\(v_template_id, 1, 1, null, null, 0, true\)/)
  for (const weekday of [2, 3, 4, 5]) {
    assert.match(migration, new RegExp(`\\(v_template_id, ${weekday}, 1, time '10:00', time '18:00', 0, false\\)`))
  }
  assert.match(migration, /\(v_template_id, 6, 1, time '06:00', time '14:00', 0, false\)/)
})

test('generator publishes idempotently and excludes non-normal or inactive agents', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /profile\.employment_status = 'active'/)
  assert.match(migration, /profile\.base_role = 'agent'/)
  assert.match(migration, /profile\.is_agent is true/)
  assert.match(migration, /on conflict \(user_id, shift_date, shift_sequence\) do nothing/)
  assert.match(migration, /else 'published' end/)
})

test('admin overrides and approved leave are protected', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /workforce_mark_generated_schedule_override/)
  assert.match(migration, /new\.admin_override := true/)
  assert.match(migration, /leave_request\.status = 'approved'/)
  assert.match(migration, /automation_leave_cancelled = true/)
  assert.match(migration, /and not schedule\.admin_override/)
})

test('cron runs hourly on Sunday but generates only at 6 AM New York time', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /'0 \* \* \* 0'/)
  assert.match(migration, /now\(\) at time zone 'America\/New_York'/)
  assert.match(migration, /extract\(hour from v_local_now\)::integer <> 6/)
  assert.match(migration, /workforce_generate_weekly_schedules\(v_local_now::date\)/)
})
