import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  calculatePartialLeaveInterval,
  partialLeaveScheduleEligibility
} from '../shared/leave-duration.js'

const migrationUrl = new URL('../supabase/migrations/20261007105945_partial_day_leave_support.sql', import.meta.url)
const paidLeavePolicyUrl = new URL('../supabase/migrations/20260810122500_paid_leave_attendance_coexistence.sql', import.meta.url)
const reviewMigrationUrl = new URL('../supabase/migrations/20260817125628_unified_schedule_requests.sql', import.meta.url)
const leaveUiUrl = new URL('../scripts/leave-requests.js', import.meta.url)
const leavePageUrl = new URL('../leave-requests.html', import.meta.url)
const workforceScheduleUrl = new URL('../scripts/workforce-schedules.js', import.meta.url)
const myScheduleUrl = new URL('../scripts/my-schedule-v2.js', import.meta.url)
const teamAttendanceUrl = new URL('../scripts/team-attendance.js', import.meta.url)

function schedule(overrides = {}) {
  return {
    id: 'schedule-1',
    shift_date: '2026-01-12',
    shift_start: '2026-01-12T09:00:00.000Z',
    shift_end: '2026-01-12T17:00:00.000Z',
    timezone: 'UTC',
    status: 'published',
    is_rest_day: false,
    is_holiday: false,
    is_leave: false,
    is_absent: false,
    ...overrides
  }
}

test('Whole Day keeps the existing submission RPC and defaults old requests to whole_day', async () => {
  const [migration, script, page] = await Promise.all([
    readFile(migrationUrl, 'utf8'),
    readFile(leaveUiUrl, 'utf8'),
    readFile(leavePageUrl, 'utf8')
  ])

  assert.match(migration, /leave_duration text not null default 'whole_day'/)
  assert.match(script, /duration === 'whole_day'[\s\S]*?workforce_submit_leave_request/)
  assert.match(page, /option value="whole_day">Whole Day/)
  assert.match(migration, /leave_duration in \('half_day', 'specific_time'\)/)
})

test('First Half and Second Half split the actual schedule midpoint', () => {
  const tenHourShift = schedule({
    shift_start: '2026-01-12T08:00:00.000Z',
    shift_end: '2026-01-12T18:00:00.000Z'
  })

  const first = calculatePartialLeaveInterval({ duration: 'half_day', half: 'first', schedule: tenHourShift })
  const second = calculatePartialLeaveInterval({ duration: 'half_day', half: 'second', schedule: tenHourShift })

  assert.equal(first.start, '2026-01-12T08:00:00.000Z')
  assert.equal(first.end, '2026-01-12T13:00:00.000Z')
  assert.equal(first.minutes, 300)
  assert.equal(second.start, '2026-01-12T13:00:00.000Z')
  assert.equal(second.end, '2026-01-12T18:00:00.000Z')
  assert.equal(second.minutes, 300)
})

test('Specific Time stores the requested interval duration', () => {
  const interval = calculatePartialLeaveInterval({
    duration: 'specific_time',
    fromTime: '14:00',
    toTime: '17:00',
    schedule: schedule()
  })

  assert.equal(interval.start, '2026-01-12T14:00:00.000Z')
  assert.equal(interval.end, '2026-01-12T17:00:00.000Z')
  assert.equal(interval.minutes, 180)
})

test('Specific Time rejects reversed and out-of-schedule intervals', () => {
  assert.throws(
    () => calculatePartialLeaveInterval({
      duration: 'specific_time',
      fromTime: '14:00',
      toTime: '13:00',
      schedule: schedule()
    }),
    /end must be later/
  )

  assert.throws(
    () => calculatePartialLeaveInterval({
      duration: 'specific_time',
      fromTime: '18:00',
      toTime: '20:00',
      schedule: schedule()
    }),
    /fit within the scheduled shift/
  )
})

test('overnight Specific Time anchors early morning times to the scheduled work date', () => {
  const overnight = schedule({
    shift_start: '2026-01-12T22:00:00.000Z',
    shift_end: '2026-01-13T06:00:00.000Z'
  })
  const interval = calculatePartialLeaveInterval({
    duration: 'specific_time',
    fromTime: '02:00',
    toTime: '05:00',
    schedule: overnight
  })

  assert.equal(interval.start, '2026-01-13T02:00:00.000Z')
  assert.equal(interval.end, '2026-01-13T05:00:00.000Z')
  assert.equal(interval.minutes, 180)
})

test('a non-eight-hour schedule produces a schedule-based half day', () => {
  const sixHourShift = schedule({
    shift_start: '2026-01-12T10:00:00.000Z',
    shift_end: '2026-01-12T16:00:00.000Z'
  })

  assert.equal(
    calculatePartialLeaveInterval({ duration: 'half_day', half: 'first', schedule: sixHourShift }).minutes,
    180
  )
})

