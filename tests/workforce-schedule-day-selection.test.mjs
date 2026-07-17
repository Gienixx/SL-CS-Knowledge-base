import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const html = await readFile(new URL('../workforce.html', import.meta.url), 'utf8')
const client = await readFile(new URL('../scripts/workforce-schedules.js', import.meta.url), 'utf8')

test('create schedule first asks for a one-day or one-week schedule', () => {
  assert.match(html, /id="scheduleTypeModal"/)
  assert.match(html, /data-schedule-type="day"[\s\S]*1 Day Schedule/)
  assert.match(html, /data-schedule-type="week"[\s\S]*1 Week Schedule/)
  assert.match(client, /createButton\.addEventListener\('click', openScheduleTypeModal\)/)
  assert.match(client, /function chooseScheduleType\(scheduleType\)/)
})

test('one-day mode uses one date and one-week mode uses a date range', () => {
  assert.match(client, /scheduleDateField\.hidden = scheduleType === 'week'/)
  assert.match(client, /scheduleRangeFields\.hidden = scheduleType !== 'week'/)
  assert.doesNotMatch(html, /scheduleDaysFieldset|name="scheduleDay"/)
})

test('one-week mode provides a bounded From and To date range', () => {
  assert.match(html, /id="scheduleFromDate" type="date"/)
  assert.match(html, /id="scheduleToDate" type="date"/)
  assert.match(client, /scheduleToDate\.value = addDays\(anchorDate, 6\)/)
  assert.match(client, /datesInRange\(fromDate, toDate\)/)
  assert.match(client, /A 1-week schedule can cover a maximum of 7 days\./)
})

test('new weekly schedules are saved for every day in the date range', () => {
  assert.match(client, /function datesInRange\(fromDate, toDate\)/)
  assert.match(client, /for \(let date = fromDate; date <= toDate; date = addDays\(date, 1\)\)/)
  assert.match(client, /for \(const targetDate of scheduleDates\)/)
  assert.match(client, /p_shift_date: targetDate/)
})

test('shift start and end use time-only inputs and support overnight shifts', () => {
  assert.match(html, /id="scheduleStart" type="time"/)
  assert.match(html, /id="scheduleEnd" type="time"/)
  assert.doesNotMatch(html, /id="schedule(?:Start|End)" type="datetime-local"/)
  assert.match(client, /const targetEndDate = endTime <= startTime \? addDays\(targetDate, 1\) : targetDate/)
  assert.match(client, /zonedDateTimeToIso\(`\$\{targetDate\}T\$\{startTime\}`/)
})
