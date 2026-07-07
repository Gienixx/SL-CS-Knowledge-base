import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('My Schedule resolves linked workforce identities from authenticated email and name', async () => {
  const script = await read('scripts/my-schedule-v2.js')

  assert.match(script, /function resolvePersonalProfileIds\(\)/)
  assert.match(script, /profile\.user_id === access\.user_id/)
  assert.match(script, /profileEmail === accessEmail/)
  assert.match(script, /profileLocalPart === accessLocalPart/)
  assert.match(script, /firstName\(profileName\) === accessLocalPart/)
  assert.match(script, /ids\.add\(access\.user_id\)/)
})

test('personal schedule queries all resolved profile IDs without exposing team scope', async () => {
  const script = await read('scripts/my-schedule-v2.js')

  assert.match(script, /currentScope\(\) === 'self'/)
  assert.match(script, /query = query\.in\('user_id', personalProfileIds\)/)
  assert.match(script, /if \(!canManageSchedules\) \{\s*query = query\.in\('status', RELEASED_STATUSES\)/)
})

test('authorized managers still default to Team schedule and can switch to linked My schedule', async () => {
  const script = await read('scripts/my-schedule-v2.js')

  assert.match(script, /canViewTeam = canManageSchedules/)
  assert.match(script, /elements\.scope\.value = canViewTeam \? 'team' : 'self'/)
  assert.match(script, /personalProfileIds\.length > 1/)
  assert.match(script, /linked workforce identities were checked/)
})

test('My Schedule page loads the canonical identity controller', async () => {
  const html = await read('my-schedule.html')
  assert.match(html, /scripts\/my-schedule-v2\.js\?v=1/)
  assert.doesNotMatch(html, /scripts\/my-schedule-entry\.js/)
})
