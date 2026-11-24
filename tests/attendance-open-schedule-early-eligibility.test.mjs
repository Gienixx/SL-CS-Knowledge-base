import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

function extractFunction(script, name) {
  const start = script.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} is present`)
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

function loadScheduleAvailability(script, timezone) {
  const functions = [
    'parseDateKey',
    'offsetDateKey',
    'localDateKey',
    'isSpecialDay',
    'isOpenSchedule',
    'timeZoneDateParts',
    'isOpenSchedulePreMidnightEligible',
    'scheduleAvailability'
  ].map(name => extractFunction(script, name))

  return new Function(
    'access',
    'hasCompletedAttendanceForDate',
    `${functions.join('\n')}\nreturn scheduleAvailability`
  )({ timezone }, () => false)
}

const openSchedule = {
  id: 'open-tomorrow',
  shift_date: '2026-11-24',
  shift_start: null,
  shift_end: null,
  is_rest_day: false,
  is_holiday: false,
  status: 'changed'
}

test('Open Schedule eligibility opens at 10 PM, including exact boundary and following midnight', async () => {
  const script = await read('scripts/attendance.js')
  const availability = loadScheduleAvailability(script, 'America/New_York')

  assert.equal(availability(openSchedule, new Date('2026-11-24T02:59:59.999Z')).state, 'future')
  assert.equal(availability(openSchedule, new Date('2026-11-24T03:00:00.000Z')).state, 'next-day-open')
  assert.equal(availability(openSchedule, new Date('2026-11-24T04:59:59.999Z')).state, 'next-day-open')
  assert.equal(availability(openSchedule, new Date('2026-11-24T05:00:00.000Z')).state, 'open')
})

test('eligibility boundary follows the workforce timezone, not the device timezone', async () => {
  const script = await read('scripts/attendance.js')
  const manilaAvailability = loadScheduleAvailability(script, 'Asia/Manila')

  assert.equal(manilaAvailability(openSchedule, new Date('2026-11-23T13:59:59.999Z')).state, 'future')
  assert.equal(manilaAvailability(openSchedule, new Date('2026-11-23T14:00:00.000Z')).state, 'next-day-open')
})

test('backend uses the same workforce-local 10 PM boundary and preserves date and timestamp attribution', async () => {
  const [migration, baseline, previousDayGuard, script] = await Promise.all([
    read('supabase/migrations/20261124041634_allow_open_schedule_clock_in_two_hours_early.sql'),
    read('supabase/migrations/20260819101616_allow_open_schedule_clock_in_production_forward.sql'),
    read('supabase/migrations/20260820140000_allow_previous_day_agent_schedule_clock_in.sql'),
    read('scripts/attendance.js')
  ])

  assert.match(migration, /v_schedule\.shift_date = v_local_date \+ 1[\s\S]*\(v_clock_time at time zone v_timezone\)::time >= time '22:00'/)
  assert.match(migration, /schedule\.shift_date in \(v_local_date, v_local_date \+ 1\)[\s\S]*schedule\.shift_date = v_local_date[\s\S]*\(v_clock_time at time zone v_timezone\)::time >= time '22:00'/)
  assert.match(baseline, /v_work_date := v_schedule\.shift_date/)
  assert.match(baseline, /v_clock_time timestamptz := now\(\)/)
  assert.doesNotMatch(migration, /v_work_date\s*:=|v_clock_time\s*:=/)
  assert.match(migration, /Attendance for the selected Open Schedule has already been recorded/)
  assert.match(migration, /pg_publication_tables[\s\S]*alter publication supabase_realtime add table public\.work_schedules/)
  assert.match(baseline, /You are already clocked in to another shift\./)
  assert.match(previousDayGuard, /a\.clock_in is not null[\s\S]*a\.voided_at is null/)
  assert.match(script, /function isOpenSchedulePreMidnightEligible\(schedule, now = new Date\(\)\)[\s\S]*Number\(localParts\.hour\) >= 22/)
  assert.match(script, /availability\.state === 'next-day-open'/)
})

test('schedule edits refresh eligibility and the existing live clock re-evaluates the opening boundary', async () => {
  const script = await read('scripts/attendance.js')
  const updateLiveClock = extractFunction(script, 'updateLiveClock')

  assert.match(script, /\.on\('postgres_changes',[\s\S]*event: 'UPDATE'[\s\S]*table: 'work_schedules'[\s\S]*refreshEligibility\(\)/)
  assert.match(script, /setInterval\(\(\) => void refreshEligibility\(\), 30_000\)/)
  assert.match(script, /clockTimer = window\.setInterval\(updateLiveClock, 1000\)/)
  assert.match(updateLiveClock, /updateActionState\(\)/)
  assert.match(updateLiveClock, /localDateRefreshPending[\s\S]*refreshAll/)
})

test('early Open Schedule change leaves attendance approval and payroll calculation code untouched', async () => {
  const [migration, payrollV2, committedHours] = await Promise.all([
    read('supabase/migrations/20261124041634_allow_open_schedule_clock_in_two_hours_early.sql'),
    read('supabase/migrations/20260923160209_payroll_v2_preview_qualifying_attendance.sql'),
    read('supabase/migrations/20260924200000_attendance_committed_hours_visibility.sql')
  ])

  assert.doesNotMatch(migration, /payroll|committed_hours|approved|locked/i)
  assert.match(payrollV2, /row_data ->> 'work_date'/)
  assert.match(committedHours, /work_date/)
})
