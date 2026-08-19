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

function loadScheduleAvailability(script) {
  const openSchedule = extractFunction(script, 'isOpenSchedule')
  const availability = extractFunction(script, 'scheduleAvailability')
  const isSpecialDay = schedule => Boolean(schedule?.is_rest_day || schedule?.is_holiday)
  const isOpenSchedule = new Function(
    'isSpecialDay',
    `${openSchedule}; return isOpenSchedule`
  )(isSpecialDay)

  return new Function(
    'isSpecialDay',
    'isOpenSchedule',
    'localDateKey',
    'offsetDateKey',
    'hasCompletedAttendanceForDate',
    `${openSchedule}\n${availability}; return scheduleAvailability`
  )(
    isSpecialDay,
    isOpenSchedule,
    () => '2026-08-17',
    (date, days) => {
      const value = new Date(`${date}T00:00:00Z`)
      value.setUTCDate(value.getUTCDate() + days)
      return value.toISOString().slice(0, 10)
    },
    () => false
  )
}

test('ended yesterday schedules are hidden for agents but available to Admin Assist', async () => {
  const script = await read('scripts/attendance.js')
  const chooser = script.match(/function renderScheduleChooser\(\) \{[\s\S]*?\n\}/)?.[0]

  assert.ok(chooser)
  assert.match(chooser, /const displayedSchedules = visibleSchedules[\s\S]*\.filter\(schedule => adminAssistMode \|\| scheduleAvailability\(schedule, now\)\.state !== 'ended'\)/)
  assert.match(chooser, /const availability = scheduleAvailability\(schedule, now\)/)
  assert.match(chooser, /option\.disabled = adminAssistMode \? hasAttendance : availability\.state === 'ended'/)
  assert.match(script, /function hasAttendanceForSchedule\(schedule\)/)
  assert.match(script, /const availabilityLabel = availability\.state === 'ended' \? ' · Ended' : ''/)
  assert.match(script, /const scheduleClockInOpen = schedule[\s\S]*adminAssistMode[\s\S]*'ended'/)

  const availability = loadScheduleAvailability(script)
  const now = new Date('2026-08-17T13:00:00.000Z')

  assert.equal(availability({
    id: 'retroactive-ended',
    shift_date: '2026-08-16',
    shift_start: '2026-08-16T12:00:00.000Z',
    shift_end: '2026-08-16T20:00:00.000Z'
  }, now).state, 'ended')

  assert.equal(availability({
    id: 'retroactive-rdot',
    shift_date: '2026-08-16',
    is_rest_day: true,
    shift_start: null,
    shift_end: null
  }, now).state, 'ended')

  const agentVisible = (adminAssistMode, state) => adminAssistMode || state !== 'ended'
  assert.equal(agentVisible(false, 'ended'), false)
  assert.equal(agentVisible(true, 'ended'), true)
})

test('retroactive yesterday schedule created today is inside the unchanged loading window', async () => {
  const [page, script] = await Promise.all([
    read('attendance.html'),
    read('scripts/attendance.js')
  ])
  const retroactiveSchedule = {
    id: 'created-today-for-yesterday',
    created_at: '2026-08-17T12:00:00.000Z',
    shift_date: '2026-08-16',
    status: 'published'
  }

  assert.equal(retroactiveSchedule.created_at.slice(0, 10), '2026-08-17')
  assert.ok(retroactiveSchedule.shift_date >= '2026-08-16' && retroactiveSchedule.shift_date <= '2026-08-18')
  assert.match(script, /const rangeStart = offsetDateKey\(today, -1\)/)
  assert.match(script, /const rangeEnd = offsetDateKey\(today, 1\)/)
  assert.match(script, /todaySchedules = scheduleResult\.data \|\| \[\]/)
  assert.match(script, /visibleSchedules = todaySchedules\.filter\(schedule => !schedule\.is_leave && !schedule\.is_absent\)/)
  assert.match(page, /id="attendanceAdminAssistClockInDate"[^>]*type="date"/)
  assert.match(page, /id="attendanceAdminAssistClockInTime"[^>]*type="time"/)
  assert.match(script, /if \(historicalClockIn\.timestamp\) payload\.p_clock_in = historicalClockIn\.timestamp/)
  assert.match(page, /scripts\/attendance\.js\?v=25/)
})

test('historical Agent Assist converts Aug 16 8:05 AM New York to the correct UTC timestamp', async () => {
  const script = await read('scripts/attendance.js')
  const converter = new Function(
    `${extractFunction(script, 'timeZoneDateParts')}\n${extractFunction(script, 'localDateTimeToISOString')}; return localDateTimeToISOString`
  )()

  assert.equal(
    converter('2026-08-16T08:05', 'America/New_York'),
    '2026-08-16T12:05:00.000Z'
  )
})

test('yesterday overnight remains active while today and tomorrow states stay governed by existing rules', async () => {
  const availability = loadScheduleAvailability(await read('scripts/attendance.js'))
  const now = new Date('2026-08-17T13:00:00.000Z')

  assert.equal(availability({
    shift_date: '2026-08-16',
    shift_start: '2026-08-17T00:00:00.000Z',
    shift_end: '2026-08-17T16:00:00.000Z'
  }, now).state, 'active')

  assert.equal(availability({
    shift_date: '2026-08-17',
    shift_start: '2026-08-17T12:00:00.000Z',
    shift_end: '2026-08-17T20:00:00.000Z'
  }, now).state, 'active')

  assert.equal(availability({
    shift_date: '2026-08-18',
    is_rest_day: true,
    shift_start: null,
    shift_end: null
  }, now).state, 'future')
})
