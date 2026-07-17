import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const html = await readFile(new URL('../workforce.html', import.meta.url), 'utf8')
const client = await readFile(new URL('../scripts/workforce-schedules.js', import.meta.url), 'utf8')

test('create schedule offers all seven selectable weekdays', () => {
  assert.match(html, /id="scheduleDaysFieldset"/)
  assert.equal((html.match(/name="scheduleDay"/g) || []).length, 7)
  for (let day = 0; day <= 6; day += 1) {
    assert.match(html, new RegExp(`name="scheduleDay" value="${day}"`))
  }
})

test('new schedules are saved for each selected day in the shift-date week', () => {
  assert.match(client, /function selectedScheduleDates\(shiftDate\)/)
  assert.match(client, /const weekSunday = addDays\(shiftDate, -shiftWeekday\)/)
  assert.match(client, /for \(const targetDate of scheduleDates\)/)
  assert.match(client, /p_shift_date: targetDate/)
  assert.match(client, /Select at least one day to load the schedule\./)
})

test('bulk day selection is limited to create mode', () => {
  assert.match(client, /const scheduleDates = scheduleId \? \[shiftDate\] : selectedScheduleDates\(shiftDate\)/)
  assert.match(client, /scheduleDaysFieldset\.hidden = true/)
})
