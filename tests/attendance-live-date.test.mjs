import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'

const page = await fs.readFile(new URL('../attendance.html', import.meta.url), 'utf8')
const script = await fs.readFile(new URL('../scripts/attendance.js', import.meta.url), 'utf8')
const styles = await fs.readFile(new URL('../styles/attendance.css', import.meta.url), 'utf8')

test('Attendance renders the live date below the clock and above the timezone', () => {
  assert.match(page, /attendanceLiveClockDate/)
  assert.match(page, /attendanceLiveClockPeriod[\s\S]*attendanceLiveClockDate[\s\S]*attendanceTimeZone/)
  assert.match(styles, /\.attendance-live-clock-date[\s\S]*font-size: \.78rem/)
})

test('live date uses the live clock timestamp and configured timezone', () => {
  assert.match(script, /liveClockDate: document\.getElementById\('attendanceLiveClockDate'\)/)
  assert.match(script, /elements\.liveClockDate\.textContent = new Intl\.DateTimeFormat\('en-US'/)
  assert.match(script, /timeZone: access\?\.timezone \|\| 'America\/New_York'/)
  assert.match(script, /weekday: 'short'[\s\S]*month: 'short'[\s\S]*day: 'numeric'[\s\S]*year: 'numeric'/)
  assert.match(script, /elements\.liveClockDate\.textContent[\s\S]*elements\.liveClock\.dateTime = now\.toISOString\(\)/)
})
