import { supabase } from './supabaseClient.js?v=12'
import {
  hasWorkforcePermission,
  loadCurrentWorkforceAccess,
  requireWorkforcePermission
} from './workforce-permissions.js?v=1'
import { isVisiblePayrollV2Payslip } from '../shared/payroll-v2-payslip-visibility.mjs'
import {
  createPayrollV2PayslipRow,
  formatPaypalPayout,
  formatPayrollMoney,
  formatPayrollV2HourlyRate,
  formatPayrollWorkDate,
  payrollV2ItemGroup,
  payrollV2ItemTypeLabel
} from '../shared/payroll-v2-payslip-formatting.mjs?v=3'

const parameters = new URLSearchParams(window.location.search)
const recordId = parameters.get('record') || ''
const adminPreview = parameters.get('admin') === '1'
const printRequested = parameters.get('print') === '1'
const payrollViewPermissions = [
  'create_payroll',
  'review_payroll',
  'finalize_payroll',
  'reopen_payroll',
  'view_all_payslips',
  'export_payslips'
]

const elements = {
  back: document.getElementById('payslipV2BackLink'),
  refresh: document.getElementById('refreshPayrollV2PayslipButton'),
  print: document.getElementById('printPayrollV2PayslipButton'),
  message: document.getElementById('payrollV2PayslipMessage'),
  sheet: document.getElementById('payrollV2PayslipSheet'),
  earnings: document.getElementById('payrollV2PayslipEarningsBody'),
  deductions: document.getElementById('payrollV2PayslipDeductionsBody')
}

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function node(tag, className = '', value = '') {
  const result = document.createElement(tag)
  if (className) result.className = className
  if (value) result.textContent = value
  return result
}

function setMessage(value = '', isError = false) {
  elements.message.textContent = value
  elements.message.classList.toggle('error', isError)
  elements.message.hidden = !value
}

function appendEmptyRow(body, colspan, message) {
  const row = document.createElement('tr')
  const cell = node('td', 'empty', message)
  cell.colSpan = colspan
  row.append(cell)
  body.replaceChildren(row)
}

function formatPaypalRate(value) {
  if (value === null || value === undefined || String(value).trim() === '') return '—'
  return String(value).trim()
}

function renderItems(items, currencyCode, savedAttendanceSnapshots = []) {
  const fragments = {
    earnings: document.createDocumentFragment(),
    deductions: document.createDocumentFragment()
  }
  const counts = { earnings: 0, deductions: 0 }
  const snapshotsByDate = new Map(
    savedAttendanceSnapshots.map(snapshot => [snapshot.work_date, snapshot])
  )
  for (const item of items) {
    const group = payrollV2ItemGroup(item)
    const cells = createPayrollV2PayslipRow(
      item,
      snapshotsByDate.get(item.work_date),
      currencyCode
    )
    const row = document.createElement('tr')
    row.append(
      node('td', '', payrollV2ItemTypeLabel(item)),
      node('td', '', cells.description),
      node('td', '', cells.date),
      node('td', '', cells.regular),
      node('td', '', cells.additional),
      node('td', '', cells.total),
      node('td', 'rate', cells.rate),
      node('td', 'amount', cells.amount)
    )
    fragments[group].append(row)
    counts[group] += 1
  }
  elements.earnings.replaceChildren(fragments.earnings)
  elements.deductions.replaceChildren(fragments.deductions)
  if (!counts.earnings) appendEmptyRow(elements.earnings, 8, 'No earnings were saved for this record.')
  if (!counts.deductions) appendEmptyRow(elements.deductions, 8, 'No deductions were saved for this record.')
}

