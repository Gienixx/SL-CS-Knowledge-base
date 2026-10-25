import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  canFinalizeEmployeeAction,
  submitEmployeeFinalization
} from '../scripts/payroll-v2-finalization.mjs'
import { visibleCompletedPayslips } from '../scripts/payroll-v2-completed-count.mjs'

const read = path => readFile(new URL(path, import.meta.url), 'utf8')

test('Home Payroll Management navigation opens Payroll V2 as its primary destination', async () => {
  const home = await read('../home.html')
  const payrollLink = home.match(/<a\b[^>]*id="homePayrollDashboardBtn"[^>]*>[\s\S]*?<\/a>/)

  assert.ok(payrollLink, 'primary Payroll Management navigation should exist')
  assert.match(payrollLink[0], /href="\.\/payroll-v2\.html"/)
  assert.match(payrollLink[0], />Payroll Management<\/span>/)
  assert.doesNotMatch(payrollLink[0], /payroll-dashboard\.html|payroll-period\.html/)

  const legacyPage = await read('../payroll-dashboard.html')
  assert.match(legacyPage, /Payroll · Period management/)
})

test('Payroll V2 route references the restored page assets and individual review flow', async () => {
  const [page, script, stylesheet, finalization] = await Promise.all([
    read('../payroll-v2.html'),
    read('../scripts/payroll-v2.js'),
    read('../styles/payroll-v2.css'),
    read('../scripts/payroll-v2-finalization.mjs')
  ])

  assert.match(page, /href="\.\/styles\/payroll-v2\.css\?v=\d+"/)
  assert.match(page, /href="\.\/styles\/site-theme\.css\?v=\d+"/)
  assert.match(page, /src="\.\/scripts\/payroll-v2\.js\?v=\d+"/)
  assert.match(page, /id="individualWorkspace"/)
  assert.match(page, /id="finalizeEmployeeDialog"/)
  assert.match(page, /Review Payslip/)
  assert.match(page, /id="individualCommittedHeading"/)
  assert.match(page, /id="individualAttendanceHeading"/)
  assert.ok(stylesheet.length > 1000)
  assert.match(script, /payroll_v2_list_periods_with_rate/)
  assert.match(finalization, /canFinalizeEmployeeAction/)
})

test('Payroll V2 actions use V2 RPCs and retain readiness, recalculation, approval, and finalization guards', async () => {
  const script = await read('../scripts/payroll-v2.js')
  const forbiddenV1References = /\b(?:payroll_records|payroll_items|payroll_snapshots)\b/i

  for (const rpc of [
    'payroll_v2_preview_employee',
    'payroll_v2_calculate_employee',
    'payroll_v2_reopen_employee_for_recalculation',
    'payroll_v2_recalculate_employee',
    'payroll_v2_approve_employee',
    'payroll_v2_finalize_employee'
  ]) {
    assert.ok(script.includes(`'${rpc}'`), `${rpc} should be used by the restored V2 client`)
  }

  assert.match(script, /Committed Hours/)
  assert.match(script, /rate_breakdown/)
  assert.match(script, /recalculationPending/)
  assert.match(script, /record_status !== 'approved'/)
  assert.match(script, /record_status !== 'finalized'/)
  assert.doesNotMatch(script, forbiddenV1References)
})

test('V2 finalization requires a saved approved record, permission, current review, and a non-void period', () => {
  const persistence = {
    saved: true,
    record_status: 'approved',
    payroll_v2_record_id: 'v2-record-1',
    approved_at: '2026-09-28T10:00:00Z',
    approved_by: 'reviewer-1'
  }

  assert.equal(canFinalizeEmployeeAction(persistence, {
    canFinalize: true,
    recalculationPending: false,
    periodStatus: 'open'
  }), true)
  assert.equal(canFinalizeEmployeeAction({ ...persistence, saved: false }, { canFinalize: true }), false)
  assert.equal(canFinalizeEmployeeAction({ ...persistence, record_status: 'calculated' }, { canFinalize: true }), false)
  assert.equal(canFinalizeEmployeeAction(persistence, { canFinalize: false }), false)
  assert.equal(canFinalizeEmployeeAction(persistence, { canFinalize: true, recalculationPending: true }), false)
  assert.equal(canFinalizeEmployeeAction(persistence, { canFinalize: true, periodStatus: 'void' }), false)
})

