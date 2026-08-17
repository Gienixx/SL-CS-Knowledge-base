import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('schedule labels use existing work_schedules fields and include date/type/sequence', async () => {
  const [helper, attendance, team] = await Promise.all([
    read('shared/schedule-labels.js'),
    read('scripts/attendance.js'),
    read('scripts/team-attendance.js')
  ])

  assert.match(helper, /shift_date/)
  assert.match(helper, /Work Schedule/)
  assert.match(helper, /Open Schedule/)
  assert.match(helper, /Paid Leave/)
  assert.match(helper, /shift_sequence/)
  assert.doesNotMatch(attendance, /schedule_type|schedule_name/)
  assert.doesNotMatch(team, /\.select\([^\n]*schedule_type|\.select\([^\n]*schedule_name/)
  assert.match(team, /formatScheduleOptionLabel\(schedule, WORKFORCE_TIMEZONE\)/)
})
