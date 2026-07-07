import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('dashboard exposes My Schedule to agents and authorized schedule managers', async () => {
  const [html, script] = await Promise.all([
    read('dashboard.html'),
    read('scripts/dashboard.js')
  ])

  assert.match(html, /id="myScheduleBtn"[^>]*href="\.\/my-schedule\.html"[^>]*style="display:none;"/)
  assert.match(script, /access\.is_agent\s*===\s*true/)
  assert.match(script, /hasWorkforcePermission\(access,\s*'manage_schedules'\)/)
  assert.match(script, /myScheduleBtn\.style\.display/)
})

test('My Schedule provides calendar, list, changed-shift visibility, and details', async () => {
  const [html, script, styles] = await Promise.all([
    read('my-schedule.html'),
    read('scripts/my-schedule.js'),
    read('styles/my-schedule.css')
  ])

  assert.match(html, /id="myScheduleCalendar"/)
  assert.match(html, /id="myScheduleScope"/)
  assert.match(html, /id="scheduleChangeNotice"/)
  assert.match(html, /id="myScheduleTableBody"/)
  assert.match(html, /id="myScheduleModal"/)
  assert.match(script, /status\s*===\s*'changed'/)
  assert.match(script, /openScheduleDetails/)
  assert.match(styles, /\.schedule-entry\.changed/)
})

test('regular agents query only their own published schedule records', async () => {
  const script = await read('scripts/my-schedule.js')

  assert.match(script, /currentScope\(\)\s*===\s*'self'/)
  assert.match(script, /\.eq\('user_id',\s*access\.user_id\)/)
  assert.match(script, /\.in\('status',\s*\['published',\s*'changed',\s*'cancelled',\s*'completed'\]\)/)
  assert.match(script, /access\.is_agent\s*!==\s*true\s*&&\s*!canManageSchedules/)
})

test('team schedule scope is enabled only through manage_schedules and RLS-visible profiles', async () => {
  const [script, foundation] = await Promise.all([
    read('scripts/my-schedule.js'),
    read('supabase/migrations/2026070601_workforce_foundation.sql')
  ])

  assert.match(script, /hasWorkforcePermission\(access,\s*'manage_schedules'\)/)
  assert.match(script, /profiles\.some\(profile\s*=>\s*profile\.user_id\s*!==\s*access\.user_id\)/)
  assert.match(script, /scopeSelect\.value\s*===\s*'team'/)
  assert.match(foundation, /workforce_can_view_user\(user_id,\s*'manage_schedules'\)/)
  assert.match(foundation, /workforce_can_manage_user\(user_id,\s*'manage_schedules'\)/)
})
