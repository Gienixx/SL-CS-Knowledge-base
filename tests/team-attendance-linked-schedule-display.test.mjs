import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import {
  linkedScheduleDisplay,
  mergeLinkedScheduleDetails
} from '../shared/team-attendance-schedule-display.js'

const script = await fs.readFile('scripts/team-attendance.js', 'utf8')
const migration = await fs.readFile('supabase/migrations/20260825120000_team_attendance_linked_schedule_display.sql', 'utf8')

function row(overrides = {}) {
  return {
    schedule_id: 'schedule-1',
    work_date: '2026-08-23',
    review_status: 'pending',
    ...overrides
  }
}

test('linked Open Schedule with null times has a displayable current schedule label', () => {
  const [merged] = mergeLinkedScheduleDetails([row()], [{
    schedule_id: 'schedule-1',
    shift_date: '2026-08-23',
    shift_sequence: 1,
    shift_start: null,
    shift_end: null,
    is_rest_day: false,
    is_holiday: false,
    is_leave: false,
    is_absent: false
  }])

  assert.deepEqual(linkedScheduleDisplay(merged), { kind: 'open', label: 'Open Schedule' })
  assert.match(script, /workforce_get_attendance_schedule_display/)
  assert.match(script, /mergeLinkedScheduleDetails\(attendanceRows, linkedScheduleDetails, linkedScheduleIds\)/)
})

test('current linked schedule display is independent of reassignment candidates', () => {
  const [merged] = mergeLinkedScheduleDetails([row()], [{
    schedule_id: 'schedule-1',
    shift_date: '2026-08-23',
    shift_sequence: 1,
    shift_start: null,
    shift_end: null,
    is_rest_day: false,
    is_holiday: false,
    is_leave: false,
    is_absent: false
  }])

  assert.equal(merged.linked_schedule_exists, true)
  assert.equal(linkedScheduleDisplay(merged).label, 'Open Schedule')
  assert.match(script, /const eligibleSchedules = \(data \|\| \[\]\)\.filter/)
})

test('approved, pending, and corrected rows use the same current linked schedule display', () => {
  for (const review_status of ['approved', 'pending', 'corrected']) {
    const [merged] = mergeLinkedScheduleDetails([row({ review_status })], [{
      schedule_id: 'schedule-1',
      shift_date: '2026-08-23',
      shift_sequence: 1,
      shift_start: null,
      shift_end: null,
      is_rest_day: false,
      is_holiday: false,
      is_leave: false,
      is_absent: false
    }])
    assert.equal(linkedScheduleDisplay(merged).label, 'Open Schedule')
  }
})

test('non-Open untimed linked schedules retain their type label', () => {
  const [merged] = mergeLinkedScheduleDetails([row()], [{
    schedule_id: 'schedule-1',
    shift_date: '2026-08-23',
    shift_sequence: 1,
    shift_start: null,
    shift_end: null,
    is_rest_day: true,
    is_holiday: false,
    is_leave: false,
    is_absent: false
  }])
  assert.equal(linkedScheduleDisplay(merged).label, 'Rest Day')
})

test('holiday, leave, and absence labels remain explicit for untimed linked schedules', () => {
  const cases = [
    [{ is_holiday: true, holiday_name: 'Founders Day' }, 'Founders Day'],
    [{ is_leave: true, leave_type: 'incentive_vl' }, 'Incentive VL'],
    [{ is_absent: true }, 'Absent']
  ]

  for (const [metadata, expected] of cases) {
    const [merged] = mergeLinkedScheduleDetails([row()], [{
      schedule_id: 'schedule-1',
      shift_date: '2026-08-23',
      shift_sequence: 1,
      shift_start: null,
      shift_end: null,
      is_rest_day: false,
      is_holiday: false,
      is_leave: false,
      is_absent: false,
      ...metadata
    }])
    assert.equal(linkedScheduleDisplay(merged).label, expected)
  }
})

test('deleted or nonexistent schedules remain safely unavailable', () => {
  const [merged] = mergeLinkedScheduleDetails([row()], [])
  assert.equal(linkedScheduleDisplay(merged).label, 'Shift unavailable')
})

test('rows not included in the linked-schedule lookup are not falsely marked unavailable', () => {
  const [timed, open] = mergeLinkedScheduleDetails([
    row({ schedule_id: 'timed-schedule', scheduled_start: '2026-08-23T09:00:00Z', scheduled_end: '2026-08-23T17:00:00Z', is_open: true }),
    row({ schedule_id: 'open-schedule' })
  ], [{
    schedule_id: 'open-schedule',
    shift_date: '2026-08-23',
    shift_sequence: 1,
    shift_start: null,
    shift_end: null,
    is_rest_day: false,
    is_holiday: false,
    is_leave: false,
    is_absent: false
  }], ['open-schedule'])

  assert.equal(timed.linked_schedule_exists, undefined)
  assert.equal(timed.is_open, true)
  assert.equal(timed.scheduled_start, '2026-08-23T09:00:00Z')
  assert.equal(open.linked_schedule_exists, true)
  assert.equal(linkedScheduleDisplay(open).label, 'Open Schedule')
})

test('timed schedule display remains unchanged', () => {
  const [merged] = mergeLinkedScheduleDetails([row({ scheduled_start: '2026-08-23T09:00:00Z', scheduled_end: '2026-08-23T17:00:00Z' })], [{
    schedule_id: 'schedule-1',
    shift_date: '2026-08-23',
    shift_sequence: 1,
    shift_start: '2026-08-23T09:00:00Z',
    shift_end: '2026-08-23T17:00:00Z',
    timezone: 'America/New_York',
    is_rest_day: false,
    is_holiday: false,
    is_leave: false,
    is_absent: false
  }])
  assert.equal(linkedScheduleDisplay(merged).kind, 'timed')
  assert.match(script, /isEligibleCorrectionSchedule\(schedule, row\.work_date\)/)
})

test('current-link lookup is permission-scoped and does not alter reassignment rules', () => {
  assert.match(migration, /workforce_has_permission\('view_team_attendance'\)/)
  assert.match(migration, /schedule\.user_id = v_current_profile\.user_id/)
  assert.match(migration, /schedule\.id = any\(p_schedule_ids\)/)
  assert.match(migration, /revoke all on function public\.workforce_get_attendance_schedule_display\(uuid\[\]\)/)
})
