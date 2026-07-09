import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Home loads the workforce schedule calendar integration', async () => {
  const page = await read('home.html')

  assert.match(page, /home-workforce-calendar\.css\?v=2/)
  assert.match(page, /home-workforce-calendar\.js\?v=3/)
  assert.match(page, /id="homeUpcomingEyebrow"/)
  assert.match(page, /id="homeUpcomingTitle"/)
  assert.match(page, />My shift</)
  assert.match(page, />Rest day</)
  assert.match(page, />Holiday</)
})

test('Home schedule calendar loads only the current agent schedule scope', async () => {
  const script = await read('scripts/home-workforce-calendar.js')

  assert.match(script, /loadCurrentWorkforceAccess/)
  assert.match(script, /state\.access\.is_agent !== true/)
  assert.match(script, /linked_profile_ids/)
  assert.match(script, /\.from\('work_schedules'\)/)
  assert.match(script, /\.in\('user_id', state\.profileIds\)/)
  assert.match(script, /RELEASED_SCHEDULE_STATUSES/)
  assert.doesNotMatch(script, /\.insert\(/)
  assert.doesNotMatch(script, /\.update\(/)
  assert.doesNotMatch(script, /\.delete\(/)
})

test('Home calendar matches My Schedule draft visibility for schedule administrators', async () => {
  const script = await read('scripts/home-workforce-calendar.js')

  assert.match(script, /hasWorkforcePermission\(state\.access, 'manage_schedules'\)/)
  assert.match(script, /if \(!state\.canManageSchedules\)/)
  assert.match(script, /query = query\.in\('status', RELEASED_SCHEDULE_STATUSES\)/)
})

test('Home calendar reflects shifts, rest days, holidays, and multiple entries', async () => {
  const script = await read('scripts/home-workforce-calendar.js')

  assert.match(script, /return `\$\{schedules\.length\} entries`/)
  assert.match(script, /return 'Rest day'/)
  assert.match(script, /return 'Holiday'/)
  assert.match(script, /work-rest-day/)
  assert.match(script, /work-holiday/)
  assert.match(script, /work-changed/)
  assert.match(script, /work-cancelled/)
})

test('Home upcoming events are populated from My Schedule', async () => {
  const script = await read('scripts/home-workforce-calendar.js')

  assert.match(script, /refreshUpcomingSchedules/)
  assert.match(script, /UPCOMING_LOOKAHEAD_DAYS = 90/)
  assert.match(script, /UPCOMING_SCHEDULE_LIMIT = 5/)
  assert.match(script, /document\.getElementById\('upcomingEventList'\)/)
  assert.match(script, /Upcoming schedule/)
  assert.match(script, /createUpcomingScheduleCard/)
  assert.match(script, /schedule\.notes/)
  assert.match(script, /STATUS_LABELS/)
})

test('Home upcoming schedule excludes completed, cancelled, and ended shifts', async () => {
  const script = await read('scripts/home-workforce-calendar.js')

  assert.match(script, /schedule\.status === 'cancelled' \|\| schedule\.status === 'completed'/)
  assert.match(script, /new Date\(schedule\.shift_end\)\.getTime\(\) > now\.getTime\(\)/)
  assert.match(script, /\.slice\(0, UPCOMING_SCHEDULE_LIMIT\)/)
})

test('Home schedule entries link back to My Schedule', async () => {
  const script = await read('scripts/home-workforce-calendar.js')

  assert.match(script, /window\.location\.href = '\.\/my-schedule\.html'/)
  assert.match(script, /card\.href = '\.\/my-schedule\.html'/)
  assert.match(script, /My Schedule:/)
  assert.match(script, /button\.title = details/)
})

test('Home workforce calendar script has valid JavaScript syntax', () => {
  const result = spawnSync(process.execPath, ['--check', 'scripts/home-workforce-calendar.js'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8'
  })

  assert.equal(result.status, 0, result.stderr)
})
