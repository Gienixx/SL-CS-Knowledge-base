import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

function extractFunction(script, name) {
  const start = script.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} function is present`)
  const bodyStart = script.indexOf('{', start)
  let depth = 0
  for (let index = bodyStart; index < script.length; index += 1) {
    if (script[index] === '{') depth += 1
    if (script[index] === '}') {
      depth -= 1
      if (depth === 0) return script.slice(start, index + 1)
    }
  }
  throw new Error(`Could not extract ${name}`)
}

test('live clock renders a workforce-local date below the clock', async () => {
  const [html, script, styles] = await Promise.all([
    read('attendance.html'),
    read('scripts/attendance.js'),
    read('styles/attendance.css')
  ])
  const formatLiveClockDate = new Function(
    `${extractFunction(script, 'formatLiveClockDate')}; return formatLiveClockDate`
  )()

  assert.match(html, /id="attendanceLiveClockDate" class="attendance-live-clock-date"/)
  assert.match(html, /attendanceLiveClockDate[\s\S]*attendanceTimeZone/)
  assert.match(styles, /\.attendance-live-clock-date\s*\{[\s\S]*font-size:\s*\.78rem/)
  assert.equal(
    formatLiveClockDate(new Date('2026-08-19T14:07:33.000Z'), 'America/New_York'),
    'Wed, Aug 19, 2026'
  )
  assert.match(script, /elements\.liveClockDate\.textContent = formatLiveClockDate\(/)
  assert.match(script, /clockTimer = window\.setInterval\(updateLiveClock, 1000\)/)
})

test('live clock date rolls over at workforce midnight, independent of device timezone', async () => {
  const script = await read('scripts/attendance.js')
  const formatLiveClockDate = new Function(
    `${extractFunction(script, 'formatLiveClockDate')}; return formatLiveClockDate`
  )()

  assert.equal(
    formatLiveClockDate(new Date('2026-08-20T03:59:59.000Z'), 'America/New_York'),
    'Wed, Aug 19, 2026'
  )
  assert.equal(
    formatLiveClockDate(new Date('2026-08-20T04:00:00.000Z'), 'America/New_York'),
    'Thu, Aug 20, 2026'
  )
})

test('schedule labels and eligibility wiring remain separate from live-date rendering', async () => {
  const script = await read('scripts/attendance.js')
  const updateLiveClock = extractFunction(script, 'updateLiveClock')

  assert.match(script, /function relativeScheduleDateLabel\(workDate, now = new Date\(\)\)/)
  assert.match(script, /function scheduleAvailability\(schedule, now = new Date\(\)\)/)
  assert.match(script, /const scheduleClockInOpen = adminAssistMode[\s\S]*availability\.state === 'open'/)
  assert.doesNotMatch(updateLiveClock, /scheduleAvailability|scheduleClockInOpen|clockInButton\.disabled/)
})
