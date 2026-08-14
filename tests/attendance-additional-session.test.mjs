import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'

const script = await fs.readFile(new URL('../scripts/attendance.js', import.meta.url), 'utf8')
const migration = await fs.readFile(new URL('../supabase/migrations/20260814153838_reconcile_live_workforce_clock_in.sql', import.meta.url), 'utf8')

test('Additional work session has a dedicated sentinel and is rendered before selection is calculated', () => {
  assert.match(script, /const ADDITIONAL_WORK_SESSION = '__ADDITIONAL_WORK_SESSION__'/)
  assert.match(script, /const SCHEDULE_PLACEHOLDER = '__SCHEDULE_PLACEHOLDER__'/)
  assert.match(script, /Additional work session · Needs review/)
  assert.match(script, /appendChild\(additionalGroup\)[\s\S]*const optionValues/)
})

test('Additional eligibility requires a completed date, no open attendance, and no unused eligible schedule', () => {
  assert.match(script, /hasCompletedAttendanceForDate\(activeLocalDate\)/)
  assert.match(script, /!openAttendanceRecord\(\)/)
  assert.match(script, /hasUnusedEligibleSchedule/)
  assert.match(script, /next-day-special.*next-day-overnight.*special.*early.*active/)
})

test('Additional selection is preserved and submits null schedule_id', () => {
  assert.match(script, /optionValues\.includes\(previous\)/)
  assert.match(script, /elements\.scheduleSelect\.value = previous/)
  assert.match(script, /selectedValue === ADDITIONAL_WORK_SESSION \? null : selectedValue/)
  assert.match(script, /Please select a schedule or additional work session/)
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
