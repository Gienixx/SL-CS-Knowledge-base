import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('authorized schedule managers bypass only the personal released-status filter', async () => {
  const entry = await read('scripts/my-schedule-entry.js')

  assert.match(entry, /hasWorkforcePermission\(access,\s*'manage_schedules'\)/)
  assert.match(entry, /table !== 'work_schedules'/)
  assert.match(entry, /column === 'status'/)
  assert.match(entry, /RELEASED_STATUSES\.every/)
  assert.match(entry, /return this/)
  assert.match(entry, /await import\('\.\/my-schedule\.js\?v=1'\)/)
})

test('regular agents retain the existing released-status restriction', async () => {
  const [entry, schedule] = await Promise.all([
    read('scripts/my-schedule-entry.js'),
    read('scripts/my-schedule.js')
  ])

  assert.match(entry, /if \(canManageSchedules\) \{\s*enableManagerDraftVisibility\(\)/)
  assert.match(schedule, /\.in\('status',\s*\['published',\s*'changed',\s*'cancelled',\s*'completed'\]\)/)
})

test('hidden scope controls remain hidden and draft entries receive distinct styling', async () => {
  const [html, styles] = await Promise.all([
    read('my-schedule.html'),
    read('styles/my-schedule.css')
  ])

  assert.match(html, /scripts\/my-schedule-entry\.js\?v=1/)
  assert.match(styles, /^\[hidden\]\{display:none!important\}/)
  assert.match(styles, /\.schedule-entry\.scheduled/)
})
