import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const LIVE_TIMEZONE_FILES = [
  'attendance.html',
  'workforce.html',
  'scripts/attendance.js',
  'scripts/my-schedule-v2.js',
  'scripts/team-management.js',
  'scripts/workforce-schedules.js',
  'scripts/workforce.js',
  'shared/workforce-access.js'
]

test('live workforce interfaces default to America/New_York', async () => {
  for (const path of LIVE_TIMEZONE_FILES) {
    const source = await read(path)
    assert.match(source, /America\/New_York/, `${path} should use America/New_York`)
    assert.doesNotMatch(source, /Asia\/Manila/, `${path} should not retain the Manila fallback`)
  }
})

test('timezone migration updates data defaults and preserves schedule wall times', async () => {
  const migration = await read('supabase/migrations/2026070802_workforce_timezone_new_york.sql')

  assert.match(migration, /alter table public\.profiles[\s\S]*default 'America\/New_York'/)
  assert.match(migration, /alter table public\.work_schedules[\s\S]*default 'America\/New_York'/)
  assert.match(migration, /shift_start at time zone 'Asia\/Manila'/)
  assert.match(migration, /at time zone 'America\/New_York'/)
  assert.match(migration, /function public\.workforce_normalize_timezone_default\(\)/)
  assert.match(migration, /profiles_normalize_timezone_default/)
  assert.match(migration, /work_schedules_normalize_timezone_default/)
})

test('timezone verification checks defaults, records, triggers, and audit entry', async () => {
  const verification = await read('supabase/verification/workforce_timezone_check.sql')

  assert.match(verification, /information_schema\.columns/)
  assert.match(verification, /where timezone = 'Asia\/Manila'/)
  assert.match(verification, /information_schema\.triggers/)
  assert.match(verification, /workforce_timezone_changed/)
})
