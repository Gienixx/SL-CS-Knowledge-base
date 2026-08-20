import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

function loadScheduleAvailability(script, today = '2026-08-19') {
  const specialDay = script.match(/function isSpecialDay\(schedule\) \{[\s\S]*?\n\}/)?.[0]
  const openSchedule = script.match(/function isOpenSchedule\(schedule\) \{[\s\S]*?\n\}/)?.[0]
  const availability = script.match(/function scheduleAvailability\(schedule, now = new Date\(\)\) \{[\s\S]*?(?=\nfunction isUntimedRestDayWithinClockInWindow)/)?.[0]
  assert.ok(specialDay)
  assert.ok(openSchedule)
  assert.ok(availability)

  return new Function(
    'localDateKey',
    'offsetDateKey',
    'hasCompletedAttendanceForDate',
    `${specialDay}\n${openSchedule}\n${availability}\nreturn scheduleAvailability`
  )(
    () => today,
    (date, days) => days === 1 ? '2026-08-20' : '2026-08-18',
    () => false
  )
}

test('published Open Schedule with null times enables clock-in on its work date', async () => {
  const script = await read('scripts/attendance.js')
  const availability = loadScheduleAvailability(script)

  assert.deepEqual(availability({
    shift_date: '2026-08-19',
    shift_start: null,
    shift_end: null,
    is_rest_day: false,
    is_holiday: false
  }), { state: 'open', startsAt: null, endsAt: null })
  assert.match(script, /availability\.state === 'open'/)
  assert.match(script, /This is an open schedule\. Clock-in is available today; no fixed shift times are required\./)
  assert.match(script, /elements\.clockInButton\.disabled = busy \|\| Boolean\(openRecord\) \|\| selectedCompleted \|\| !hasExplicitSelection \|\| !scheduleClockInOpen/)
})

test('Open Schedule passes backend eligibility without weakening timed-schedule validation', async () => {
  const migration = await read('supabase/migrations/20260819101616_allow_open_schedule_clock_in_production_forward.sql')

  assert.match(
    migration,
    /or \([\s\S]*not \(schedule\.is_rest_day or schedule\.is_holiday\)[\s\S]*schedule\.shift_start is null[\s\S]*schedule\.shift_end is null[\s\S]*schedule\.shift_date = v_local_date[\s\S]*\)/
  )
  assert.match(
    migration,
    /if not \(v_schedule\.is_rest_day or v_schedule\.is_holiday\)[\s\S]*v_schedule\.shift_start is null[\s\S]*v_schedule\.shift_end is null[\s\S]*shift_date <> v_local_date[\s\S]*Open Schedule clock-in is available only on the scheduled work date/
  )
  assert.match(migration, /\(v_schedule\.shift_start is null or v_schedule\.shift_end is null\) then[\s\S]*The selected schedule does not have valid shift times/)
  assert.match(migration, /schedule\.shift_date = v_local_date - 1[\s\S]*schedule\.shift_end is not null[\s\S]*schedule\.shift_end > v_clock_time/)
  assert.doesNotMatch(migration, /schedule\.shift_date between v_local_date - 1 and v_local_date \+ 1/)
  assert.match(migration, /if v_schedule\.shift_date < v_local_date - 1[\s\S]*v_schedule\.shift_date > v_local_date \+ 1/)
  assert.match(migration, /if v_clock_time >= v_schedule\.shift_end/)
  assert.match(migration, /revoke all on function public\.workforce_clock_in\(uuid\) from public, anon, authenticated/)
  assert.match(migration, /grant execute on function public\.workforce_clock_in\(uuid\) to authenticated/)
})

test('ordinary incomplete schedules remain blocked while Rest Day and holiday null times remain eligible', async () => {
  const [script, migration] = await Promise.all([
    read('scripts/attendance.js'),
    read('supabase/migrations/20260819101616_allow_open_schedule_clock_in_production_forward.sql')
  ])
  const availability = loadScheduleAvailability(script)

  assert.equal(availability({
    shift_date: '2026-08-19',
    shift_start: '2026-08-19T09:00:00Z',
    shift_end: null,
    is_rest_day: false,
    is_holiday: false
  }).state, 'unavailable')
  assert.equal(availability({
    shift_date: '2026-08-19',
    shift_start: null,
    shift_end: null,
    is_rest_day: true,
    is_holiday: false
  }).state, 'special')
  assert.equal(availability({
    shift_date: '2026-08-19',
    shift_start: null,
    shift_end: null,
    is_rest_day: false,
    is_holiday: true
  }).state, 'special')
  assert.match(migration, /if not \(v_schedule\.is_rest_day or v_schedule\.is_holiday\)[\s\S]*The selected schedule does not have valid shift times/)
})

test('Open Schedule publication-change warning is informational and duplicate guards remain wired', async () => {
  const [script, migration] = await Promise.all([
    read('scripts/attendance.js'),
    read('supabase/migrations/20260819101616_allow_open_schedule_clock_in_production_forward.sql')
  ])

  assert.match(script, /isChangedSchedule\(schedule\)/)
  assert.match(script, /A visible schedule was changed after publication\. Review the selected shift before clocking in\./)
  assert.match(migration, /You are already clocked in to another shift\./)
  assert.match(migration, /where a\.user_id = v_profile_user_id[\s\S]*a\.schedule_id is null/)
  assert.match(script, /Boolean\(openRecord\)/)
})

test('attendance client remains syntactically valid after Open Schedule clock-in fix', () => {
  const result = spawnSync(process.execPath, ['--check', 'scripts/attendance.js'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8'
  })

  assert.equal(result.status, 0, result.stderr)
})