test('V2 finalization prevents duplicate submissions and always releases its in-flight guard', async () => {
  const state = { finalizing: false }
  let callCount = 0
  let finishFirst
  const first = submitEmployeeFinalization('v2-record-1', state, id => {
    callCount += 1
    assert.equal(id, 'v2-record-1')
    return new Promise(resolve => { finishFirst = resolve })
  })

  assert.equal(state.finalizing, true)
  assert.deepEqual(await submitEmployeeFinalization('v2-record-1', state, async () => {
    callCount += 1
  }), { skipped: true })
  assert.equal(callCount, 1)
  finishFirst({ data: { record_status: 'finalized' } })
  assert.deepEqual(await first, { data: { record_status: 'finalized' } })
  assert.equal(state.finalizing, false)

  const error = new Error('request failed')
  assert.deepEqual(await submitEmployeeFinalization('v2-record-1', state, async () => {
    throw error
  }), { error })
  assert.equal(state.finalizing, false)
})

test('Completed Payroll V2 payslip links open the restored protected V2 preview route', async () => {
  const [payroll, page, script, stylesheet, formatting, visibility] = await Promise.all([
    read('../scripts/payroll-v2.js'),
    read('../payslip-v2-preview.html'),
    read('../scripts/payslip-v2-preview.js'),
    read('../styles/payslip-v2-preview.css'),
    read('../shared/payroll-v2-payslip-formatting.mjs'),
    read('../shared/payroll-v2-payslip-visibility.mjs')
  ])

  assert.match(payroll, /payslip-v2-preview\.html\?\$\{new URLSearchParams\(\{ record: recordId, admin: '1' \}\)\}/)
  assert.match(page, /styles\/payslip-v2-preview\.css\?v=\d+/)
  assert.match(page, /scripts\/payslip-v2-preview\.js\?v=\d+/)
  assert.match(script, /'payroll_v2_get_admin_completed_payslip'/)
  assert.match(script, /'payroll_v2_get_my_payslip'/)
  assert.match(script, /hasWorkforcePermission\(access, permission\)/)
  assert.match(script, /window\.location\.replace\(adminPreview \? '\.\/payroll-v2\.html' : '\.\/my-payslips-v2\.html'\)/)
  assert.match(script, /isVisiblePayrollV2Payslip\(data\)/)
  assert.match(visibility, /status === 'finalized'/)
  assert.match(visibility, /recalculation_pending !== true/)
  assert.match(formatting, /createPayrollV2PayslipRow/)
  assert.ok(stylesheet.length > 1000)
})

test('Payroll History payslip count reconciles to the selected period completed payslip list', async () => {
  const script = await read('../scripts/payroll-v2.js')
  const rows = [
    { payroll_v2_record_id: 'approved-1', status: 'Approved' },
    { payroll_v2_record_id: 'finalized-1', status: 'finalized' },
    { payroll_v2_record_id: 'calculated-1', status: 'calculated' },
    { payroll_v2_record_id: '', status: 'approved' }
  ]

  assert.equal(visibleCompletedPayslips(rows).length, 2)
  assert.deepEqual(visibleCompletedPayslips(null), [])
  assert.match(script, /updatePeriodPayslipCount\(selectedPeriod\(\)\?\.period_id, completed\.length\)/)
  assert.match(script, /updatePeriodPayslipCount\(period\.period_id, '…'\)/)
  assert.match(script, /updatePeriodPayslipCount\(period\.period_id, '—'\)/)
})
