import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('new schedules default to Published while Scheduled is clearly identified as a draft', async () => {
  const [html, entry] = await Promise.all([
    read('workforce.html'),
    read('scripts/workforce-schedules-entry.js')
  ])

  assert.match(html, /option value="scheduled">Scheduled \(draft — hidden from agents\)<\/option>/)
  assert.match(html, /option value="published" selected>Published \(visible to agent\)<\/option>/)
  assert.match(html, /workforce-schedules-entry\.js\?v=1/)
  assert.match(entry, /const isNewSchedule = !scheduleId\?\.value/)
  assert.match(entry, /scheduleStatus\.value = 'published'/)
})

test('editing an existing draft preserves its stored status until an administrator publishes it', async () => {
  const entry = await read('scripts/workforce-schedules-entry.js')

  assert.match(entry, /if \(isNewSchedule\) \{/)
  assert.doesNotMatch(entry, /scheduleId\?\.value\s*&&[\s\S]*scheduleStatus\.value = 'published'/)
})

test('authorized schedule managers default to Team schedule scope', async () => {
  const entry = await read('scripts/my-schedule-entry.js')

  assert.match(entry, /function enableDefaultTeamScope/)
  assert.match(entry, /scope\.value = 'team'/)
  assert.match(entry, /scope\.dispatchEvent\(new Event\('change'/)
  assert.match(entry, /if \(canManageSchedules\)/)
})
