import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

function extractFunction(script, name, nextName) {
  const start = script.indexOf(`function ${name}(`)
  const end = script.indexOf(`function ${nextName}(`, start)
  assert.ok(start >= 0, `could not find ${name}`)
  assert.ok(end >= 0, `could not find ${nextName} after ${name}`)
  return script.slice(start, end).trim()
}

test('Attendance schedule labels use workforce-local Today/Yesterday/Tomorrow dates', async () => {
  const script = await read('scripts/attendance.js')
  const localDateKey = extractFunction(script, 'localDateKey', 'relativeScheduleDateLabel')
  const relativeLabel = extractFunction(script, 'relativeScheduleDateLabel', 'formatScheduleDateLabel')
  const offsetDateKey = extractFunction(script, 'offsetDateKey', 'localDateKey')
  const parseDateKey = extractFunction(script, 'parseDateKey', 'offsetDateKey')

  const labelFor = new Function(
    'access',
    `${parseDateKey}\n${offsetDateKey}\n${localDateKey}\n${relativeLabel}\nreturn relativeScheduleDateLabel`
  )({ timezone: 'America/New_York' })

  // In UTC this instant is Aug 19, but in the workforce timezone it is still
  // Aug 18. Device timezone must not decide which schedule is labeled Today.
  const now = new Date('2026-08-19T03:30:00Z')
  assert.equal(new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(now), '2026-08-19')
  assert.equal(labelFor('2026-08-18', now), 'Today')
  assert.equal(labelFor('2026-08-17', now), 'Yesterday')
  assert.equal(labelFor('2026-08-19', now), 'Tomorrow')
})

test('Attendance prepends relative labels without changing schedule option content or selection wiring', async () => {
  const script = await read('scripts/attendance.js')

  assert.match(script, /function relativeScheduleDateLabel\(workDate, now = new Date\(\)\)/)
  assert.match(script, /timeZone: access\?\.timezone \|\| 'America\/New_York'/)
  assert.match(script, /const relativeDateLabel = relativeScheduleDateLabel\(schedule\.shift_date, now\)/)
  assert.match(script, /return \[\s*relativeDateLabel,\s*baseLabel/)
  assert.match(script, /scheduleOptionLabel\(schedule, availability, \{[\s\S]*now\s*\n\s*\}\)/)
  assert.match(script, /option\.disabled = adminAssistMode \? hasAttendance : availability\.state === 'ended'/)
  assert.match(script, /formatScheduleDateLabel\(activeLocalDate, now\)/)
})
