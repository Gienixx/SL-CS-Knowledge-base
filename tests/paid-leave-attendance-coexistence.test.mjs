import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const migration = fs.readFileSync('supabase/migrations/20260810122500_paid_leave_attendance_coexistence.sql', 'utf8')
const correctiveMigration = fs.readFileSync('supabase/migrations/20260810122937_correct_paid_leave_prepaid_independence.sql', 'utf8')

function payableMinutes(approvedPaidLeave, approvedBilledAttendance) {
  return (approvedPaidLeave ? 480 : 0) + approvedBilledAttendance
}

test('paid leave examples remain additive', () => {
  assert.equal(payableMinutes(true, 0), 480)
  assert.equal(payableMinutes(true, 120), 600)
  assert.equal(payableMinutes(true, 480), 960)
  assert.equal(payableMinutes(false, 120), 120)
})

test('paid leave is limited to configured paid leave types', () => {
  assert.match(migration, /in \('incentive_vl', 'birthday_vl'\)/)
  assert.match(migration, /paid_leave_minutes = 0/)
})

test('approved leave preserves normal schedules and adds a separate leave schedule', () => {
  assert.match(migration, /Keep any normal schedule and its attendance intact/)
  assert.match(migration, /and schedule\.is_leave\r?\n\s+and schedule\.leave_request_id = new\.id/)
  assert.doesNotMatch(migration, /conflicting_attendance_count/)
  assert.match(migration, /workforce_apply_approved_leave_to_new_schedule\(\)[\s\S]*?return new;/)
})

test('clock-in excludes leave schedules but permits normal or unscheduled attendance', () => {
  assert.match(migration, /not schedule\.is_leave and not schedule\.is_absent/)
  assert.match(migration, /Leave and absence schedules cannot be used for timed attendance/)
  assert.match(migration, /schedule_id, v_work_date/)
})

test('paid leave earning is additive, normal-rate, non-premium, and prepaid-safe', () => {
  assert.match(correctiveMigration, /v_minutes := 480/)
  assert.match(correctiveMigration, /paid_leave_earnings/)
  assert.match(correctiveMigration, /premium_pay.*false/)
  assert.match(correctiveMigration, /prepaid_independent.*true/)
  assert.doesNotMatch(correctiveMigration, /v_prepaid integer/)
})

test('prepaid balances cannot offset paid or incentive leave', () => {
  assert.match(correctiveMigration, /Paid leave is an independent fixed entitlement/)
  assert.match(correctiveMigration, /prepaid_independent.*true/)
  assert.doesNotMatch(correctiveMigration, /greatest\(480 - coalesce\(v_prepaid/)
})

test('corrective migration removes live prepaid offset logic', () => {
  assert.match(correctiveMigration, /v_minutes := 480/)
  assert.match(correctiveMigration, /prepaid_independent.*true/)
  assert.doesNotMatch(correctiveMigration, /(?:from|join) public\.payroll_prepaid_hours/)
  assert.doesNotMatch(correctiveMigration, /v_prepaid/)
})

test('attendance and leave remain independently auditable and protected', () => {
  assert.match(migration, /leave_request_id/)
  assert.match(migration, /workforce_audit_logs/)
  assert.match(migration, /not schedule\.is_leave and not schedule\.is_absent/)
})
