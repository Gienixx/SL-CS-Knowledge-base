import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('authorized schedule managers can view personal drafts through the canonical controller', async () => {
  const script = await read('scripts/my-schedule-v2.js')

  assert.match(script, /hasWorkforcePermission\(access,\s*'manage_schedules'\)/)
  assert.match(script, /query = query\.in\('user_id', personalProfileIds\)/)
  assert.match(script, /if \(!canManageSchedules\) \{\s*query = query\.in\('status', RELEASED_STATUSES\)/)
})

test('regular agents retain the released-status restriction', async () => {
  const script = await read('scripts/my-schedule-v2.js')

  assert.match(script, /const RELEASED_STATUSES = Object\.freeze\(\[/)
  assert.match(script, /'published'/)
  assert.match(script, /'changed'/)
  assert.match(script, /'cancelled'/)
  assert.match(script, /'completed'/)
  assert.match(script, /if \(!canManageSchedules\)/)
})

test('hidden scope controls remain hidden and draft entries receive distinct styling', async () => {
  const [html, styles] = await Promise.all([
    read('my-schedule.html'),
    read('styles/my-schedule.css')
  ])

  assert.match(html, /scripts\/my-schedule-v2\.js\?v=1/)
  assert.match(styles, /^\[hidden\]\{display:none!important\}/)
  assert.match(styles, /\.schedule-entry\.scheduled/)
})
