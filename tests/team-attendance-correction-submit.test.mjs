import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

function functionSource(script, name, signature) {
  const source = script.match(new RegExp(`function ${name}\\(${signature}\\) \\{[\\s\\S]*?\\n\\}`))?.[0]
  assert.ok(source, `${name} should remain independently testable`)
  return source
}

test('correction submit handles a valid overnight billed correction', async () => {
  const [script, page] = await Promise.all([
    read('scripts/team-attendance.js'),
    read('team-attendance.html')
  ])
  const timezoneSource = functionSource(script, 'timezoneOffsetMilliseconds', 'timestamp')
  const dateTimeSource = functionSource(script, 'dateTimeLocalToIso', 'value')
  const errorMessageSource = functionSource(script, 'errorMessage', 'error')
  const validationSource = functionSource(script, 'correctionValidationMessage', '[\\s\\S]*?')
  const validate = Function(
    `const WORKFORCE_TIMEZONE = 'America/New_York'\n${errorMessageSource}\n${timezoneSource}\n${dateTimeSource}\n${validationSource}\nreturn correctionValidationMessage`
  )()
  const toIso = Function(
    `const WORKFORCE_TIMEZONE = 'America/New_York'\n${timezoneSource}\n${dateTimeSource}\nreturn dateTimeLocalToIso`
  )()

  assert.equal(validate({
    attendanceId: 'attendance-1',
    newClockIn: '2026-08-16T15:00',
    newClockOut: '2026-08-17T06:00',
    reasonCode: 'system_issue',
    reasonNotes: 'System issue confirmed.',
    billedTimeChanged: true,
    scheduleChanged: true
  }), '')
  assert.equal(toIso('2026-08-16T15:00'), '2026-08-16T19:00:00.000Z')
  assert.equal(toIso('2026-08-17T06:00'), '2026-08-17T10:00:00.000Z')
  assert.equal(toIso('2026-08-17T19:00'), '2026-08-17T23:00:00.000Z')
  assert.match(page, /id="teamAttendanceCorrectionForm" class="wf-form" novalidate/)
  assert.match(page, /New · America\/New_York/)
  assert.match(page, /Work date \(America\/New_York\)/)
  assert.match(page, /teamAttendanceCorrectionScheduleWarning/)
  assert.match(page, /teamAttendanceCorrectionZeroOverlapConfirm/)
  assert.doesNotMatch(page, /id="teamAttendanceCorrectionSubmit"[^>]*disabled/)
  assert.match(script, /void handleCorrectionSubmit\(correctionMessage\)/)
  assert.match(script, /supabase\.rpc\(rpcName, rpcParams\)/)
  const correctionHandler = script.match(/async function handleCorrectionSubmit\([\s\S]*?\r?\n\}\r?\n\r?\nasync function initialize/)?.[0]
  assert.ok(correctionHandler, 'correction submit handler should remain independently inspectable')
  assert.doesNotMatch(correctionHandler, /deleteForm/)
})

test('correction validation reports invalid or reversed billed timestamps', async () => {
  const script = await read('scripts/team-attendance.js')
  const timezoneSource = functionSource(script, 'timezoneOffsetMilliseconds', 'timestamp')
  const dateTimeSource = functionSource(script, 'dateTimeLocalToIso', 'value')
  const errorMessageSource = functionSource(script, 'errorMessage', 'error')
  const validationSource = functionSource(script, 'correctionValidationMessage', '[\\s\\S]*?')
  const validate = Function(
    `const WORKFORCE_TIMEZONE = 'America/New_York'\n${errorMessageSource}\n${timezoneSource}\n${dateTimeSource}\n${validationSource}\nreturn correctionValidationMessage`
  )()

  const base = {
    attendanceId: 'attendance-1',
    reasonCode: 'system_issue',
    reasonNotes: 'System issue confirmed.',
    billedTimeChanged: true,
    scheduleChanged: false
  }
  assert.equal(validate({
    ...base,
    newClockIn: '2026-08-17T06:00',
    newClockOut: '2026-08-16T15:00'
  }), 'Billed clock-out cannot be earlier than billed clock-in.')
  assert.equal(validate({
    ...base,
    newClockIn: 'not-a-date',
    newClockOut: '2026-08-17T06:00'
  }), 'Enter a valid date and time.')
})

test('correction warns on a one-day workforce-date mismatch and previews the expected overnight classification', async () => {
  const script = await read('scripts/team-attendance.js')
  const sources = [
    functionSource(script, 'timezoneOffsetMilliseconds', 'timestamp'),
    functionSource(script, 'toDateTimeLocal', 'value'),
    functionSource(script, 'dateTimeLocalToIso', 'value'),
    functionSource(script, 'parseDateKey', 'value'),
    functionSource(script, 'shiftIsoByWorkforceDays', 'timestamp, days'),
    functionSource(script, 'intervalOverlapMinutes', 'clockInIso, clockOutIso, schedule'),
    functionSource(script, 'correctionScheduleAnalysis', '[\\s\\S]*?'),
    functionSource(script, 'correctionClassificationPreview', '[\\s\\S]*?')
  ].join('\n')
  const helpers = Function(`const WORKFORCE_TIMEZONE = 'America/New_York'\n${sources}\nreturn { correctionScheduleAnalysis, correctionClassificationPreview }`)()
  const schedule = {
    shift_start: '2026-08-18T01:00:00.000Z',
    shift_end: '2026-08-18T09:00:00.000Z'
  }

  const mismatch = helpers.correctionScheduleAnalysis({
    clockInIso: '2026-08-16T23:00:00.000Z',
    clockOutIso: '2026-08-17T14:00:00.000Z',
    schedule
  })
  assert.equal(mismatch.overlapMinutes, 0)
  assert.equal(mismatch.likelyMismatch, true)
  assert.equal(mismatch.likelyMismatchDays, 1)
  assert.equal(mismatch.likelyMismatchOverlapMinutes, 480)
  assert.equal(mismatch.requiresConfirmation, true)

  const expected = helpers.correctionScheduleAnalysis({
    clockInIso: '2026-08-17T23:00:00.000Z',
    clockOutIso: '2026-08-18T14:00:00.000Z',
    schedule
  })
  assert.equal(expected.overlapMinutes, 480)
  assert.equal(expected.requiresConfirmation, false)
  assert.deepEqual(helpers.correctionClassificationPreview({
    clockInIso: '2026-08-17T23:00:00.000Z',
    clockOutIso: '2026-08-18T14:00:00.000Z',
    schedule
  }), {
    regularMinutes: 480,
    preShiftMinutes: 120,
    postShiftMinutes: 300,
    totalMinutes: 900
  })
})
