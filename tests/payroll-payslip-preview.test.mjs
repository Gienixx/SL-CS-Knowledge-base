import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationPath =
  'supabase/migrations/20260729185050_finalized_payslip_preview.sql'

test('finalized payslip preview is permission scoped and excludes private notes', async () => {
  const migration = await readFile(migrationPath, 'utf8')

  for (const requirement of [
    'payroll_get_payslip_number',
    'payroll_get_payslip_preview',
    "record.status = 'finalized'",
    "period.status = 'finalized'",
    "workforce_has_permission('view_all_payslips')",
    "workforce_has_permission('view_own_payslips')",
    'workforce_is_current_identity',
    "'viewer_scope'",
    "'can_view_rates'",
    "'rates_used'",
    "'prepaid_summary'",
    "'approval'"
  ]) {
    assert.match(migration, new RegExp(requirement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }

  assert.match(
    migration,
    /case when v_can_view_rates then item\.unit_rate else null end/
  )
  assert.match(
    migration,
    /if v_can_view_rates then[\s\S]*?else[\s\S]*?v_rates := '\[\]'::jsonb/
  )
  assert.doesNotMatch(migration, /v_record\.correction_notes/)
  assert.doesNotMatch(migration, /v_record\.adjustment_reason/)
  assert.match(
    migration,
    /revoke all on function public\.payroll_get_payslip_preview\(uuid\)[\s\S]*?from public, anon/
  )
  assert.match(
    migration,
    /grant execute on function public\.payroll_get_payslip_preview\(uuid\)[\s\S]*?to authenticated, service_role/
  )
  assert.match(
    migration,
    /payroll_get_payslip_number\(uuid\)[\s\S]*?from public, anon, authenticated/
  )
})

test('Step 11 page renders the complete finalized payslip', async () => {
  const [html, script, css] = await Promise.all([
    readFile('payslip-preview.html', 'utf8'),
    readFile('scripts/payslip-preview.js', 'utf8'),
    readFile('styles/payslip-preview.css', 'utf8')
  ])

  for (const id of [
    'payslipNumber',
    'payslipEmployeeName',
    'payslipPeriod',
    'payslipPaymentDate',
    'payslipRatesSection',
    'payslipEarningsBody',
    'payslipDeductionsBody',
    'payslipPrepaidAdded',
    'payslipPrepaidApplied',
    'payslipPrepaidClosing',
    'payslipGrossTotal',
    'payslipDeductionTotal',
    'payslipNetTotal',
    'payslipApprovedBy',
    'printPayslipButton'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`))
  }

  assert.match(script, /payroll_get_payslip_preview/)
  assert.match(script, /preview\.viewer_scope === 'payroll'/)
  assert.match(script, /elements\.ratesSection\.hidden = !canViewRates/)
  assert.match(script, /window\.print\(\)/)
  assert.doesNotMatch(script, /console\./)
  assert.match(css, /\.payslip-sheet[\s\S]*?width: 210mm/)
  assert.match(css, /@page \{ size: A4; margin: 0; \}/)
  assert.match(css, /@media print/)
})

test('finalized payroll records link to their payslip preview', async () => {
  const [script, css] = await Promise.all([
    readFile('scripts/payroll-period.js', 'utf8'),
    readFile('styles/payroll-periods.css', 'utf8')
  ])

  assert.match(
    script,
    /period_status === 'finalized'[\s\S]*?payslip-preview\.html\?record=/
  )
  assert.match(script, /encodeURIComponent\(calculation\.payroll_record_id\)/)
  assert.match(css, /\.payroll-payslip-preview-link/)
})

test('Step 11 verification checks grants, privacy, and stable numbering', async () => {
  const verification = await readFile(
    'supabase/verification/payroll_payslip_preview_check.sql',
    'utf8'
  )

  assert.match(verification, /anon_can_preview_should_be_false/)
  assert.match(verification, /authenticated_can_preview_guarded_should_be_true/)
  assert.match(verification, /authenticated_can_call_number_helper_should_be_false/)
  assert.match(verification, /private_note_reference_count_should_be_zero/)
  assert.match(verification, /duplicate_generated_number_count_should_be_zero/)
})
