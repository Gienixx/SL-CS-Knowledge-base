import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const LIVE_TIMEZONE_FILES = [
  'attendance.html',
  'workforce.html',
  'scripts/attendance.js',
  'scripts/my-schedule-v2.js',
  'scripts/team-attendance.js',
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
  const migration = await read('supabase/migrations-legacy/2026070802_workforce_timezone_new_york.sql')

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

test('team attendance converts datetime-local values as New York wall-clock time', async () => {
  const source = await read('scripts/team-attendance.js')

  assert.match(source, /const WORKFORCE_TIMEZONE = 'America\/New_York'/)
  assert.match(source, /function dateTimeLocalToIso\(value\)/)
  assert.match(source, /p_clock_in: dateTimeLocalToIso\(clockIn\)/)
  assert.match(source, /p_new_clock_in: dateTimeLocalToIso\(newClockIn\)/)
  assert.doesNotMatch(source, /new Date\(clockIn\)\.toISOString\(\)/)
})

test('sitewide timezone migration normalizes records, functions, defaults, and constraints', async () => {
  const migration = await read('supabase/migrations/20260714110701_standardize_america_new_york_timezone.sql')
  const verification = await read('supabase/verification/america_new_york_sitewide_check.sql')

  for (const table of [
    'profiles',
    'work_schedules',
    'work_schedule_templates',
    'daily_operations_metrics',
    'google_calendar_connections',
    'sheet_sync_metadata'
  ]) {
    assert.match(migration, new RegExp(`(?:alter table|update) public\\.${table}`))
  }
  assert.match(migration, /pg_get_functiondef/)
  assert.match(migration, /timezone_new_york_check/)
  assert.match(verification, /where value is distinct from 'America\/New_York'/)
})
