import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const finalMigrationPath = 'supabase/migrations/20260824131011_finalize_attendance_payroll_approval_state.sql'

const payrollFields = [
  'pre_shift_overtime_minutes',
  'regular_minutes',
  'post_shift_overtime_minutes',
  'rest_day_overtime_minutes',
  'holiday_overtime_minutes',
  'total_overtime_minutes',
  'overtime_minutes',
  'total_worked_minutes',
  'minutes_late',
  'is_late',
  'undertime_minutes'
]

function recalculateApprovalState({ reviewStatus, payrollApprovedAt, before, after }) {
  if (reviewStatus === 'locked') throw new Error('Locked attendance cannot be recalculated.')
  const changed = payrollFields.some(field => before[field] !== after[field])
  return {
    reviewStatus: changed && payrollApprovedAt && reviewStatus === 'approved' ? 'corrected' : reviewStatus,
    payrollApprovedAt: changed && payrollApprovedAt ? null : payrollApprovedAt
  }
}

test('recalculation preserves approval only for an effective no-op', async () => {
  const migration = await read(finalMigrationPath)
  assert.match(migration, /v_payroll_calculation_changed boolean/)
  for (const field of payrollFields) {
    assert.match(migration, new RegExp(`v_attendance\\.${field} is distinct from`))
  }
  assert.match(migration, /payroll_approved_at = case[\s\S]*then null/)
  assert.match(migration, /then ''corrected''/)

  const before = Object.fromEntries(payrollFields.map(field => [field, 10]))
  assert.deepEqual(
    recalculateApprovalState({
      reviewStatus: 'approved',
      payrollApprovedAt: '2026-08-24T01:00:00Z',
      before,
      after: { ...before }
    }),
    { reviewStatus: 'approved', payrollApprovedAt: '2026-08-24T01:00:00Z' }
  )
  assert.deepEqual(
    recalculateApprovalState({
      reviewStatus: 'approved',
      payrollApprovedAt: '2026-08-24T01:00:00Z',
      before,
      after: { ...before, regular_minutes: 9 }
    }),
    { reviewStatus: 'corrected', payrollApprovedAt: null }
  )
})

test('locked recalculation remains protected and work-date reset skips approved rows', async () => {
  const migration = await read(finalMigrationPath)
  assert.match(migration, /v_attendance\.review_status = ''locked''/)
  assert.match(migration, /Locked attendance cannot be recalculated\./)
  assert.match(migration, /workforce_recalculate_attendance_work_date\(uuid,date\)/)
  assert.match(migration, /and payroll_approved_at is null[\s\S]*and schedule_id is not null/)
  assert.throws(
    () => recalculateApprovalState({
      reviewStatus: 'locked',
      payrollApprovedAt: '2026-08-24T01:00:00Z',
      before: { regular_minutes: 10 },
      after: { regular_minutes: 11 }
    }),
    /Locked attendance cannot be recalculated/
  )
})

test('void and restore preserve approval unless the shared recalculation changes payroll values', async () => {
  const [migration, voidRestore] = await Promise.all([
    read(finalMigrationPath),
    read('supabase/migrations/20260819183555_void_attendance_operational_restore.sql')
  ])
  assert.match(migration, /workforce_delete_attendance\(uuid,text\)/)
  assert.match(migration, /workforce_restore_attendance\(uuid,text\)/)
  assert.doesNotMatch(migration, /payroll_approved_at = null[\s\S]{0,100}workforce_restore_attendance/)
  assert.match(voidRestore, /voided_at = null/)
  assert.match(voidRestore, /workforce_recalculate_attendance\(v_result\.id\)/)

  const values = { regular_minutes: 10, total_worked_minutes: 10 }
  assert.deepEqual(
    recalculateApprovalState({
      reviewStatus: 'approved',
      payrollApprovedAt: '2026-08-24T01:00:00Z',
      before: values,
      after: { ...values }
    }),
    { reviewStatus: 'approved', payrollApprovedAt: '2026-08-24T01:00:00Z' }
  )
})

test('meaningful schedule edits invalidate linked approval before recalculation', async () => {
  const migration = await read(finalMigrationPath)
  assert.match(migration, /workforce_admin_save_schedule\(uuid,uuid,date,integer,timestamptz,timestamptz,text,text,boolean,boolean,text,text\)/)
  assert.match(migration, /workforce_admin_save_open_schedule_without_audit_reason\(uuid,uuid,date,integer,text,text,text,integer\)/)
  assert.match(migration, /update public\.attendance[\s\S]*payroll_approved_at = null[\s\S]*perform public\.workforce_recalculate_attendance\(v_attendance_id\)/)
  assert.match(migration, /review_status = case when review_status = ''approved'' then ''corrected'' else review_status end/)
})

test('authenticated direct attendance reads retain all existing columns except the payroll marker', async () => {
  const [migration, attendanceScript, logMigration] = await Promise.all([
    read(finalMigrationPath),
    read('scripts/attendance.js'),
    read('supabase/migrations/20260819183555_void_attendance_operational_restore.sql')
  ])
  const grant = migration.match(/grant select \(([\s\S]*?)\) on table public\.attendance to authenticated/iu)?.[1] || ''
  assert.match(migration, /revoke select on table public\.attendance from authenticated/)
  assert.doesNotMatch(grant, /payroll_approved_at/)
  for (const field of [
    'id', 'user_id', 'schedule_id', 'work_date', 'clock_in', 'clock_out',
    'attendance_status', 'regular_minutes', 'total_overtime_minutes',
    'total_worked_minutes', 'review_status', 'billed_clock_in', 'billed_clock_out',
    'voided_at', 'manager_review_reason'
  ]) assert.match(grant, new RegExp(`\\b${field}\\b`))
  assert.match(attendanceScript, /\.from\('attendance'\)[\s\S]*\.select\('id, user_id, schedule_id/)
  assert.doesNotMatch(attendanceScript, /\.select\('[^']*payroll_approved_at/)
  assert.match(logMigration, /workforce_list_my_attendance_log\(date,date\)/)
  assert.doesNotMatch(logMigration, /payroll_approved_at/)
})

test('approval invalidation remains centralized while correction and reassignment clear directly', async () => {
  const [approval, finalMigration] = await Promise.all([
    read('supabase/migrations/20260824090000_attendance_payroll_approval_state.sql'),
    read(finalMigrationPath)
  ])
  assert.match(approval, /workforce_assign_attendance_schedule\(uuid,uuid,text,text\)/)
  assert.match(approval, /workforce_correct_attendance\(uuid,timestamptz,timestamptz,text,uuid,text,text,text\)/)
  assert.equal((approval.match(/payroll_approved_at = null/g) || []).length, 2)
  assert.match(finalMigration, /workforce_recalculate_attendance\(uuid\)/)
  assert.match(finalMigration, /v_payroll_calculation_changed/)
})
