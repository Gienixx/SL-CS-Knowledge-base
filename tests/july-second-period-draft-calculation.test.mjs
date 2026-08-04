import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL(
  '../supabase/migrations/20260803135503_calculate_july_16_31_draft_payroll.sql',
  import.meta.url
), 'utf8')
const recalculationMigration = await readFile(new URL(
  '../supabase/migrations/20260803155202_allow_recalculation_after_attendance_reimport.sql',
  import.meta.url
), 'utf8')
const runbook = await readFile(new URL(
  '../docs/payroll-step-14-parallel-test.md',
  import.meta.url
), 'utf8')
const phaseUpdate = await readFile(new URL(
  '../docs/project-phase-update.md',
  import.meta.url
), 'utf8')

test('Almar current prepaid versions use the exact approved workbook windows', () => {
  assert.match(migration, /949d4e4547f92829a3a631e8d7b4712e45fedeac8a1ad14245cdcd231b47d590/)
  assert.match(migration, /date '2026-07-28'[\s\S]*283[\s\S]*11, 30[\s\S]*5, 30/)
  assert.match(migration, /date '2026-07-29'[\s\S]*284[\s\S]*14, 0[\s\S]*8, 0/)
  assert.match(migration, /date '2026-07-30'[\s\S]*285[\s\S]*10, 15[\s\S]*4, 15/)
  assert.match(migration, /date '2026-07-31'[\s\S]*286[\s\S]*9, 0[\s\S]*3, 0/)
  assert.match(migration, /'source_columns', 'E:F \(LOG IN \/ LOG OUT\)'/)
  assert.match(migration, /supersedes_snapshot_id/)
})

test('the second-period calculation is guarded, audited, and stays draft', () => {
  assert.match(migration, /public\.payroll_get_period_employee_readiness\(v_period_id\)/)
  assert.match(migration, /profile\.is_payroll_eligible/)
  assert.match(migration, /A testing-only profile is still payroll eligible or loaded/)
  assert.match(migration, /public\.payroll_import_attendance\(v_period_id\)/)
  assert.match(migration, /public\.payroll_calculate_draft\(v_period_id\)/)
  assert.match(migration, /v_current_attendance_snapshot_count <> 115/)
  assert.match(migration, /period\.status = 'draft'/)
  assert.match(migration, /audit\.action = 'payroll_draft_calculated'/)
  assert.doesNotMatch(migration, /payroll_finalize_period/)
  assert.doesNotMatch(migration, /payroll_generate_payslip/)
})

test('Step 14 records the calculated system baseline without inventing manual totals', () => {
  assert.match(runbook, /Status: calculated and ready for manual comparison/)
  assert.match(runbook, /System gross pay: USD 7,805\.90/)
  assert.match(runbook, /Prepaid minutes applied: 22,176/)
  assert.match(runbook, /Closing prepaid-minute balance: 14,124/)
  assert.match(runbook, /no signed manual gross-pay, deduction, or net-pay totals/)
  assert.match(runbook, /must not be inferred from the activity log/)
  assert.doesNotMatch(runbook, /Status: not ready for calculation/)
  assert.match(phaseUpdate, /Calculate the July 16–31 draft payroll for all 9 payable employees/)
})

test('Arby corrections are re-imported before guarded draft recalculation', () => {
  assert.match(recalculationMigration, /date '2026-07-29'/)
  assert.match(recalculationMigration, /0, 0, 0, 'America\/New_York'/)
  assert.match(recalculationMigration, /date '2026-07-30'/)
  assert.match(recalculationMigration, /0, 30, 0, 'America\/New_York'/)
  assert.match(recalculationMigration, /new_snapshot_count'\)::integer <> 2/)
  assert.match(recalculationMigration, /public\.payroll_calculate_draft\(v_period_id\)/)
  assert.match(recalculationMigration, /latest_attendance_versions_imported/)
  assert.match(recalculationMigration, /v_record\.calculation_version <> 2/)
  assert.match(recalculationMigration, /period did not remain an unapproved Draft/)
  assert.doesNotMatch(recalculationMigration, /payroll_finalize_period/)
  assert.doesNotMatch(recalculationMigration, /payroll_generate_payslip/)
})
