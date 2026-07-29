import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationPath =
  'supabase/migrations/20260729180837_approve_finalize_payroll.sql'
const hardeningPath =
  'supabase/migrations/20260729182410_harden_payroll_finalization_guards.sql'

test('Step 10 verifies and records review and final approval', async () => {
  const migration = await readFile(migrationPath, 'utf8')

  for (const requirement of [
    'payroll_refresh_period_totals',
    'payroll_collect_finalization_evidence',
    'payroll_assert_ready_for_approval',
    'payroll_review_period',
    'payroll_finalize_period',
    'reviewed_by',
    'approved_by',
    'finalized_by',
    'finalization_evidence',
    'finalization_version',
    'payroll_period_reviewed',
    'payroll_period_finalized'
  ]) {
    assert.match(migration, new RegExp(requirement))
  }

  assert.match(migration, /payroll_get_period_exceptions[\s\S]*?is_blocking/)
  assert.match(migration, /attendance_version <>[\s\S]*?snapshot\.attendance_version/)
  assert.match(migration, /schedule\.schedule_version <> item\.source_schedule_version/)
  assert.match(migration, /rate\.effective_date <= item\.work_date/)
  assert.match(migration, /opening_minutes[\s\S]*?added_minutes[\s\S]*?applied_minutes[\s\S]*?closing_minutes/)
  assert.match(migration, /money_scale[\s\S]*?minute_conversion[\s\S]*?rounding_mode/)
  assert.match(migration, /workforce_has_permission\('review_payroll'\)/)
  assert.match(migration, /workforce_has_permission\('finalize_payroll'\)/)
})

test('finalized payroll history is immutable and reopening is controlled', async () => {
  const migration = await readFile(migrationPath, 'utf8')
  const hardening = await readFile(hardeningPath, 'utf8')

  for (const trigger of [
    'payroll_periods_finalized_immutable',
    'payroll_records_finalized_immutable',
    'payroll_items_finalized_immutable',
    'payroll_attendance_snapshots_finalized_insert_guard',
    'payroll_schedule_snapshots_finalized_insert_guard',
    'payroll_hour_allocations_finalized_insert_guard',
    'payslips_immutable',
    'payroll_audit_logs_immutable'
  ]) {
    assert.match(migration, new RegExp(trigger))
  }

  assert.match(migration, /workforce_has_permission\('reopen_payroll'\)/)
  assert.match(migration, /length\(v_reason\) < 5/)
  assert.match(migration, /app\.payroll_controlled_reopen/)
  assert.match(migration, /requires_recalculation = true/)
  assert.match(migration, /payroll_period_reopened/)
  assert.match(migration, /generated payslips[\s\S]*?regeneration workflow/i)
  assert.match(hardening, /v_old_finalized/)
  assert.match(hardening, /v_new_finalized/)
})

test('payroll period exposes permission-aware Step 10 controls', async () => {
  const [html, script, css] = await Promise.all([
    readFile('payroll-period.html', 'utf8'),
    readFile('scripts/payroll-period.js', 'utf8'),
    readFile('styles/payroll-periods.css', 'utf8')
  ])

  for (const id of [
    'reviewPayrollButton',
    'finalizePayrollButton',
    'reopenPayrollButton',
    'payrollFinalizationChecks',
    'payrollReviewer',
    'payrollApprover',
    'payrollFinalizationStatus',
    'payrollLifecycleDialog',
    'payrollLifecycleReason',
    'payrollLifecycleConfirm'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`))
  }

  assert.match(script, /payroll_get_period_lifecycle/)
  assert.match(script, /payroll_review_period/)
  assert.match(script, /payroll_finalize_period/)
  assert.match(script, /payroll_reopen_period/)
  assert.match(script, /hasWorkforcePermission\([\s\S]*?'review_payroll'/)
  assert.match(script, /hasWorkforcePermission\([\s\S]*?'finalize_payroll'/)
  assert.match(script, /hasWorkforcePermission\([\s\S]*?'reopen_payroll'/)
  assert.match(script, /I understand finalized payroll is immutable/)
  assert.match(css, /\.payroll-finalization-checks/)
  assert.match(css, /\.payroll-lifecycle-evidence/)
})

test('Step 10 verification checks grants, locks, totals, and audit evidence', async () => {
  const verification = await readFile(
    'supabase/verification/payroll_finalization_check.sql',
    'utf8'
  )

  assert.match(verification, /anon_can_finalize_should_be_false/)
  assert.match(verification, /invalid_finalized_period_count_should_be_zero/)
  assert.match(verification, /invalid_finalized_record_count_should_be_zero/)
  assert.match(verification, /payroll_periods_finalized_immutable/)
  assert.match(verification, /payroll_audit_logs_immutable/)
  assert.match(verification, /payroll_periods_reviewed_by_idx/)
  assert.match(verification, /payroll_period_finalized/)
})
