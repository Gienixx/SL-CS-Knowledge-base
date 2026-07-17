import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const html = await readFile(new URL('../workforce.html', import.meta.url), 'utf8')
const client = await readFile(new URL('../scripts/workforce-schedules.js', import.meta.url), 'utf8')

test('create schedule opens one consolidated event-style form', () => {
  assert.doesNotMatch(html, /id="scheduleTypeModal"/)
  assert.match(client, /createButton\.addEventListener\('click', \(\) => openSchedule\(\)\)/)
  assert.match(html, /<span>Start Date<\/span>[\s\S]*id="scheduleDate" type="date"/)
  assert.match(html, /<span>Start Time<\/span>[\s\S]*id="scheduleStart" type="time"/)
  assert.match(html, /id="scheduleEndDateLabel">End Date \(same as start\)<\/span>[\s\S]*id="scheduleToDate" type="date"/)
  assert.match(html, /<span>End Time<\/span>[\s\S]*id="scheduleEnd" type="time"/)
})

test('schedule frequency supports all shell creation modes', () => {
  assert.match(html, /id="scheduleFrequency"[\s\S]*value="one">One day/)
  assert.match(html, /value="range">Multiple days \(range\)/)
  assert.match(html, /value="weekdays">Weekdays \(Mon–Fri\)/)
  assert.match(html, /value="custom">Custom days/)
  assert.match(client, /scheduleFrequency\.addEventListener\('change', updateScheduleFrequency\)/)
  assert.match(client, /if \(isOneDay\) scheduleToDate\.value = startDate/)
})

test('range modes provide start and end dates with custom weekday controls', () => {
  assert.match(html, /id="scheduleToDate" type="date"/)
  assert.match(html, /id="scheduleDayPicker"[^>]*hidden/)
  assert.equal((html.match(/name="scheduleDay"/g) || []).length, 7)
  assert.match(client, /scheduleDayPicker\.hidden = !showDays/)
  assert.match(client, /mode === 'weekdays'/)
})

test('new schedules are filtered by frequency and saved across the resulting dates', () => {
  assert.match(client, /function datesInRange\(fromDate, toDate\)/)
  assert.match(client, /function scheduleDatesForFrequency\(fromDate, toDate\)/)
  assert.match(client, /for \(let date = fromDate; date <= toDate; date = addDays\(date, 1\)\)/)
  assert.match(client, /weekday >= 1 && weekday <= 5/)
  assert.match(client, /selectedDays\.has\(parseDateKey\(date\)\.getUTCDay\(\)\)/)
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

test('description and required schedule settings remain available', () => {
  assert.match(html, /<span>Description<\/span>[\s\S]*id="scheduleNotes"/)
  assert.match(html, /<summary>Schedule settings<\/summary>/)
  assert.match(html, /id="scheduleSequence"/)
  assert.match(html, /id="scheduleTimezone"/)
  assert.match(html, /id="scheduleStatus"/)
})
