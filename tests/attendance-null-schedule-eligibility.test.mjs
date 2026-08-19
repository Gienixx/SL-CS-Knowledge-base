import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import { canUseUnscheduledWorkSession } from '../shared/attendance-additional-session.js'

const script = await fs.readFile(new URL('../scripts/attendance.js', import.meta.url), 'utf8')
const migration = await fs.readFile(new URL('../supabase/migrations/20260816141353_align_null_schedule_clock_in_eligibility.sql', import.meta.url), 'utf8')

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

const offsetDateKey = (value, days) => {
  const date = new Date(`${value}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

const released = schedule => Boolean(
  schedule &&
  ['published', 'changed'].includes(schedule.status) &&
  !schedule.is_leave &&
  !schedule.is_absent
)

const special = schedule => Boolean(schedule?.is_rest_day || schedule?.is_holiday)
const scheduleAvailability = new Function(
  'isSpecialDay',
  'isOpenSchedule',
  'localDateKey',
  'offsetDateKey',
  'hasCompletedAttendanceForDate',
  `${extractFunction('scheduleAvailability')}; return scheduleAvailability`
)(special, schedule => Boolean(schedule && !special(schedule) && !schedule.shift_start && !schedule.shift_end),
  () => currentDate,
  offsetDateKey,
  () => false)

const isBackendReleasedScheduleCandidate = (schedule, today, now) => {
  if (!released(schedule)) return false
  if (special(schedule)) {
    return schedule.shift_date === today || (
      schedule.shift_date === offsetDateKey(today, -1) &&
      scheduleAvailability(schedule, now).state === 'active'
    )
  }
  if (!schedule.shift_start && !schedule.shift_end) return schedule.shift_date === today
  return schedule.shift_date === today && ['early', 'active'].includes(scheduleAvailability(schedule, now).state) ||
    schedule.shift_date === offsetDateKey(today, -1) && scheduleAvailability(schedule, now).state === 'active'
}

const now = new Date('2026-08-16T12:00:00Z')
const currentDate = '2026-08-16'

const timed = (shiftDate, overrides = {}) => ({
  id: `${shiftDate}-timed`,
  shift_date: shiftDate,
  shift_start: `${shiftDate}T15:00:00Z`,
  shift_end: `${shiftDate}T23:00:00Z`,
  status: 'published',
  is_rest_day: false,
  is_holiday: false,
  is_leave: false,
  is_absent: false,
  ...overrides
})

test('Jean Aug 16 Unscheduled is allowed while Aug 17 timed schedule remains selectable', () => {
  const tomorrowSchedule = timed('2026-08-17')

  assert.equal(isBackendReleasedScheduleCandidate(tomorrowSchedule, currentDate, now), false)
  assert.equal(canUseUnscheduledWorkSession({
    workDate: currentDate,
    attendance: [],
    schedules: [tomorrowSchedule]
  }), true)
  assert.match(script, /new Option\(\s*scheduleOptionLabel\(schedule, availability/)
  assert.match(script, /No assigned schedule\. Your time will be recorded as unscheduled attendance\./)
  assert.match(script, /selectedValue === ADDITIONAL_WORK_SESSION \|\| workOnVLSelected \? null : selectedValue/)
  assert.match(migration, /p_schedule_id, v_work_date, v_clock_time/)
  assert.match(migration, /review_status = case when p_schedule_id is null then 'pending'/)
  assert.match(script, /if \(nowMs < startsAt\.getTime\(\)\) return \{ state: 'early'/)
  assert.doesNotMatch(script, /EARLY_CLOCK_IN_WINDOW_MINUTES/)
})

test('rest day / no plotted schedule offers Unscheduled Work without inventing an RDOT row', () => {
  const schedules = [timed('2026-08-17')]
  const attendance = []

  assert.equal(schedules.some(schedule => schedule.shift_date === currentDate), false)
  assert.equal(canUseUnscheduledWorkSession({
    workDate: currentDate,
    attendance,
    schedules
  }), true)
  assert.equal(isBackendReleasedScheduleCandidate(schedules[0], currentDate, now), false)
  assert.match(script, /No assigned schedule\. Your time will be recorded as unscheduled attendance\./)
  assert.doesNotMatch(script, /insert into public\.work_schedules/)
  assert.doesNotMatch(migration, /insert into public\.work_schedules/)
})

test('a schedule beyond the supported date window does not block current-date Unscheduled work', () => {
  assert.equal(isBackendReleasedScheduleCandidate(timed('2026-08-18'), currentDate, now), false)
  assert.equal(canUseUnscheduledWorkSession({
    workDate: currentDate,
    attendance: [],
    schedules: [timed('2026-08-18')]
  }), true)
})

test('current timed and active overnight schedules block null-schedule clock-in', () => {
  assert.equal(isBackendReleasedScheduleCandidate(timed(currentDate), currentDate, now), true)
  assert.equal(isBackendReleasedScheduleCandidate(timed('2026-08-15', {
    shift_start: '2026-08-15T05:00:00Z',
    shift_end: '2026-08-16T13:00:00Z'
  }), currentDate, now), true)
})

test('current RDOT and holiday schedules have real-schedule priority', () => {
  assert.equal(isBackendReleasedScheduleCandidate({
    id: 'rdot-today',
    shift_date: currentDate,
    shift_start: null,
    shift_end: null,
    status: 'published',
    is_rest_day: true,
    is_holiday: false,
    is_leave: false,
    is_absent: false
  }, currentDate, now), true)
  assert.equal(isBackendReleasedScheduleCandidate({
    id: 'holiday-today',
    shift_date: currentDate,
    shift_start: null,
    shift_end: null,
    status: 'published',
    is_rest_day: false,
    is_holiday: true,
    is_leave: false,
    is_absent: false
  }, currentDate, now), true)
})

test('tomorrow timed, RDOT, and holiday schedules do not block current-date Unscheduled work', () => {
  const tomorrowRdot = {
    id: 'rdot-tomorrow',
    shift_date: '2026-08-17',
    shift_start: null,
    shift_end: null,
    status: 'published',
    is_rest_day: true,
    is_holiday: false,
    is_leave: false,
    is_absent: false
  }
  const tomorrowHoliday = { ...tomorrowRdot, id: 'holiday-tomorrow', is_rest_day: false, is_holiday: true }

  assert.equal(isBackendReleasedScheduleCandidate(timed('2026-08-17'), currentDate, now), false)
  assert.equal(isBackendReleasedScheduleCandidate(tomorrowRdot, currentDate, now), false)
  assert.equal(isBackendReleasedScheduleCandidate(tomorrowHoliday, currentDate, now), false)
})

test('Open Schedule is a real eligible schedule while leave/absence schedules remain excluded', () => {
  assert.equal(isBackendReleasedScheduleCandidate(timed(currentDate, {
    shift_start: null,
    shift_end: null
  }), currentDate, now), true)
  assert.equal(isBackendReleasedScheduleCandidate(timed(currentDate, { is_leave: true }), currentDate, now), false)
  assert.equal(isBackendReleasedScheduleCandidate(timed(currentDate, { is_absent: true }), currentDate, now), false)
})

test('frontend sentinel and backend guard use equivalent active-date eligibility', () => {
  const additionalBody = extractFunction('canClockAdditionalSession')

  assert.match(script, /No assigned schedule\. Your time will be recorded as unscheduled attendance\./)
  assert.doesNotMatch(additionalBody, /hasUnusedEligibleRealSchedule\(\)/)
  assert.match(additionalBody, /hasUnusedEligibleSchedule/)
  assert.match(script, /p_work_date: schedule\?\.shift_date \|\| localDateKey\(\)/)
  assert.match(script, /selectedValue === ADDITIONAL_WORK_SESSION \|\| workOnVLSelected \? null : selectedValue/)
  assert.match(script, /function scheduleAvailability\(schedule, now = new Date\(\)/)
  assert.doesNotMatch(migration, /insert into public\.work_schedules/)
  assert.match(migration, /not \(schedule\.is_rest_day or schedule\.is_holiday\)/)
  assert.match(migration, /schedule\.shift_end > v_clock_time/)
  assert.match(migration, /schedule\.shift_date = v_local_date[\s\S]*schedule\.shift_end > v_clock_time/)
  assert.match(migration, /schedule\.shift_date = v_local_date - 1[\s\S]*schedule\.shift_end > v_clock_time/)
  const nullGuard = migration.match(/if p_schedule_id is null then([\s\S]*?)\n  else/)[1]
  assert.doesNotMatch(nullGuard, /v_local_date \+ 1/)
  assert.match(nullGuard, /v_has_completed_session/)
})

test('existing sentinel reset, Admin Assist, and payroll wiring remain present', () => {
  assert.match(script, /elements\.scheduleSelect\.value = preferred/)
  assert.match(script, /workforce_admin_assist_clock_in/)
  assert.match(script, /workforce_recalculate_attendance|regular_payable_minutes|rest_day_overtime_minutes/)
})
