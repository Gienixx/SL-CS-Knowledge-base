import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('manual schedule creation has no operational status selector and defaults to Published', async () => {
  const [html, entry] = await Promise.all([
    read('workforce.html'),
    read('scripts/workforce-schedules-entry.js')
  ])

  assert.match(html, /Schedules are Published automatically\./)
  assert.doesNotMatch(html, /id="scheduleStatus"/)
  assert.match(html, /workforce-schedules-entry\.js\?v=\d+/)
  assert.match(entry, /workforce-schedules\.js\?v=\d+/)
})

test('editing a Published schedule retains Published and records Changed separately', async () => {
  const [script, migration] = await Promise.all([
    read('scripts/workforce-schedules.js'),
    read('supabase/migrations/20260820153000_simplify_workforce_schedule_status_model.sql')
  ])

  assert.match(script, /const status = 'published'/)
  assert.match(migration, /add column if not exists changed_at timestamptz/)
  assert.match(migration, /new\.status := 'published'/)
})

test('authorized schedule managers default to Team schedule scope', async () => {
  const script = await read('scripts/my-schedule-v2.js')

  assert.match(script, /canViewTeam = canManageSchedules/)
  assert.match(script, /elements\.scope\.value = canViewTeam \? 'team' : 'self'/)
  assert.match(script, /elements\.scope\.addEventListener\('change'/)
})
