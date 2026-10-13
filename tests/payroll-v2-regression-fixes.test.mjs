import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  calculatePaypalPayout,
  formatPaypalPayout,
  payrollV2ItemGroup,
  payrollV2ItemTypeLabel
} from '../shared/payroll-v2-payslip-formatting.mjs'
import { finalizeEmployeeSummary } from '../scripts/payroll-v2-finalization.mjs'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Payroll V2 leave calculation respects whole-day, half-day, and exact-time minutes', async () => {
  const [migration, leaveUi, oldLeaveMigration] = await Promise.all([
    read('supabase/migrations/20261014120000_payroll_v2_leave_and_shortfall_void.sql'),
    read('leave-requests.html'),
    read('supabase/migrations/20261007105945_partial_day_leave_support.sql')
  ])

  assert.match(leaveUi, /option value="whole_day">Whole Day \(8 paid hours\)/)
  assert.match(leaveUi, /option value="half_day">Half Day \(4 hours on an 8-hour shift\)/)
  assert.match(oldLeaveMigration, /requested_leave_minutes integer/)
  assert.match(oldLeaveMigration, /v_leave\.leave_duration in \('half_day', 'specific_time'\)[\s\S]*?v_minutes := coalesce\(v_leave\.requested_leave_minutes, 0\)/)
  assert.match(migration, /request\.requested_leave_minutes/)
  assert.match(migration, /when leave_date\.leave_duration in \('half_day', 'specific_time'\)[\s\S]*?then coalesce\(leave_date\.requested_leave_minutes, 0\)[\s\S]*?else 480/)
  assert.match(migration, /Payroll V2 leave calculation differs from the verified patch baseline/)
})

