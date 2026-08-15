import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import {
  canUseAdditionalWorkSession,
  canUseUnscheduledWorkSession,
  restoreScheduleSelection
} from '../shared/attendance-additional-session.js'

const script = await fs.readFile(new URL('../scripts/attendance.js', import.meta.url), 'utf8')
const eligibility = await fs.readFile(new URL('../shared/attendance-additional-session.js', import.meta.url), 'utf8')
const migration = await fs.readFile(new URL('../supabase/migrations/20260814153838_reconcile_live_workforce_clock_in.sql', import.meta.url), 'utf8')
const fallbackMigration = await fs.readFile(new URL('../supabase/migrations/20260816100000_unscheduled_attendance_clock_in_fallback.sql', import.meta.url), 'utf8')

test('Additional work session has a dedicated sentinel and is rendered before selection is calculated', () => {
  assert.match(script, /const ADDITIONAL_WORK_SESSION = '__ADDITIONAL_WORK_SESSION__'/)
  assert.match(script, /const SCHEDULE_PLACEHOLDER = '__SCHEDULE_PLACEHOLDER__'/)
  assert.match(script, /Additional work session · Needs review/)
  assert.match(script, /appendChild\(additionalGroup\)[\s\S]*const optionValues/)
})

test('Additional eligibility requires a completed date, no open attendance, and no unused eligible schedule', () => {
  assert.match(script, /canUseAdditionalWorkSession/)
  assert.match(script, /function selectedWorkDate\(\)/)
  assert.match(eligibility, /schedule\.is_leave \|\| schedule\.is_absent/)
  assert.match(script, /next-day-special.*next-day-overnight.*special.*early.*active/)
})

test('completed normal schedule with no second schedule enables Additional Work Session', () => {
  assert.equal(canUseAdditionalWorkSession({
    workDate: '2026-08-15',
    attendance: [{ work_date: '2026-08-15', schedule_id: 'sequence-1', clock_in: '10:00', clock_out: '18:00' }],
    schedules: [{ id: 'sequence-1', shift_date: '2026-08-15' }],
    isEligibleSchedule: () => true
  }), true)
})

test('completed Rest Day/RDOT with no second schedule enables Additional Work Session', () => {
  assert.equal(canUseAdditionalWorkSession({
    workDate: '2026-08-15',
    attendance: [{ work_date: '2026-08-15', schedule_id: 'rest-day', clock_in: '10:00', clock_out: '12:00' }],
    schedules: [{ id: 'rest-day', shift_date: '2026-08-15', is_rest_day: true }],
    isEligibleSchedule: () => true
  }), true)
})

test('selected Aug 14 completed RDOT is eligible while the current date is Aug 15', () => {
  const currentLocalDate = '2026-08-15'
  const selectedSchedule = { id: 'rdot-aug14-sequence-1', shift_date: '2026-08-14', is_rest_day: true }

  assert.equal(canUseAdditionalWorkSession({
    workDate: selectedSchedule.shift_date,
    attendance: [{
      work_date: '2026-08-14',
      schedule_id: selectedSchedule.id,
      clock_in: '2026-08-14T10:00:00+08:00',
      clock_out: '2026-08-14T12:00:00+08:00'
    }],
    schedules: [selectedSchedule],
    isEligibleSchedule: () => true
  }), true)
  assert.notEqual(currentLocalDate, selectedSchedule.shift_date)
})

test('an unused eligible second schedule takes priority over Additional Work Session', () => {
  assert.equal(canUseAdditionalWorkSession({
    workDate: '2026-08-15',
    attendance: [{ work_date: '2026-08-15', schedule_id: 'sequence-1', clock_in: '10:00', clock_out: '18:00' }],
    schedules: [
      { id: 'sequence-1', shift_date: '2026-08-15' },
      { id: 'sequence-2', shift_date: '2026-08-15' }
    ],
    isEligibleSchedule: schedule => schedule.id === 'sequence-2'
  }), false)
})

test('leave-only additional sequence does not become a timed assigned schedule', () => {
  assert.equal(canUseAdditionalWorkSession({
    workDate: '2026-08-15',
    attendance: [{ work_date: '2026-08-15', schedule_id: 'sequence-1', clock_in: '10:00', clock_out: '18:00' }],
    schedules: [{ id: 'leave-sequence', shift_date: '2026-08-15', is_leave: true }],
    isEligibleSchedule: () => true
  }), true)
})

test('no published schedule makes Unscheduled work available', () => {
  assert.equal(canUseUnscheduledWorkSession({
    workDate: '2026-08-15',
    attendance: [],
    schedules: []
  }), true)
})

test('an unused published schedule suppresses Unscheduled work', () => {
  assert.equal(canUseUnscheduledWorkSession({
    workDate: '2026-08-15',
    attendance: [],
    schedules: [{ id: 'sequence-1', shift_date: '2026-08-15' }]
  }), false)
})

