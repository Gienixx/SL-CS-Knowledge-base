import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath = 'supabase/migrations/20260820160000_allow_same_work_date_open_schedule_correction.sql'

function functionSource(script, name, signature) {
  const source = script.match(new RegExp(`function ${name}\\(${signature}\\) \\{[\\s\\S]*?\\n\\}`))?.[0]
  assert.ok(source, `${name} should remain independently testable`)
  return source
}

const openSchedule = (overrides = {}) => ({
  id: 'open-schedule',
  shift_date: '2026-08-19',
  status: 'published',
  is_rest_day: false,
  is_holiday: false,
  is_leave: false,
  is_absent: false,
  shift_start: null,
  shift_end: null,
  ...overrides
})

test('same-work-date Open Schedule is eligible while previous-date Open Schedule is not', async () => {
  const script = await read('scripts/team-attendance.js')
  const sources = [
    functionSource(script, 'isCorrectionOpenSchedule', 'schedule'),
    functionSource(script, 'isEligibleCorrectionSchedule', 'schedule, workDate')
  ].join('\n')
  const eligible = Function(`${sources}\nreturn { isCorrectionOpenSchedule, isEligibleCorrectionSchedule }`)()

  assert.equal(eligible.isCorrectionOpenSchedule(openSchedule()), true)
  assert.equal(eligible.isEligibleCorrectionSchedule(openSchedule(), '2026-08-19'), true)
  assert.equal(eligible.isEligibleCorrectionSchedule(openSchedule({ shift_date: '2026-08-18' }), '2026-08-19'), false)
  assert.equal(eligible.isEligibleCorrectionSchedule(openSchedule({ is_leave: true }), '2026-08-19'), false)
  assert.equal(eligible.isEligibleCorrectionSchedule(openSchedule({ status: 'cancelled' }), '2026-08-19'), false)
})

test('current linked Open Schedule remains a single enabled keep option', async () => {
  const script = await read('scripts/team-attendance.js')

  assert.match(script, /new Option\(row\.schedule_id \? 'Keep current assigned shift' : 'Unscheduled \(RDOT\)', row\.schedule_id \|\| ''\)/)
  assert.doesNotMatch(script, /Current \(outside eligible window\)/)
  assert.doesNotMatch(script, /currentOption\.disabled\s*=\s*true/)
  assert.match(script, /schedule\.id !== row\.schedule_id\s*\n\s*&& isEligibleCorrectionSchedule\(schedule, row\.work_date\)/)
})

test('timed, overnight, Rest Day, and Holiday correction candidates remain eligible', async () => {
  const script = await read('scripts/team-attendance.js')
  const sources = [
    functionSource(script, 'isCorrectionOpenSchedule', 'schedule'),
    functionSource(script, 'isEligibleCorrectionSchedule', 'schedule, workDate')
  ].join('\n')
  const eligible = Function(`${sources}\nreturn isEligibleCorrectionSchedule`)()

  const timedOvernight = openSchedule({
    shift_start: '2026-08-19T01:00:00.000Z',
    shift_end: '2026-08-19T09:00:00.000Z'
  })
  assert.equal(eligible(timedOvernight, '2026-08-19'), true)
  assert.equal(eligible({ ...timedOvernight, shift_date: '2026-08-18' }, '2026-08-19'), true)
  assert.equal(eligible(openSchedule({ is_rest_day: true, planned_paid_minutes: null }), '2026-08-19'), true)
  assert.equal(eligible(openSchedule({ is_holiday: true, planned_paid_minutes: null }), '2026-08-19'), true)
})

test('correction RPCs allow only same-work-date untimed Open Schedules through the time guard', async () => {
  const sql = await read(migrationPath)
  const guards = sql.match(/if not v_schedule\.is_rest_day[\s\S]*?raise exception 'The selected schedule does not have valid shift times\.'[\s\S]*?end if;/g) || []

  assert.equal(guards.length, 2)
  for (const guard of guards) {
    assert.match(guard, /v_schedule\.shift_date = v_old\.work_date/)
    assert.match(guard, /v_schedule\.shift_start is null/)
    assert.match(guard, /v_schedule\.shift_end is null/)
    assert.match(guard, /v_schedule\.shift_end <= v_schedule\.shift_start/)
  }
  assert.equal((sql.match(/The selected schedule does not have valid shift times\./g) || []).length, 2)
})

test('RPC safeguards and correction audit paths remain unchanged', async () => {
  const sql = await read(migrationPath)

  assert.equal((sql.match(/Locked attendance cannot be changed\./g) || []).length, 2)
  assert.equal((sql.match(/Leave and absence schedules cannot be assigned to attendance\./g) || []).length, 2)
  assert.equal((sql.match(/Only published or changed schedules may be assigned\./g) || []).length, 2)
  assert.equal((sql.match(/v_schedule\.shift_date not in \(v_old\.work_date, v_old\.work_date - 1\)/g) || []).length, 2)
  assert.match(sql, /workforce_can_correct_attendance\(public\.workforce_current_profile_id\(\)\)/)
  assert.match(sql, /workforce_can_manage_user\(v_old\.user_id, 'correct_attendance'\)/)
  assert.match(sql, /v_old\.schedule_id, v_new\.schedule_id/)
  assert.match(sql, /attendance_schedule_assigned/)
  assert.match(sql, /attendance_billed_time_corrected/)
  assert.match(sql, /set_config\('workforce\.correction_recalculation', 'true', true\)/)
  assert.match(sql, /v_new := public\.workforce_recalculate_attendance\(v_new\.id\)/)
})

test('zero-overlap timed candidates retain the existing confirmation behavior', async () => {
  const script = await read('scripts/team-attendance.js')
  const sources = [
    functionSource(script, 'timezoneOffsetMilliseconds', 'timestamp'),
    functionSource(script, 'toDateTimeLocal', 'value'),
    functionSource(script, 'dateTimeLocalToIso', 'value'),
    functionSource(script, 'parseDateKey', 'value'),
    functionSource(script, 'shiftIsoByWorkforceDays', 'timestamp, days'),
    functionSource(script, 'intervalOverlapMinutes', 'clockInIso, clockOutIso, schedule'),
    functionSource(script, 'correctionScheduleAnalysis', '[\\s\\S]*?')
  ].join('\n')
  const analysis = Function(`const WORKFORCE_TIMEZONE = 'America/New_York'\n${sources}\nreturn correctionScheduleAnalysis`)()
  const result = analysis({
    clockInIso: '2026-08-20T04:30:00.000Z',
    clockOutIso: '2026-08-20T11:26:00.000Z',
    schedule: {
      shift_start: '2026-08-19T01:00:00.000Z',
      shift_end: '2026-08-19T09:00:00.000Z'
    }
  })

  assert.equal(result.overlapMinutes, 0)
  assert.equal(result.requiresConfirmation, true)
})