function renderPayslip(payslip) {
  const employee = payslip.employee || {}
  const period = payslip.period || {}
  const totals = payslip.totals || {}
  const items = Array.isArray(payslip.items) ? payslip.items : []
  const currencyCode = period.currency_code || 'USD'

  document.title = `${employee.full_name || 'Employee'} Payslip | SocialLoop CS Base`
  document.getElementById('payrollV2PayslipPeriod').textContent =
    `${formatPayrollWorkDate(period.period_start)} to ${formatPayrollWorkDate(period.period_end)}`
  document.getElementById('payrollV2PayslipPaymentDate').textContent =
    formatPayrollWorkDate(period.payment_date)
  document.getElementById('payrollV2PayslipStatus').textContent = payslip.status
  document.getElementById('payrollV2PayslipStatus').className =
    `my-payslips-v2-status ${String(payslip.status || '').toLowerCase()}`
  document.getElementById('payrollV2PayslipEmployeeName').textContent =
    employee.full_name || '—'
  document.getElementById('payrollV2PayslipHireDate').textContent =
    formatPayrollWorkDate(employee.hire_date)
  document.getElementById('payrollV2PayslipHourlyRate').textContent =
    formatPayrollV2HourlyRate(items, currencyCode)
  document.getElementById('payrollV2PayslipCurrency').textContent = currencyCode
  document.getElementById('payrollV2PayslipEarningsSubtotal').textContent =
    formatPayrollMoney(totals.gross_pay, currencyCode)
  document.getElementById('payrollV2PayslipDeductionsSubtotal').textContent =
    `−${formatPayrollMoney(Math.abs(Number(totals.total_deductions || 0)), currencyCode)}`
  document.getElementById('payrollV2PayslipGross').textContent =
    formatPayrollMoney(totals.gross_pay, currencyCode)
  document.getElementById('payrollV2PayslipNet').textContent =
    formatPayrollMoney(totals.net_pay, currencyCode)
  document.getElementById('payrollV2PayslipPaypalRate').textContent =
    formatPaypalRate(period.paypal_conversion_rate)
  document.getElementById('payrollV2PayslipPaypalAmount').textContent =
    formatPaypalPayout(totals.net_pay, currencyCode, period.paypal_conversion_rate)

  renderItems(
    items,
    currencyCode,
    Array.isArray(payslip.attendance_snapshots)
      ? payslip.attendance_snapshots
      : []
  )
  elements.sheet.hidden = false
  elements.print.hidden = adminPreview
  setMessage()

  if (printRequested && !adminPreview) {
    window.requestAnimationFrame(() => window.print())
  }
}

async function loadPayslip() {
  elements.refresh.disabled = true
  elements.print.disabled = true
  setMessage('Loading saved Payroll V2 payslip…')
  try {
    const { data, error } = await supabase.rpc(
      adminPreview
        ? 'payroll_v2_get_admin_completed_payslip'
        : 'payroll_v2_get_my_payslip',
      { p_payroll_v2_record_id: recordId }
    )
    if (error) throw error

    if (!data || !isVisiblePayrollV2Payslip(data)) {
      elements.sheet.hidden = true
      elements.print.hidden = true
      setMessage(
        adminPreview
          ? 'This Payroll V2 payslip is unavailable. It may not be completed or may have been reopened for recalculation.'
          : 'This Payroll V2 payslip is unavailable. It may have been reopened for recalculation or may not belong to your account.',
        true
      )
      return
    }

    renderPayslip(data)
  } catch (error) {
    elements.sheet.hidden = true
    elements.print.hidden = true
    setMessage(
      error?.message || 'Your Payroll V2 payslip could not be loaded.',
      true
    )
  } finally {
    elements.refresh.disabled = false
    elements.print.disabled = false
  }
}

async function requirePayrollDashboardAccess() {
  const access = await loadCurrentWorkforceAccess(supabase)
  if (!access.authenticated) {
    const returnTo = `payslip-v2-preview.html?record=${encodeURIComponent(recordId)}&admin=1`
    window.location.replace(`./login.html?returnTo=${encodeURIComponent(returnTo)}`)
    return null
  }
  if (!payrollViewPermissions.some(permission => hasWorkforcePermission(access, permission))) {
    window.location.replace('./home.html')
    return null
  }
  return access
}

async function initialize() {
  if (!isValidUuid(recordId)) {
    window.location.replace(adminPreview ? './payroll-v2.html' : './my-payslips.html')
    return
  }

  try {
    const access = adminPreview
      ? await requirePayrollDashboardAccess()
      : await requireWorkforcePermission(
        supabase,
        'view_own_payslips',
        {
          returnTo: `payslip-v2-preview.html?record=${encodeURIComponent(recordId)}${printRequested ? '&print=1' : ''}`,
          deniedPath: './home.html',
          deniedMessage: 'You do not have permission to view your payslips.'
        }
      )
    if (!access) return
    document.body.classList.remove('payslip-v2-access-pending')
    await loadPayslip()
  } catch {
    document.body.classList.remove('payslip-v2-access-pending')
    setMessage(
      'Payroll V2 payslip could not be opened. Sign in again or contact a payroll administrator.',
      true
    )
  }
}

if (adminPreview) {
  document.body.classList.add('payslip-v2-admin-preview')
  elements.back.href = './payroll-v2.html'
  elements.back.textContent = '← Back to Payroll V2'
  elements.refresh.hidden = true
  elements.print.hidden = true
} else {
  elements.back.href = './my-payslips.html'
}
elements.refresh.addEventListener('click', loadPayslip)
elements.print.addEventListener('click', () => window.print())
initialize()