test('Open Schedules, null shift times, Rest Days, and multiple active schedules reject partial leave', () => {
  const openSchedule = schedule({
    shift_start: null,
    shift_end: null,
    planned_paid_minutes: 420
  })
  const restDay = schedule({ is_rest_day: true })

  assert.match(partialLeaveScheduleEligibility([openSchedule], '2026-01-12').reason, /timed schedule/)
  assert.match(partialLeaveScheduleEligibility([restDay], '2026-01-12').reason, /Rest Days/)
  assert.match(
    partialLeaveScheduleEligibility([schedule(), schedule({ id: 'schedule-2' })], '2026-01-12').reason,
    /exactly one/
  )
})

test('approval revalidates the source schedule while rejection bypasses partial approval checks', async () => {
  const [migration, reviewMigration] = await Promise.all([
    readFile(migrationUrl, 'utf8'),
    readFile(reviewMigrationUrl, 'utf8')
  ])
  const approvalFunction = migration.match(/create or replace function public\.workforce_validate_partial_leave_approval\(\)([\s\S]*?)\$\$;/)?.[1]
  const reviewFunction = reviewMigration.match(/create or replace function public\.workforce_review_leave_request\([\s\S]*?as \$\$([\s\S]*?)\$\$;/)?.[1]

  assert.ok(approvalFunction, 'partial approval trigger function is present')
  assert.ok(reviewFunction, 'existing leave review RPC is present')
  assert.match(approvalFunction, /new\.status <> 'approved'[\s\S]*?return new;/)
  assert.match(approvalFunction, /old\.status = 'approved'/)
  assert.match(approvalFunction, /source schedule changed; update or resubmit/)
  assert.match(approvalFunction, /requested_leave_start is distinct from v_expected_start/)
  assert.match(reviewFunction, /v_status = 'rejected' and v_review_notes is null/)
  assert.match(reviewFunction, /set status = v_status/)
})

test('submission, review, paid leave, schedule display, attendance, and payroll contracts stay bounded', async () => {
  const [migration, paidLeavePolicy, reviewMigration, workforceSchedules, mySchedule, teamAttendance] = await Promise.all([
    readFile(migrationUrl, 'utf8'),
    readFile(paidLeavePolicyUrl, 'utf8'),
    readFile(reviewMigrationUrl, 'utf8'),
    readFile(workforceScheduleUrl, 'utf8'),
    readFile(myScheduleUrl, 'utf8'),
    readFile(teamAttendanceUrl, 'utf8')
  ])
  const script = await readFile(leaveUiUrl, 'utf8')

  assert.match(migration, /workforce_submit_partial_leave_request/)
  assert.match(migration, /'incentive_vl', 'birthday_vl', 'leave_without_pay'/)
  assert.match(migration, /workforce_validate_partial_leave_approval/)
  assert.match(migration, /before update of status on public\.leave_requests/)
  assert.match(migration, /old\.status = 'approved'/)
  assert.match(migration, /new\.status <> 'approved'[\s\S]*?return new;/)
  assert.match(migration, /period\.status = 'finalized' or record\.status = 'finalized'/)
  assert.match(migration, /Partial-day leave can no longer be approved for this date/)
  assert.match(migration, /v_leave\.leave_duration in \('half_day', 'specific_time'\)/)
  assert.match(migration, /public\.workforce_is_paid_leave_type\(schedule\.leave_type\)/)
  assert.match(paidLeavePolicy, /in \('incentive_vl', 'birthday_vl'\)/)
  assert.match(migration, /v_minutes := coalesce\(v_leave\.requested_leave_minutes, 0\)/)
  assert.match(migration, /v_minutes := 480/)
  assert.match(migration, /'prepaid_independent', true/)
  assert.match(reviewMigration, /A denial reason is required/)
  assert.match(reviewMigration, /set status = v_status/)
  assert.match(script, /workforce_review_leave_request/)
  assert.match(script, /leaveDurationLabel/)
  assert.match(script, /From \(\$\{scheduleTimezone\}\)/)
  assert.match(workforceSchedules, /leave_request:leave_requests!work_schedules_leave_request_id_fkey/)
  assert.match(workforceSchedules, /partialLeaveSummary/)
  assert.match(mySchedule, /leave_request:leave_requests!work_schedules_leave_request_id_fkey/)
  assert.match(mySchedule, /Half Day/)
  assert.match(teamAttendance, /\.eq\('is_leave', false\)/)
  assert.doesNotMatch(migration, /(?:insert into|update|delete from) public\.attendance/i)
  assert.doesNotMatch(migration, /public\.workforce_list_team_attendance|public\.workforce_clock_in/i)
  assert.doesNotMatch(migration, /payroll_prepaid_hours|payroll_schedule_snapshots/i)
})