test('completed RDOT does not suppress Unscheduled work or reset its sentinel selection', () => {
  const rdot = { id: 'rdot-aug14', shift_date: '2026-08-14', status: 'published', is_rest_day: true }
  const attendance = [{ work_date: '2026-08-14', schedule_id: rdot.id, clock_in: '10:00', clock_out: '12:00' }]
  assert.equal(canUseUnscheduledWorkSession({
    workDate: '2026-08-14',
    attendance,
    schedules: [rdot]
  }), true)
  assert.equal(restoreScheduleSelection('__UNSCHEDULED_WORK__', ['rdot-aug14', '__UNSCHEDULED_WORK__'], 'rdot-aug14'), '__UNSCHEDULED_WORK__')
})

test('leave-only schedules still make Unscheduled work available', () => {
  assert.equal(canUseUnscheduledWorkSession({
    workDate: '2026-08-15',
    attendance: [],
    schedules: [{ id: 'leave', shift_date: '2026-08-15', is_leave: true }]
  }), true)
})

test('completed Additional Work Session with no published schedule still allows Unscheduled work', () => {
  assert.equal(canUseAdditionalWorkSession({
    workDate: '2026-08-15',
    attendance: [{ work_date: '2026-08-15', clock_in: '10:00', clock_out: '12:00' }],
    schedules: [],
    isEligibleSchedule: () => true
  }), false)
  assert.equal(canUseUnscheduledWorkSession({
    workDate: '2026-08-15',
    attendance: [{ work_date: '2026-08-15', clock_in: '10:00', clock_out: '12:00' }],
    schedules: []
  }), true)
})

test('an open attendance blocks both unscheduled fallback and concurrent clock-in', () => {
  assert.equal(canUseUnscheduledWorkSession({
    workDate: '2026-08-15',
    attendance: [{ work_date: '2026-08-15', clock_in: '10:00', clock_out: null }],
    schedules: []
  }), false)
})

test('Additional selection is preserved and submits null schedule_id', () => {
  assert.match(script, /restoreScheduleSelection\(\s*previous,\s*optionValues/)
  assert.match(script, /elements\.scheduleSelect\.value = previous/)
  assert.match(script, /\[ADDITIONAL_WORK_SESSION, UNSCHEDULED_WORK\]\.includes\(selectedValue\) \? null : selectedValue/)
  assert.match(script, /Please select a schedule or additional work session/)
})

test('Additional selection enables Clock In without weakening normal schedule guards', () => {
  assert.match(script, /const hasExplicitSelection = Boolean\(schedule\) \|\| isAdditionalWorkSessionSelected\(\) \|\| isUnscheduledWorkSelected\(\)/)
  assert.match(script, /isAdditionalWorkSessionSelected\(\)\s*\?\s*canClockAdditionalSession\(\)\s*:\s*isUnscheduledWorkSelected\(\)/)
  assert.match(script, /isUnscheduledWorkSelected\(\) && canClockUnscheduledWork\(\)/)
  assert.match(script, /const selectedCompleted = !isAdditionalWorkSessionSelected\(\) && !isUnscheduledWorkSelected\(\)/)
  assert.match(script, /Boolean\(openRecord\)/)
  assert.match(script, /SCHEDULE_PLACEHOLDER/)
  assert.match(script, /restoreScheduleSelection\(\s*previous,\s*optionValues/)
})

test('Unscheduled work selection is distinct and preserves the pending null-schedule workflow', () => {
  assert.match(script, /const UNSCHEDULED_WORK = '__UNSCHEDULED_WORK__'/)
  assert.match(script, /Unscheduled work · Needs review/)
  assert.match(script, /\[ADDITIONAL_WORK_SESSION, UNSCHEDULED_WORK\]\.includes\(selectedValue\) \? null : selectedValue/)
  assert.match(script, /isUnscheduledWorkSelected\(\) && canClockUnscheduledWork\(\)/)
  assert.match(migration, /review_status = case when p_schedule_id is null then 'pending'/)
})

test('the fallback migration permits separate completed unscheduled sessions', () => {
  assert.match(fallbackMigration, /drop index if exists public\.attendance_user_unscheduled_date_unique/)
})

test('Additional submission uses a separate pending unscheduled attendance row', () => {
  assert.match(migration, /p_schedule_id is null/)
  assert.match(migration, /a\.schedule_id is null/)
  assert.match(migration, /review_status = case when p_schedule_id is null then 'pending'/)
  assert.match(migration, /work_date = v_work_date/)
  assert.match(migration, /v_work_date := v_schedule\.shift_date/)
})

test('existing Attendance protections remain represented', () => {
  assert.match(script, /workforce_clock_out/)
  assert.match(migration, /v_schedule\.is_rest_day or v_schedule\.is_holiday/)
  assert.match(migration, /shift_start is null or v_schedule\.shift_end is null/)
})
