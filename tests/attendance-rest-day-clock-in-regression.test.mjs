import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

function loadRestDayEligibility(script) {
  const match = script.match(/function isUntimedRestDayWithinClockInWindow\(schedule, now = new Date\(\)\) \{[\s\S]*?\n\}/)
  assert.ok(match, 'untimed Rest Day eligibility predicate is present')
  return new Function('localDateKey', 'offsetDateKey', `${match[0]}; return isUntimedRestDayWithinClockInWindow`)(
    () => '2026-08-16',
    (date, days) => days === 1 ? '2026-08-17' : date
  )
}

test('latest clock-in RPC allows null-time Rest Day/RDOT schedules but rejects incomplete ordinary schedules', async () => {
  const migration = await read('supabase/migrations/20260814090000_allow_additional_unscheduled_attendance_session.sql')

  assert.match(migration, /v_schedule\.status not in \('published', 'changed'\)/)
  assert.match(migration, /if not \(v_schedule\.is_rest_day or v_schedule\.is_holiday\)[\s\S]*v_schedule\.shift_start is null or v_schedule\.shift_end is null/)
  assert.match(migration, /v_schedule\.shift_date < v_local_date - 1 or v_schedule\.shift_date > v_local_date \+ 1/)
  assert.match(migration, /v_work_date := v_schedule\.shift_date/)
  assert.doesNotMatch(migration, /if v_schedule\.shift_start is null or v_schedule\.shift_end is null then raise exception/)
})

test('attendance frontend keeps Rest Day/RDOT eligible and preserves ordinary/open schedule behavior', async () => {
  const script = await read('scripts/attendance.js')

  assert.match(script, /if \(isSpecialDay\(schedule\)\)/)
  assert.match(script, /state: 'special'/)
  assert.match(script, /'next-day-special', 'next-day-overnight', 'special', 'early', 'active'/)
  assert.match(script, /isUntimedRestDayWithinClockInWindow\(schedule\)/)
  assert.match(script, /busy \|\| Boolean\(openRecord\) \|\| selectedCompleted \|\| !hasExplicitSelection \|\| !scheduleClockInOpen/)
  assert.match(script, /This is an open schedule\. Fixed shift times must be added before self-service clock-in is available\./)
})

test('current-day untimed RDOT is eligible', async () => {
  const isEligible = loadRestDayEligibility(await read('scripts/attendance.js'))

  assert.equal(isEligible({
    shift_date: '2026-08-16',
    is_rest_day: true,
    shift_start: null,
    shift_end: null
  }), true)
})

test('next-day untimed RDOT is eligible without completed today attendance', async () => {
  const isEligible = loadRestDayEligibility(await read('scripts/attendance.js'))

  assert.equal(isEligible({
    shift_date: '2026-08-17',
    is_rest_day: true,
    shift_start: null,
    shift_end: null
  }), true)
})

test('ordinary future schedules remain disabled by the existing state guard', async () => {
  const script = await read('scripts/attendance.js')

  assert.match(
    script,
    /const scheduleClockInOpen = adminAssistMode[\s\S]*: schedule[\s\S]*\['next-day-special', 'next-day-overnight', 'special', 'early', 'active'\]\.includes\(availability\.state\)[\s\S]*isUntimedRestDayWithinClockInWindow\(schedule\)/
  )
})

test('normal untimed Open Schedule is not covered by the RDOT exception', async () => {
  const isEligible = loadRestDayEligibility(await read('scripts/attendance.js'))

  assert.equal(isEligible({
    shift_date: '2026-08-17',
    is_rest_day: false,
    is_holiday: false,
    shift_start: null,
    shift_end: null
  }), false)
})

test('timed schedule eligibility remains state-based', async () => {
  const isEligible = loadRestDayEligibility(await read('scripts/attendance.js'))

  assert.equal(isEligible({
    shift_date: '2026-08-17',
    is_rest_day: true,
    shift_start: '2026-08-17T15:00:00Z',
    shift_end: '2026-08-17T23:00:00Z'
  }), false)
})

test('attendance client remains syntactically valid after the Rest Day/RDOT regression fix', () => {
  const result = spawnSync(process.execPath, ['--check', 'scripts/attendance.js'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8'
  })

  assert.equal(result.status, 0, result.stderr)
})