test('prior-cutoff voiding is employee-scoped, reasoned, audited, duplicate-safe, and immutable', async () => {
  const migration = await read('supabase/migrations/20261014120000_payroll_v2_leave_and_shortfall_void.sql')
  const [payrollScript, payrollPage] = await Promise.all([
    read('scripts/payroll-v2.js'),
    read('payroll-v2.html')
  ])
  const [fnStart, fnEnd] = [migration.indexOf('create or replace function public.payroll_v2_void_prior_committed_hours_shortfall('), migration.indexOf('comment on function public.payroll_v2_void_prior_committed_hours_shortfall(')]
  const fn = migration.slice(fnStart, fnEnd)

  assert.ok(fnStart >= 0 && fnEnd > fnStart)
  assert.match(fn, /workforce_has_permission\('create_payroll'\)[\s\S]*?workforce_has_permission\('review_payroll'\)/)
  assert.match(fn, /v_reason is null[\s\S]*?length\(v_reason\) < 5[\s\S]*?length\(v_reason\) > 1000/)
  assert.match(fn, /period\.status <> 'draft'/)
  assert.match(fn, /record\.status = 'calculated'[\s\S]*?record\.recalculation_pending_at is not null[\s\S]*?record\.approved_at is null[\s\S]*?record\.finalized_at is null/)
  assert.match(fn, /insert into public\.payroll_audit_logs/)
  assert.match(fn, /before_data,[\s\S]*?after_data,[\s\S]*?reason,[\s\S]*?metadata/)
  assert.match(fn, /'source_snapshots', coalesce\(v_source_row -> 'source_snapshots'/)
  assert.doesNotMatch(fn, /(?:update|delete)\s+public\.payroll_v2_(?:records|items|attendance_snapshots|committed_hours_snapshots)/i)
  assert.match(migration, /create unique index if not exists payroll_v2_prior_shortfall_void_once_idx/)
  assert.match(migration, /revoke all on function public\.payroll_v2_void_prior_committed_hours_shortfall[\s\S]*?to authenticated, service_role/)
  assert.match(migration, /'can_void', v_can_void/)
  assert.match(migration, /record\.approved_at is null[\s\S]*?record\.finalized_at is null/)
  assert.match(payrollScript, /canVoidPriorShortfall/)
  assert.match(payrollScript, /payroll_v2_void_prior_committed_hours_shortfall/)
  assert.match(payrollScript, /p_employee_user_id: pending\.employeeUserId[\s\S]*?p_prior_period_id: pending\.priorPeriodId[\s\S]*?p_reason: reason/)
  assert.match(payrollPage, /id="voidEmployeeAdjustmentReason"[^>]*minlength="5"[^>]*maxlength="1000"/)
})

test('payslip previews separate earnings and deductions in finalization, completed, and print views', async () => {
  const [payslip, payslipPage, payrollAdmin, payrollAdminPage, formatting, printStyles] = await Promise.all([
    read('scripts/payslip-v2-preview.js'),
    read('payslip-v2-preview.html'),
    read('scripts/payroll-v2.js'),
    read('payroll-v2.html'),
    read('shared/payroll-v2-payslip-formatting.mjs'),
    read('styles/payslip-v2-preview.css')
  ])

  assert.match(payslipPage, /<h2 id="payrollV2EarningsHeading">Earnings<\/h2>/)
  assert.match(payslipPage, /<h2 id="payrollV2DeductionsHeading">Deductions<\/h2>/)
  assert.match(payslipPage, /Earnings subtotal/)
  assert.match(payslipPage, /Deductions subtotal/)
  assert.match(payslip, /payrollV2ItemGroup\(item\)/)
  assert.match(payslip, /formatPayrollMoney\(totals\.gross_pay, currencyCode\)/)
  assert.match(payslip, /formatPayrollMoney\(Math\.abs\(Number\(totals\.total_deductions/)
  assert.match(payrollAdminPage, /<h3 id="finalizeItemsHeading">Earnings<\/h3>/)
  assert.match(payrollAdminPage, /<h3 id="finalizeDeductionsHeading">Deductions<\/h3>/)
  assert.match(payrollAdmin, /payrollV2ItemGroup\(item\)/)
  assert.match(payslipPage, /payslip-v2-earnings-table/)
  assert.match(payslipPage, /payslip-v2-deductions-table/)
  assert.match(payslipPage, /id="printPayrollV2PayslipButton"/)
  assert.match(printStyles, /@media print[\s\S]*?#payrollV2PayslipSheet,[\s\S]*?#payrollV2PayslipSheet \*/)
  assert.match(payslip, /window\.print\(\)/)
  assert.match(formatting, /return String\(item\?\.item_type \|\| ''\)\.toLowerCase\(\) === 'deduction'/)

  assert.equal(payrollV2ItemGroup({ item_type: 'attendance' }), 'earnings')
  assert.equal(payrollV2ItemGroup({ item_type: 'deduction' }), 'deductions')
  assert.equal(payrollV2ItemTypeLabel({ item_type: 'paid_leave' }), 'Paid VL')
  assert.equal(payrollV2ItemTypeLabel({ item_type: 'manual_earning', description: 'Spot Bonus' }), 'Bonus')
  assert.equal(payrollV2ItemTypeLabel({ item_type: 'deduction', description: 'Cash Advance' }), 'Cash Advance')
  assert.equal(payrollV2ItemTypeLabel({ item_type: 'deduction', description: 'Hour Offset' }), 'Hour Offset')
  assert.equal(payrollV2ItemTypeLabel({ item_type: 'deduction', description: 'Committed Hours Shortfall — Prior Cutoff' }), 'Previous Cutoff Shortfall')
  assert.equal(payrollV2ItemTypeLabel({ item_type: 'deduction', description: 'Other adjustment' }), 'Other deduction')
})

test('saved USD net pay converts one time at the period rate and final preview remains read-only', async () => {
  const [page, script, finalization] = await Promise.all([
    read('payslip-v2-preview.html'),
    read('scripts/payslip-v2-preview.js'),
    read('scripts/payroll-v2-finalization.mjs')
  ])
  assert.equal(calculatePaypalPayout(690.67, 'USD', 60.8007), 41993.22)
  assert.equal(calculatePaypalPayout(690.67, 'PHP', 60.8007), null)
  assert.equal(calculatePaypalPayout(null, 'USD', 60.8007), null)
  assert.equal(calculatePaypalPayout(690.67, 'USD', null), null)
  assert.match(formatPaypalPayout(690.67, 'USD', 60.8007), /41,993\.22/)
  assert.match(page, /PayPal payout \(PHP\)/)
  assert.match(script, /formatPaypalPayout\(totals\.net_pay, currencyCode, period\.paypal_conversion_rate\)/)
  assert.match(finalization, /formatPaypalPayout\(saved\?\.net_pay, currencyCode, period\?\.paypal_conversion_rate\)/)

  const savedItems = [
    { item_type: 'attendance', amount: 600 },
    { item_type: 'deduction', amount: 100 }
  ]
  const summary = finalizeEmployeeSummary({
    currency_code: 'USD', gross_pay: 600, total_deductions: 100, net_pay: 500,
    items: savedItems, persistence: { record_status: 'approved' }
  }, { period_start: '2026-10-01', period_end: '2026-10-15', paypal_conversion_rate: 60.8007 })
  assert.equal(summary.grossPay, 600)
  assert.equal(summary.deductionsSubtotal, 100)
  assert.equal(summary.netPay, 500)
  assert.equal(summary.paypalConversionRate, 60.8007)
  assert.equal(summary.paypalPayout, formatPaypalPayout(500, 'USD', 60.8007))
  assert.deepEqual(savedItems, [
    { item_type: 'attendance', amount: 600 },
    { item_type: 'deduction', amount: 100 }
  ])
})
