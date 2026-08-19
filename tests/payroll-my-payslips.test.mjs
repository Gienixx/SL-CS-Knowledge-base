import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationPath =
  'supabase/migrations/20260729140136_list_own_payslips.sql'

test('own-payslip list is finalized, permission checked, and identity scoped', async () => {
  const migration = await readFile(migrationPath, 'utf8')

  for (const requirement of [
    'payroll_list_my_payslips',
    "workforce_has_permission('view_own_payslips')",
    'workforce_is_current_identity(record.employee_id)',
    "record.status = 'finalized'",
    "period.status = 'finalized'",
    "'prepaid_summary'",
    "'document_version'"
  ]) {
    assert.match(
      migration,
      new RegExp(requirement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    )
  }

  for (const excluded of [
    'storage_path',
    'adjustment_reason',
    'correction_notes',
    'agent_rates',
    'payroll_hour_allocations'
  ]) {
    assert.doesNotMatch(migration, new RegExp(excluded))
  }

  assert.match(
    migration,
    /revoke all on function public\.payroll_list_my_payslips\(\)[\s\S]*?from public, anon/
  )
  assert.match(
    migration,
    /grant execute on function public\.payroll_list_my_payslips\(\)[\s\S]*?to authenticated, service_role/
  )
})

test('Step 13 page offers own preview, private download, print, and prepaid summary', async () => {
  const [html, script, css, home, homeNav, preview] = await Promise.all([
    readFile('my-payslips.html', 'utf8'),
    readFile('scripts/my-payslips.js', 'utf8'),
    readFile('styles/my-payslips.css', 'utf8'),
    readFile('home.html', 'utf8'),
    readFile('scripts/home-workforce-nav.js', 'utf8'),
    readFile('scripts/payslip-preview.js', 'utf8')
  ])

  for (const id of [
    'myPayslipCount',
    'myPayslipLatestPayment',
    'myPayslipLatestNet',
    'myPayslipPdfCount',
    'myPayslipsTableBody',
    'refreshMyPayslipsButton'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`))
  }

  assert.match(script, /requireWorkforcePermission\([\s\S]*?'view_own_payslips'/)
  assert.match(script, /payroll_list_my_payslips/)
  assert.match(script, /payslip-preview\.html\?record=/)
  assert.match(script, /&print=1/)
  assert.match(script, /api\/payslips\/signed-url/)
  assert.match(script, /prepaid_summary/)
  assert.doesNotMatch(script, /console\./)
  assert.match(css, /\.my-payslips-actions/)
  assert.match(home, /id="homeMyPayslipsBtn"[\s\S]*?my-payslips\.html/)
  assert.match(homeNav, /view_own_payslips/)
  assert.match(preview, /printRequested[\s\S]*?window\.print\(\)/)
  assert.match(preview, /: '\.\/my-payslips\.html'/)
})

test('Step 13 verification checks grants and private field exclusion', async () => {
  const verification = await readFile(
    'supabase/verification/payroll_my_payslips_check.sql',
    'utf8'
  )

  assert.match(verification, /anon_can_list_should_be_false/)
  assert.match(verification, /authenticated_can_list_guarded_should_be_true/)
  assert.match(verification, /enforces_current_identity_should_be_true/)
  assert.match(verification, /storage_path_reference_count_should_be_zero/)
  assert.match(verification, /rate_reference_count_should_be_zero/)
})
