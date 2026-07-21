import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Home loads the workforce schedule calendar integration', async () => {
  const page = await read('home.html')

  assert.match(page, /class="sidebar-link" href="\.\/dashboard\.html" title="Analytics"/)
  assert.doesNotMatch(page, /Open full analytics|analytics-cta/)
  assert.match(page, /home-workforce-calendar\.css\?v=3/)
  assert.match(page, /home-workforce-calendar\.js\?v=5/)
  assert.match(page, /<h2 id="homeUpcomingTitle">Upcoming Events<\/h2>/)
  assert.doesNotMatch(page, /homeUpcomingEyebrow/)
  assert.match(page, />My shift</)
  assert.match(page, />Rest day</)
  assert.match(page, />Holiday</)
})

test('Current-month calendar dates are stronger than adjacent-month dates', async () => {
  const styles = await read('styles/home.css')

  assert.match(styles, /\.calendar-day \{[\s\S]*?color: var\(--home-navy\);[\s\S]*?font-weight: 750;/)
  assert.match(styles, /\.calendar-day\.muted \{[\s\S]*?color: #aeb5c1;[\s\S]*?opacity: 0\.42;[\s\S]*?filter: grayscale\(1\) blur\(0\.12px\);/)
})

test('Home removes sample content and keeps only configured recurring events', async () => {
  const homeScript = await read('scripts/home.js')
  const workforceScript = await read('scripts/home-workforce-calendar.js')
  const recurringScript = await read('scripts/home-recurring-events.js')

  assert.doesNotMatch(homeScript, /Daily CS Operations Huddle|Zendesk Data Review|Sample:/)
  assert.match(homeScript, /home-empty-table-cell[^']*None/)
  assert.match(homeScript, /function renderCalendar\(\)/)
  assert.match(homeScript, /recurringTeamEventsForMonth\(year, month\)/)
  assert.match(workforceScript, /home-schedule-empty/)
  assert.match(workforceScript, /empty\.innerHTML = '<strong>None<\/strong>'/)
  assert.doesNotMatch(workforceScript, /No upcoming schedule entries/)
  assert.match(recurringScript, /title: 'Team huddle'/)
  assert.match(recurringScript, /time: '10:30 AM – 11:00 AM'/)
  assert.match(recurringScript, /title: 'CS sync'/)
  assert.match(recurringScript, /time: '11:00 AM – 12:00 PM'/)
  assert.match(recurringScript, /title: 'Cashouts and Tickets process alignment'/)
  assert.match(recurringScript, /title: 'Monthly report deadline'/)
  assert.match(recurringScript, /thursdayNumber === 1/)
})

test('Recurring events cover the monthly deadline and every Thursday schedule', async () => {
  const { recurringTeamEventsForMonth } = await import('../scripts/home-recurring-events.js')
  const september = recurringTeamEventsForMonth(2026, 8)
  const october = recurringTeamEventsForMonth(2026, 9)

  assert.deepEqual(
    september.filter(event => event.date <= '2026-09-03').map(event => `${event.date} ${event.title}`),
    [
      '2026-09-01 Monthly report deadline',
      '2026-09-03 Cashouts and Tickets process alignment',
      '2026-09-03 Team huddle',
      '2026-09-03 CS sync'
    ]
  )
  assert.deepEqual(
    september.filter(event => event.date >= '2026-09-10').map(event => event.date),
    ['2026-09-10', '2026-09-10', '2026-09-17', '2026-09-17', '2026-09-24', '2026-09-24']
  )
  assert.deepEqual(
    october.filter(event => event.date >= '2026-10-08').map(event => event.date),
    ['2026-10-08', '2026-10-08', '2026-10-15', '2026-10-15', '2026-10-22', '2026-10-22', '2026-10-29', '2026-10-29']
  )
  assert.equal(october.filter(event => event.date === '2026-10-01').length, 4)
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
  assert.match(script, /createUpcomingScheduleCard/)
  assert.match(script, /schedule\.notes/)
})

test('Home upcoming events hide Published and mark completed entries with a check', async () => {
  const script = await read('scripts/home-workforce-calendar.js')
  const metaFunction = script.match(
    /function upcomingScheduleMeta\(schedule\) \{[\s\S]*?\n\}/
  )?.[0] || ''

  assert.match(script, /if \(schedule\.status === 'completed'\) return true/)
  assert.match(script, /card\.classList\.add\('completed'\)/)
  assert.match(metaFunction, /details\.push\('✓ Completed'\)/)
  assert.match(metaFunction, /schedule\.status === 'changed' \|\| schedule\.status === 'scheduled'/)
  assert.doesNotMatch(metaFunction, /Published/)
  assert.doesNotMatch(metaFunction, /STATUS_LABELS\[schedule\.status\] \|\| schedule\.status/)
})

test('Home upcoming events exclude cancelled and ended incomplete shifts', async () => {
  const script = await read('scripts/home-workforce-calendar.js')

  assert.match(script, /schedule\.status === 'cancelled'/)
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
