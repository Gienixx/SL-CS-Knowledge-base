import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath =
  'supabase/migrations/20260729165328_manage_payroll_adjustments.sql'

test('Step 9 supports only controlled manual earnings and deductions', async () => {
  const migration = await read(migrationPath)

  assert.match(
    migration,
    /p_item_type not in \('earning', 'deduction'\)/
  )
  assert.match(
    migration,
    /item_code in \('manual_earning', 'manual_deduction'\)/
  )
  assert.match(migration, /p_amount <= 0/)
  assert.match(migration, /round\(p_amount, 2\)/)
  assert.match(
    migration,
    /Calculate draft payroll before adding adjustments/
  )
  assert.doesNotMatch(
    migration,
    /p_item_type[\s\S]{0,120}government/
  )
})

test('Draft payroll UI exposes billed hours, prepaid consumption, rate override, and estimates', async () => {
  const [page, script] = await Promise.all([
    read('payroll-period.html'),
    read('scripts/payroll-period.js')
  ])

  assert.match(page, /<th>Hours<\/th>/)
  assert.match(page, /<th>Rate<\/th>/)
  assert.match(script, /approvedBilledMinutes/)
  assert.match(script, /Prepaid consumed/)
  assert.match(script, /New regular/)
  assert.match(script, /New prepaid/)
  assert.match(script, /Remaining prepaid/)
  assert.match(script, /rateOverrides/)
  assert.match(script, /period_status === 'finalized'/)
  assert.match(script, /payroll-rate-override/)
})

test('every adjustment mutation rebuilds totals and writes a complete audit event', async () => {
  const migration = await read(migrationPath)

  for (const action of [
    'payroll_adjustment_added',
    'payroll_adjustment_updated',
    'payroll_adjustment_removed'
  ]) {
    assert.match(migration, new RegExp(`'${action}'`))
  }

  assert.match(
    migration,
    /perform public\.payroll_rebuild_record_totals\(v_record\.id\)/
  )
  assert.match(
    migration,
    /v_total_deductions > v_gross_pay[\s\S]*?net pay negative/
  )
  assert.match(migration, /before_data,[\s\S]*?after_data/)
  assert.match(migration, /'adjustment_version'/)
})

test('private notes and editability are enforced at the database boundary', async () => {
  const migration = await read(migrationPath)

  assert.match(
    migration,
    /payroll_items_private_notes_not_exposed_check[\s\S]*?correction_notes is null/
  )
  assert.match(
    migration,
    /'private_correction_notes', v_private_notes/
  )
  assert.match(
    migration,
    /v_period_status not in \('draft', 'reopened'\)/
  )
  assert.match(
    migration,
    /v_record\.status in \('approved', 'finalized', 'void'\)/
  )
  assert.match(
    migration,
    /workforce_has_permission\('create_payroll'\)/
  )
  assert.match(
    migration,
    /revoke all on function public\.payroll_save_adjustment\([\s\S]*?from public, anon/
  )
  assert.match(
    migration,
    /revoke all on function public\.payroll_rebuild_record_totals\(uuid\)[\s\S]*?from public, anon, authenticated/
  )
})

test('payroll period provides add, edit, remove, reasons, and private notes UI', async () => {
  const [page, script, styles] = await Promise.all([
    read('payroll-period.html'),
    read('scripts/payroll-period.js'),
    read('styles/payroll-periods.css')
  ])

  assert.match(page, /id="addPayrollAdjustmentButton"/)
  assert.match(page, /id="payrollAdjustmentDialog"/)
  assert.match(page, /Employee-visible description/)
  assert.match(page, /Private correction notes/)
  assert.doesNotMatch(page, /Government deduction/)
  assert.match(page, /scripts\/payroll-period\.js\?v=10/)
  assert.match(page, /styles\/payroll-periods\.css\?v=10/)

  assert.match(script, /supabase\.rpc\('payroll_save_adjustment'/)
  assert.match(script, /supabase\.rpc\('payroll_remove_adjustment'/)
  assert.match(script, /supabase\.rpc\('payroll_get_period_adjustments'/)
  assert.match(script, /openAdjustmentDialog\('add'\)/)
  assert.match(script, /data-adjustment-action/)
  assert.doesNotMatch(
    script,
    /console\.(?:log|debug|info).*adjustment/i
  )
  assert.match(styles, /\.payroll-adjustment-table/)
  assert.match(styles, /\.payroll-adjustment-dialog/)

  const syntax = spawnSync(process.execPath, ['--check', 'scripts/payroll-period.js'], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8'
  })
  assert.equal(syntax.status, 0, syntax.stderr)
})

test('Step 9 verification checks grants, privacy, totals, and audit history', async () => {
  const verification = await read(
    'supabase/verification/payroll_adjustments_check.sql'
  )

  assert.match(verification, /save_adjustment_exists_should_be_true/)
  assert.match(verification, /anon_can_save_adjustment_should_be_false/)
  assert.match(
    verification,
    /authenticated_can_rebuild_totals_should_be_false/
  )
  assert.match(verification, /exposed_private_note_count_should_be_zero/)
  assert.match(verification, /manual_total_mismatch_count_should_be_zero/)
  assert.match(verification, /adjustment_audit_event_count/)
})
