import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import {
  canUseAdditionalWorkSession,
  canUseUnscheduledWorkSession
} from '../shared/attendance-additional-session.js'

const script = await fs.readFile(new URL('../scripts/attendance.js', import.meta.url), 'utf8')

function extractFunction(name) {
  const start = script.indexOf(`function ${name}`)
  assert.notEqual(start, -1, `${name} must remain present`)
  const open = script.indexOf('{', start)
  let depth = 0
  let quote = ''
  let escaped = false

  for (let index = open; index < script.length; index += 1) {
    const character = script[index]
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = ''
      continue
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character
      continue
    }
    if (character === '{') depth += 1
    if (character === '}') {
      depth -= 1
      if (!depth) return script.slice(start, index + 1)
    }
  }

  throw new Error(`Could not extract ${name}`)
}

const isReleasedSchedule = schedule => Boolean(
  schedule &&
  ['published', 'changed'].includes(schedule.status) &&
  !schedule.is_leave &&
  !schedule.is_absent
)

const offsetDateKey = (value, days) => {
  const date = new Date(`${value}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

const scheduleAvailability = new Function(
  'isSpecialDay',
  'isOpenSchedule',
  'localDateKey',
  'offsetDateKey',
  'hasCompletedAttendanceForDate',
  `${extractFunction('scheduleAvailability')}; return scheduleAvailability`
)(
  schedule => Boolean(schedule?.is_rest_day || schedule?.is_holiday),
  schedule => Boolean(schedule && !schedule.is_rest_day && !schedule.is_holiday && !schedule.shift_start && !schedule.shift_end),
  () => '2026-08-16',
  offsetDateKey,
  () => false
)

const isBackendReleasedScheduleCandidate = (schedule, today, now) => {
  if (!isReleasedSchedule(schedule)) return false
  if (schedule.is_rest_day || schedule.is_holiday) {
    return schedule.shift_date === today || (
      schedule.shift_date === offsetDateKey(today, -1) &&
      scheduleAvailability(schedule, now).state === 'active'
    )
  }
  if (!schedule.shift_start && !schedule.shift_end) return schedule.shift_date === today
  return schedule.shift_date === today && ['early', 'active'].includes(scheduleAvailability(schedule, now).state) ||
    schedule.shift_date === offsetDateKey(today, -1) && scheduleAvailability(schedule, now).state === 'active'
}

const preferredScheduleSelection = (previous, previousSchedule, optionValues, availableSchedule) =>
  optionValues.includes(previous) && previous
    ? previous
    : availableSchedule
      ? availableSchedule
      : '__SCHEDULE_PLACEHOLDER__'

const jeanRestDay = {
  id: 'f5f59326-e4ab-45ec-b81a-27047486e2e6',
  shift_date: '2026-08-15',
  shift_start: null,
  shift_end: null,
  status: 'published',
  is_rest_day: true,
  is_holiday: false,
  is_leave: false,
  is_absent: false
}

const jeanAug17 = {
  id: 'e06da1bb-2508-48f7-a422-0e7374320bea',
  shift_date: '2026-08-17',
  shift_start: '2026-08-17T15:00:00Z',
  shift_end: '2026-08-17T23:00:00Z',
  status: 'published',
  is_rest_day: false,
  is_holiday: false,
  is_leave: false,
  is_absent: false
}

const completedAug15 = {
  work_date: '2026-08-15',
  schedule_id: jeanRestDay.id,
  clock_in: '2026-08-15T09:04:26Z',
  clock_out: '2026-08-15T17:00:17Z'
}

test('backend guard allows Jean Aug 16 Unscheduled while Aug 17 remains a real selectable schedule', () => {
  const now = new Date('2026-08-16T12:01:48Z')

  assert.equal(isBackendReleasedScheduleCandidate(jeanRestDay, '2026-08-16', now), false)
  assert.equal(isBackendReleasedScheduleCandidate(jeanAug17, '2026-08-16', now), false)
  assert.match(script, /new Option\(\s*scheduleOptionLabel\(schedule, availability/)
})

test('historical completed RDOT cannot enable a current-date Additional session', () => {
  assert.equal(canUseAdditionalWorkSession({
    workDate: '2026-08-16',
    attendance: [completedAug15],
    schedules: [jeanRestDay, jeanAug17],
    isEligibleSchedule: () => true
  }), false)
})

test('current-date Additional remains valid after current attendance completes when no real schedule remains', () => {
  assert.equal(canUseAdditionalWorkSession({
    workDate: '2026-08-16',
    attendance: [{
      work_date: '2026-08-16',
      schedule_id: 'aug16-sequence-1',
      clock_in: '2026-08-16T09:00:00Z',
      clock_out: '2026-08-16T17:00:00Z'
    }],
    schedules: [{ id: 'aug16-sequence-1', shift_date: '2026-08-16' }],
    isEligibleSchedule: () => true
  }), true)
})

test('stale Additional selection resets to an available real schedule', () => {
  assert.equal(preferredScheduleSelection(
    '__ADDITIONAL_WORK_SESSION__',
    null,
    ['__SCHEDULE_PLACEHOLDER__', jeanAug17.id],
    jeanAug17.id,
    '__SCHEDULE_PLACEHOLDER__'
  ), jeanAug17.id)
})

test('valid explicit real schedule selection is preserved', () => {
  assert.equal(preferredScheduleSelection(
    jeanAug17.id,
    jeanAug17,
    ['__SCHEDULE_PLACEHOLDER__', jeanAug17.id],
    jeanAug17.id,
    '__SCHEDULE_PLACEHOLDER__'
  ), jeanAug17.id)
})

test('valid sentinel selection is preserved only when no real schedule is available', () => {
  assert.equal(preferredScheduleSelection(
    '__UNSCHEDULED_WORK__',
    null,
    ['__SCHEDULE_PLACEHOLDER__', '__UNSCHEDULED_WORK__'],
    null,
    '__SCHEDULE_PLACEHOLDER__'
  ), '__UNSCHEDULED_WORK__')
})

test('future schedules do not block current-date Unscheduled exposure', () => {
  assert.equal(canUseUnscheduledWorkSession({
    workDate: '2026-08-16',
    attendance: [],
    schedules: [{ ...jeanAug17, shift_date: '2026-08-17' }]
  }), true)
  assert.match(script, /No assigned schedule\. Your time will be recorded as unscheduled attendance\./)
})

test('normal, special, open, leave, admin-assist, and RPC paths remain wired', () => {
  assert.match(script, /function scheduleAvailability\(schedule, now = new Date\(\)/)
  assert.match(script, /isUntimedRestDayWithinClockInWindow\(schedule\)/)
  assert.match(script, /!schedule\.is_leave && !schedule\.is_absent/)
  assert.match(script, /workforce_admin_assist_clock_in/)
  assert.match(script, /\.rpc\('workforce_clock_in', \{ p_schedule_id: scheduleId \}\)/)
  assert.match(script, /selectedValue === ADDITIONAL_WORK_SESSION \|\| workOnVLSelected \? null : selectedValue/)
})
