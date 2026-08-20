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

function loadEligibility(script, attendance = [], openAttendance = false) {
  const localDateKey = () => '2026-08-20'
  const offsetDateKey = (date, days) => {
    const value = new Date(`${date}T00:00:00Z`)
    value.setUTCDate(value.getUTCDate() + days)
    return value.toISOString().slice(0, 10)
  }
  const isSpecialDay = schedule => Boolean(schedule?.is_rest_day || schedule?.is_holiday)
  const isOpenSchedule = schedule => Boolean(
    schedule && !isSpecialDay(schedule) && !schedule.shift_start && !schedule.shift_end
  )
  const hasAttendanceForSchedule = schedule => Boolean(
    schedule?.id && attendance.some(record => record.schedule_id === schedule.id)
  )
  const openAttendanceRecord = () => openAttendance ? { id: 'open' } : null
  const source = [
    extractFunction(script, 'isYesterdaySchedule'),
    extractFunction(script, 'isPreviousDayScheduleEligible')
  ].join('\n')

  return new Function(
    'localDateKey',
    'offsetDateKey',
    'hasAttendanceForSchedule',
    'openAttendanceRecord',
    'isSpecialDay',
    'isOpenSchedule',
    'RELEASED_SCHEDULE_STATUSES',
    `${source}; return isPreviousDayScheduleEligible`
  )(
    localDateKey,
    offsetDateKey,
    hasAttendanceForSchedule,
    openAttendanceRecord,
    isSpecialDay,
    isOpenSchedule,
    ['published', 'changed']
  )
}

function loadAvailability(script, completedToday = false) {
  const offsetDateKey = (date, days) => {
    const value = new Date(date + 'T00:00:00Z')
    value.setUTCDate(value.getUTCDate() + days)
    return value.toISOString().slice(0, 10)
  }
  const source = [
    extractFunction(script, 'isSpecialDay'),
    extractFunction(script, 'isOpenSchedule'),
    extractFunction(script, 'scheduleAvailability')
  ].join('\n')

  return new Function(
    'localDateKey',
    'offsetDateKey',
    'hasCompletedAttendanceForDate',
    source + '; return scheduleAvailability'
  )(
    () => '2026-08-20',
    offsetDateKey,
    () => completedToday
  )
}

function schedule(overrides = {}) {
  return {
    id: 'schedule-1',
    status: 'published',
    shift_date: '2026-08-19',
    shift_start: '2026-08-19T13:00:00.000Z',
    shift_end: '2026-08-19T21:00:00.000Z',
    is_rest_day: false,
    is_holiday: false,
    is_leave: false,
    is_absent: false,
    ...overrides
  }
}

test('Aug 20 agent eligibility is exactly yesterday-only for unused released schedules', async () => {
  const script = await read('scripts/attendance.js')
  const eligible = loadEligibility(script)
  const availability = loadAvailability(script, true)

  assert.equal(eligible(schedule()), true)
  assert.equal(eligible(schedule({ id: 'open-yesterday', shift_start: null, shift_end: null })), true)
  const today = schedule({
    id: 'today',
    shift_date: '2026-08-20',
    shift_start: '2026-08-20T13:00:00.000Z',
    shift_end: '2026-08-20T21:00:00.000Z'
  })
  const tomorrow = schedule({
    id: 'tomorrow',
    shift_date: '2026-08-21',
    shift_start: '2026-08-21T13:00:00.000Z',
    shift_end: '2026-08-21T21:00:00.000Z'
  })
  assert.equal(eligible(today), false)
  assert.equal(eligible(tomorrow), false)
  assert.equal(availability(today, new Date('2026-08-20T14:00:00.000Z')).state, 'active')
  assert.equal(availability(tomorrow, new Date('2026-08-20T14:00:00.000Z')).state, 'early')
  assert.equal(eligible(schedule({ id: 'older', shift_date: '2026-08-18' })), false)
  assert.equal(eligible(schedule({ id: 'draft', status: 'draft' })), false)
  assert.equal(eligible(schedule({ id: 'leave', is_leave: true })), false)
  assert.equal(eligible(schedule({ id: 'absence', is_absent: true })), false)
  assert.equal(loadEligibility(script, [{ schedule_id: 'schedule-1' }])(schedule()), false)
  assert.equal(loadEligibility(script, [], true)(schedule()), false)
})

test('today/tomorrow, overnight, RDOT/holiday, Additional, and Unscheduled flows remain wired', async () => {
  const [script, backend, baseline] = await Promise.all([
    read('scripts/attendance.js'),
    read('supabase/migrations/20260820140000_allow_previous_day_agent_schedule_clock_in.sql'),
    read('supabase/migrations/20260819101616_allow_open_schedule_clock_in_production_forward.sql')
  ])

  assert.match(script, /'next-day-special', 'next-day-overnight', 'special', 'early', 'active'/)
  assert.match(script, /ADDITIONAL_WORK_SESSION = '__ADDITIONAL_WORK_SESSION__'/)
  assert.match(script, /Additional work session · Needs review/)
  assert.match(script, /Unscheduled attendance/)
  assert.match(script, /RDOT/)
  assert.match(script, /overtime/i)
  assert.match(script, /state: 'next-day-overnight'/)
  assert.match(script, /rpc\('workforce_clock_in'/)

  assert.match(backend, /v_schedule\.shift_date not in \(v_local_date - 1, v_local_date\)/)
  assert.match(backend, /v_schedule\.shift_date <> v_local_date - 1[\s\S]*v_clock_time >= v_schedule\.shift_end/)
  assert.match(baseline, /v_schedule\.shift_date < v_local_date - 1[\s\S]*v_schedule\.shift_date > v_local_date \+ 1/)
  assert.match(backend, /p_schedule_id is not null[\s\S]*v_schedule\.shift_date = v_local_date - 1[\s\S]*Attendance for the selected schedule/)
  assert.doesNotMatch(baseline, /Attendance for the selected schedule has already been recorded/)
  assert.match(backend, /a\.clock_in is not null[\s\S]*a\.voided_at is null/)
  assert.match(baseline, /v_work_date := v_schedule\.shift_date/)
  assert.match(baseline, /v_clock_time timestamptz := now\(\)/)
})
