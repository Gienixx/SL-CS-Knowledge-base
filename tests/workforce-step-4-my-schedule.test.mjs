import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('home exposes My Schedule to agents and authorized schedule managers', async () => {
  const [html, script] = await Promise.all([
    read('home.html'),
    read('scripts/home-workforce-nav.js')
  ])

  assert.match(html, /id="homeMyScheduleBtn"[^>]*href="\.\/my-schedule\.html"[^>]*hidden/)
  assert.match(script, /access\.is_agent\s*===\s*true/)
  assert.match(script, /hasWorkforcePermission\(access,\s*'manage_schedules'\)/)
  assert.match(script, /myScheduleButton\.hidden\s*=\s*!canViewSchedules/)
})

test('My Schedule provides calendar, list, changed-shift visibility, and details', async () => {
  const [html, script, styles] = await Promise.all([
    read('my-schedule.html'),
    read('scripts/my-schedule-v2.js'),
    read('styles/my-schedule.css')
  ])

  assert.match(html, /id="myScheduleCalendar"/)
  assert.match(html, /id="myScheduleScope"/)
  assert.match(html, /id="scheduleChangeNotice"/)
  assert.match(html, /id="myScheduleTableBody"/)
  assert.match(html, /id="myScheduleModal"/)
  assert.match(html, /scripts\/my-schedule-v2\.js/)
  assert.match(script, /schedule\.status\s*===\s*'changed'/)
  assert.match(script, /openScheduleDetails/)
  assert.match(styles, /\.schedule-entry\.changed/)
})

test('regular agents query only their linked published schedule records', async () => {
  const script = await read('scripts/my-schedule-v2.js')

  assert.match(script, /currentScope\(\)\s*===\s*'self'/)
  assert.match(script, /query\s*=\s*query\.in\('user_id',\s*personalProfileIds\)/)
  assert.match(script, /query\s*=\s*query\.in\('status',\s*RELEASED_STATUSES\)/)
  assert.match(script, /access\.is_agent\s*!==\s*true\s*&&\s*!canManageSchedules/)
})

test('team schedule scope is enabled only through manage_schedules and RLS-visible profiles', async () => {
  const [script, foundation] = await Promise.all([
    read('scripts/my-schedule-v2.js'),
    read('supabase/migrations-legacy/2026070601_workforce_foundation.sql')
  ])

  assert.match(script, /hasWorkforcePermission\(access,\s*'manage_schedules'\)/)
  assert.match(script, /canViewTeam\s*=\s*canManageSchedules\s*&&[\s\S]*profiles\.some\(profile\s*=>\s*!personalProfileIds\.includes\(profile\.user_id\)\)/)
  assert.match(script, /elements\.scope\.value\s*=\s*canViewTeam\s*\?\s*'team'\s*:\s*'self'/)
  assert.match(foundation, /workforce_can_view_user\(user_id,\s*'manage_schedules'\)/)
  assert.match(foundation, /workforce_can_manage_user\(user_id,\s*'manage_schedules'\)/)
})
