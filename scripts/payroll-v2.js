import { supabase } from './supabaseClient.js?v=12'
import {
  hasWorkforcePermission,
  loadCurrentWorkforceAccess
} from './workforce-permissions.js?v=1'
import {
  canFinalizeEmployeeAction,
  finalizeEmployeeSummary,
  submitEmployeeFinalization
} from './payroll-v2-finalization.mjs?v=2'
import { visibleCompletedPayslips } from './payroll-v2-completed-count.mjs?v=1'

const VIEW_PERMISSIONS = [
  'create_payroll',
  'review_payroll',
  'finalize_payroll',
  'reopen_payroll',
  'view_all_payslips',
  'export_payslips'
]

const state = {
  periods: [],
  selectedPeriodId: '',
  canCreate: false,
  periodRateEditorPeriodId: '',
  canApprove: false,
  canFinalize: false,
  saving: false,
  savingPaypalRate: false,
  voiding: false,
  closing: false,
  pendingVoidPeriodId: '',
  pendingClosePeriodId: '',
  periodCloseState: null,
  periodCloseRequestId: 0,
  completedPayslipRequestId: 0,
  individualWorkspaceRequestId: 0,
  individualEmployeeRequestId: 0,
  previewRequestId: 0,
  previewInput: null,
  latestPreview: null,
  freshPreviewToken: '',
  calculated: false,
  calculating: false,
  pendingCalculationInput: null,
  savedCalculation: null,
  recalculationPending: false,
  recalculationDialogMode: '',
  recalculationReason: '',
  recalculationNotice: '',
  recalculating: false,
  approving: false,
  pendingApprovalRecordId: '',
  finalizing: false,
  pendingFinalizationRecordId: '',
  adjustments: { manual_earnings: [], deductions: [] },
  pendingAdjustmentKind: '',
  pendingVoidAdjustment: null,
  savingAdjustment: false,
  voidingAdjustment: false
}

const elements = {
  createButton: document.getElementById('createPeriodButton'),
  createDialog: document.getElementById('createPeriodDialog'),
  createForm: document.getElementById('createPeriodForm'),
  start: document.getElementById('periodStart'),
  end: document.getElementById('periodEnd'),
  payment: document.getElementById('paymentDate'),
  createPaypalRate: document.getElementById('periodPaypalConversionRate'),
  saveButton: document.getElementById('savePeriodButton'),
  cancelButton: document.getElementById('cancelPeriodButton'),
  formError: document.getElementById('periodFormError'),
  tableBody: document.getElementById('periodTableBody'),
  addButton: document.getElementById('addButton'),
  addMenu: document.getElementById('addMenu'),
  selectedPeriodLabel: document.getElementById('selectedPeriodLabel'),
  periodPaypalRateForm: document.getElementById('periodPaypalRateForm'),
  selectedPeriodPaypalRate: document.getElementById('selectedPeriodPaypalRate'),
  periodPaypalRateMessage: document.getElementById('periodPaypalRateMessage'),
  savePeriodPaypalRateButton: document.getElementById('savePeriodPaypalRateButton'),
  completedPayslipsStatus: document.getElementById('completedPayslipsStatus'),
  completedPayslipsList: document.getElementById('completedPayslipsList'),
  periodCloseReason: document.getElementById('periodCloseReason'),
  closePeriodButton: document.getElementById('closePeriodButton'),
  closePeriodDialog: document.getElementById('closePeriodDialog'),
  closePeriodRange: document.getElementById('closePeriodRange'),
  closePeriodPayslipCount: document.getElementById('closePeriodPayslipCount'),
  closePeriodApprovedCount: document.getElementById('closePeriodApprovedCount'),
  closePeriodFinalizedCount: document.getElementById('closePeriodFinalizedCount'),
  closePeriodError: document.getElementById('closePeriodError'),
  confirmClosePeriodButton: document.getElementById('confirmClosePeriodButton'),
  cancelClosePeriodButton: document.getElementById('cancelClosePeriodButton'),
  message: document.getElementById('payrollV2Message'),
  placeholderDialog: document.getElementById('payslipPlaceholderDialog'),
  voidDialog: document.getElementById('voidPeriodDialog'),
  voidStart: document.getElementById('voidPeriodStart'),
  voidEnd: document.getElementById('voidPeriodEnd'),
  voidPaymentDate: document.getElementById('voidPeriodPaymentDate'),
  voidError: document.getElementById('voidPeriodError'),
  confirmVoidButton: document.getElementById('confirmVoidPeriodButton'),
  cancelVoidButton: document.getElementById('cancelVoidPeriodButton'),
  placeholderTitle: document.getElementById('placeholderTitle'),
  placeholderPeriod: document.getElementById('placeholderPeriod'),
  closePlaceholderButton: document.getElementById('closePlaceholderButton'),
  individualWorkspace: document.getElementById('individualWorkspace'),
  individualWorkspaceMessage: document.getElementById('individualWorkspaceMessage'),
  closeIndividualWorkspaceButton: document.getElementById('closeIndividualWorkspaceButton'),
  individualPeriodRange: document.getElementById('individualPeriodRange'),
  individualPeriodStart: document.getElementById('individualPeriodStart'),
  individualPeriodEnd: document.getElementById('individualPeriodEnd'),
  individualPaymentDate: document.getElementById('individualPaymentDate'),
  individualPeriodStatus: document.getElementById('individualPeriodStatus'),
  employeeSelect: document.getElementById('individualEmployeeSelect'),
  employeeSections: document.getElementById('individualEmployeeSections'),
  employeeName: document.getElementById('employeeName'),
  employeeNumber: document.getElementById('employeeNumber'),
  employeePeriod: document.getElementById('employeePeriod'),
  employeeRate: document.getElementById('employeeRate'),
  employeePayslipStatus: document.getElementById('employeePayslipStatus'),
  attendanceStatus: document.getElementById('attendanceSectionStatus'),
  attendanceBody: document.getElementById('individualAttendanceBody'),
  commitmentSectionStatus: document.getElementById('committedHoursSectionStatus'),
  commitmentTarget: document.getElementById('commitmentTarget'),
  commitmentCarryover: document.getElementById('commitmentCarryover'),
  commitmentExpected: document.getElementById('commitmentExpected'),
  commitmentReady: document.getElementById('commitmentReady'),
  commitmentCovered: document.getElementById('commitmentCovered'),
  commitmentRemaining: document.getElementById('commitmentRemaining'),
  commitmentStatus: document.getElementById('commitmentStatus'),
  commitmentBody: document.getElementById('individualCommitmentBody'),
  leaveStatus: document.getElementById('leaveSectionStatus'),
  leaveBody: document.getElementById('individualLeaveBody'),
  manualEarningsStatus: document.getElementById('manualEarningsSectionStatus'),
  manualEarningsBody: document.getElementById('individualManualEarningsBody'),
  deductionsStatus: document.getElementById('deductionsSectionStatus'),
  deductionsBody: document.getElementById('individualDeductionsBody'),
  addEarningButton: document.getElementById('addManualEarningButton'),
  addDeductionButton: document.getElementById('addDeductionButton'),
  adjustmentDialog: document.getElementById('employeeAdjustmentDialog'),
  adjustmentForm: document.getElementById('employeeAdjustmentForm'),
  adjustmentTitle: document.getElementById('employeeAdjustmentTitle'),
  adjustmentDescription: document.getElementById('employeeAdjustmentDescription'),
  adjustmentAmount: document.getElementById('employeeAdjustmentAmount'),
  adjustmentError: document.getElementById('employeeAdjustmentError'),
  saveAdjustmentButton: document.getElementById('saveEmployeeAdjustmentButton'),
  cancelAdjustmentButton: document.getElementById('cancelEmployeeAdjustmentButton'),
  voidAdjustmentDialog: document.getElementById('voidEmployeeAdjustmentDialog'),
  voidAdjustmentSummary: document.getElementById('voidEmployeeAdjustmentSummary'),
  voidAdjustmentError: document.getElementById('voidEmployeeAdjustmentError'),
  confirmVoidAdjustmentButton: document.getElementById('confirmVoidEmployeeAdjustmentButton'),
  cancelVoidAdjustmentButton: document.getElementById('cancelVoidEmployeeAdjustmentButton'),
  readinessList: document.getElementById('individualReadinessList'),
  previewButton: document.getElementById('previewPayrollButton'),
  previewStatus: document.getElementById('payrollPreviewStatus'),
  previewBody: document.getElementById('individualPreviewBody'),
  dailyBreakdownBody: document.getElementById('individualDailyBreakdownBody'),
  calculateButton: document.getElementById('calculateEmployeeButton'),
  recalculateButton: document.getElementById('recalculateEmployeeButton'),
  recalculateDialog: document.getElementById('recalculateEmployeeDialog'),
  recalculateForm: document.getElementById('recalculateEmployeeForm'),
  recalculateTitle: document.getElementById('recalculateEmployeeTitle'),
  recalculateMessage: document.getElementById('recalculateEmployeeMessage'),
  recalculateReason: document.getElementById('recalculateEmployeeReason'),
  recalculateError: document.getElementById('recalculateEmployeeError'),
  confirmRecalculateButton: document.getElementById('confirmRecalculateEmployeeButton'),
  cancelRecalculateButton: document.getElementById('cancelRecalculateEmployeeButton'),
  calculateDialog: document.getElementById('calculateEmployeeDialog'),
  calculateEmployeeName: document.getElementById('calculateEmployeeName'),
  calculateEmployeePeriod: document.getElementById('calculateEmployeePeriod'),
  calculateEmployeeHours: document.getElementById('calculateEmployeeHours'),
  calculateEmployeeAttendance: document.getElementById('calculateEmployeeAttendance'),
  calculateEmployeeLeave: document.getElementById('calculateEmployeeLeave'),
  calculateEmployeeCommitted: document.getElementById('calculateEmployeeCommitted'),
  calculateEmployeeManual: document.getElementById('calculateEmployeeManual'),
  calculateEmployeeDeductions: document.getElementById('calculateEmployeeDeductions'),
  calculateEmployeeGross: document.getElementById('calculateEmployeeGross'),
  calculateEmployeeNet: document.getElementById('calculateEmployeeNet'),
  calculateEmployeeError: document.getElementById('calculateEmployeeError'),
  confirmCalculateButton: document.getElementById('confirmCalculateEmployeeButton'),
  cancelCalculateButton: document.getElementById('cancelCalculateEmployeeButton'),
  approveButton: document.getElementById('approveEmployeeButton'),
  finalizeButton: document.getElementById('finalizeEmployeeButton'),
  approveDialog: document.getElementById('approveEmployeeDialog'),
  approveEmployeeName: document.getElementById('approveEmployeeName'),
  approveEmployeePeriod: document.getElementById('approveEmployeePeriod'),
  approveEmployeeCalculatedAt: document.getElementById('approveEmployeeCalculatedAt'),
  approveEmployeeHours: document.getElementById('approveEmployeeHours'),
  approveEmployeeAttendance: document.getElementById('approveEmployeeAttendance'),
  approveEmployeeLeave: document.getElementById('approveEmployeeLeave'),
  approveEmployeeCommitted: document.getElementById('approveEmployeeCommitted'),
  approveEmployeeManual: document.getElementById('approveEmployeeManual'),
  approveEmployeeDeductions: document.getElementById('approveEmployeeDeductions'),
  approveEmployeeGross: document.getElementById('approveEmployeeGross'),
  approveEmployeeNet: document.getElementById('approveEmployeeNet'),
  approveEmployeeError: document.getElementById('approveEmployeeError'),
  confirmApproveButton: document.getElementById('confirmApproveEmployeeButton'),
  cancelApproveButton: document.getElementById('cancelApproveEmployeeButton'),
  finalizeDialog: document.getElementById('finalizeEmployeeDialog'),
  finalizeTitle: document.getElementById('finalizeEmployeeTitle'),
  finalizeEmployeeName: document.getElementById('finalizeEmployeeName'),
  finalizeEmployeePeriod: document.getElementById('finalizeEmployeePeriod'),
  finalizeEmployeePaymentDate: document.getElementById('finalizeEmployeePaymentDate'),
  finalizeEmployeeStatus: document.getElementById('finalizeEmployeeStatus'),
  finalizeEmployeeHours: document.getElementById('finalizeEmployeeHours'),
  finalizeEmployeeAttendance: document.getElementById('finalizeEmployeeAttendance'),
  finalizeEmployeeLeave: document.getElementById('finalizeEmployeeLeave'),
  finalizeEmployeeCommitted: document.getElementById('finalizeEmployeeCommitted'),
  finalizeEmployeeManual: document.getElementById('finalizeEmployeeManual'),
  finalizeEmployeeGross: document.getElementById('finalizeEmployeeGross'),
  finalizeEmployeeDeductions: document.getElementById('finalizeEmployeeDeductions'),
  finalizeEmployeeNet: document.getElementById('finalizeEmployeeNet'),
  finalizeEmployeeRateBody: document.getElementById('finalizeEmployeeRateBody'),
  finalizeEmployeeCommittedStatus: document.getElementById('finalizeEmployeeCommittedStatus'),
  finalizeEmployeeCommittedBody: document.getElementById('finalizeEmployeeCommittedBody'),
  finalizeEmployeeItemsBody: document.getElementById('finalizeEmployeeItemsBody'),
  finalizeEmployeeDeductionsBody: document.getElementById('finalizeEmployeeDeductionsBody'),
  finalizeEmployeeError: document.getElementById('finalizeEmployeeError'),
  confirmFinalizeButton: document.getElementById('confirmFinalizeEmployeeButton'),
  cancelFinalizeButton: document.getElementById('cancelFinalizeEmployeeButton')
}

const dateFormatter = new Intl.DateTimeFormat('en-PH', {
  year: 'numeric',
  month: 'short',
  day: 'numeric'
})

function formatDate(value) {
  if (!value) return '—'
  return dateFormatter.format(new Date(`${value}T00:00:00`))
}

function formatTimestamp(value) {
  if (!value) return '—'
  const timestamp = new Date(value)
  return Number.isNaN(timestamp.getTime()) ? '—' : new Intl.DateTimeFormat('en-PH', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(timestamp)
}

function periodRange(period) {
  return `${formatDate(period.period_start)}–${formatDate(period.period_end)}`
}

function setMessage(message = '', type = '') {
  elements.message.textContent = message
  elements.message.classList.toggle('error', type === 'error')
  elements.message.classList.toggle('success', type === 'success')
}

function selectedPeriod() {
  const period = state.periods.find(period => period.period_id === state.selectedPeriodId) || null
  return String(period?.status || '').toLowerCase() === 'void' ? null : period
}

function formatPaypalRate(value) {
  if (value === null || value === undefined || String(value).trim() === '') return '—'
  return String(value).trim()
}

function optionalPaypalRate(input) {
  const value = String(input?.value || '').trim()
  if (!value) return { value: null, error: '' }
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return { value: null, error: 'PayPal Conversion Rate must be greater than zero.' }
  }
  return { value, error: '' }
}

function periodIsClosed(period = selectedPeriod()) {
  return String(period?.status || '').toLowerCase() === 'closed'
}

function makeCell(row, value) {
  const cell = document.createElement('td')
  cell.textContent = value
  row.append(cell)
  return cell
}

function applyStatusBadge(cell, label, status) {
  const badge = document.createElement('span')
  const statusClass = String(status || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-')
  badge.className = `payroll-v2-badge status-${statusClass}`
  badge.textContent = label
  cell.replaceChildren(badge)
}

function appendTableRow(body, values) {
  const row = document.createElement('tr')
  for (const value of values) makeCell(row, value)
  body.append(row)
  return row
}

function setEmptyRow(body, message, columns) {
  body.replaceChildren()
  const row = document.createElement('tr')
  const cell = makeCell(row, message)
  cell.colSpan = columns
  body.append(row)
}

function formatHours(minutes) {
  return `${(Number(minutes || 0) / 60).toFixed(2)} h`
}

function formatMoney(amount, currency = 'USD') {
  if (amount == null || !Number.isFinite(Number(amount))) return 'Blocked'
  return `${currency} ${Number(amount).toFixed(2)}`
}

function formatRate(rate) {
  if (!rate) return 'No Agent Rate effective by the period end.'
  const currency = rate.currency_code || ''
  const hourly = rate.hourly_rate == null ? '—' : `${currency} ${Number(rate.hourly_rate).toFixed(2)} / hour`
  const effective = rate.effective_date ? ` (effective ${formatDate(rate.effective_date)})` : ''
  return `${hourly}${effective}`
}

function addReadinessItem(label, status, ready = true) {
  const item = document.createElement('li')
  item.className = ready ? 'is-ready' : 'is-blocked'
  const title = document.createElement('strong')
  title.textContent = `${label}: `
  item.append(title, document.createTextNode(status))
  elements.readinessList.append(item)
}

function resetIndividualSections(message = 'Select an employee.') {
  state.previewRequestId += 1
  state.previewInput = null
  state.latestPreview = null
  state.freshPreviewToken = ''
  state.calculated = false
  state.calculating = false
  state.pendingCalculationInput = null
  state.savedCalculation = null
  state.recalculationPending = false
  state.recalculationDialogMode = ''
  state.recalculationReason = ''
  state.recalculationNotice = ''
  state.recalculating = false
  state.approving = false
  state.pendingApprovalRecordId = ''
  elements.employeeSections.hidden = true
  elements.individualWorkspaceMessage.textContent = message
  setEmptyRow(elements.attendanceBody, 'Select an employee.', 8)
  setEmptyRow(elements.commitmentBody, 'Select an employee.', 8)
  setEmptyRow(elements.leaveBody, 'Select an employee.', 6)
  setEmptyRow(elements.manualEarningsBody, 'Select an employee.', 4)
  setEmptyRow(elements.deductionsBody, 'Select an employee.', 4)
  elements.addEarningButton.hidden = true
  elements.addDeductionButton.hidden = true
  elements.manualEarningsStatus.textContent = ''
  elements.deductionsStatus.textContent = ''
  state.adjustments = { manual_earnings: [], deductions: [] }
  setEmptyRow(elements.previewBody, 'Select an employee.', 2)
  setEmptyRow(elements.dailyBreakdownBody, 'Select an employee.', 7)
  elements.previewButton.disabled = true
  elements.previewButton.textContent = 'Preview Payroll'
  elements.previewStatus.textContent = ''
  elements.calculateButton.hidden = true
  elements.calculateButton.disabled = true
  elements.recalculateButton.hidden = true
  elements.recalculateButton.disabled = true
  elements.approveButton.hidden = true
  elements.approveButton.disabled = true
  elements.readinessList.replaceChildren()
  const item = document.createElement('li')
  item.textContent = 'Select an employee.'
  elements.readinessList.append(item)
}

function renderAttendance(data) {
  const rows = Array.isArray(data.attendance) ? data.attendance : []
  elements.attendanceBody.replaceChildren()
  for (const attendance of rows) {
    const readiness = attendance.is_payroll_ready
      ? 'Ready'
      : (Array.isArray(attendance.readiness_blockers) && attendance.readiness_blockers.length
          ? attendance.readiness_blockers.join(', ').replaceAll('_', ' ')
          : attendance.payroll_readiness || 'Not payroll ready')
    const row = appendTableRow(elements.attendanceBody, [
      formatDate(attendance.work_date),
      attendance.schedule || '—',
      attendance.attendance_type || '—',
      String(Number(attendance.regular_minutes || 0)),
      String(Number(attendance.additional_ot_minutes || 0)),
      String(Number(attendance.total_payable_minutes || 0)),
      attendance.approval_status || '—',
      readiness
    ])
    row.classList.add(attendance.is_payroll_ready ? 'is-ready' : 'is-blocked')
    applyStatusBadge(row.cells[6], attendance.approval_status || 'Unknown',
      ['approved', 'locked'].includes(String(attendance.approval_status || '').toLowerCase()) ? 'approved' : 'pending')
    applyStatusBadge(row.cells[7], readiness, attendance.is_payroll_ready ? 'ready' : 'blocked')
  }
  if (!rows.length) setEmptyRow(elements.attendanceBody, 'No attendance available for this payroll period.', 8)

  const readyRows = rows.filter(row => row.is_payroll_ready && ['approved', 'locked'].includes(String(row.approval_status || '').toLowerCase()))
  elements.attendanceStatus.textContent = rows.length
    ? `${readyRows.length} of ${rows.length} work dates are approved and payroll ready.`
    : 'No attendance available for this payroll period.'
  return readyRows.reduce((total, row) => total + Number(row.total_payable_minutes || 0), 0)
}

function renderCommitments(summary) {
  const data = summary || {}
  const targetRows = Array.isArray(data.payroll_targets)
    ? data.payroll_targets
    : [...(Array.isArray(data.carryover_targets) ? data.carryover_targets : []), ...(Array.isArray(data.targets) ? data.targets : [])]
  elements.commitmentTarget.textContent = formatHours(data.target_minutes)
  elements.commitmentCarryover.textContent = formatHours(data.carryover_minutes)
  elements.commitmentExpected.textContent = formatHours(data.expected_minutes)
  elements.commitmentReady.textContent = formatHours(data.payroll_ready_minutes)
  elements.commitmentCovered.textContent = formatHours(data.covered_minutes)
  elements.commitmentRemaining.textContent = formatHours(data.remaining_minutes)
  elements.commitmentStatus.textContent = targetRows.length
    ? (data.status || 'Committed Hours target found')
    : 'No commitment required'
  elements.commitmentStatus.classList.toggle('is-no-commitment', !targetRows.length)
  elements.commitmentSectionStatus.textContent = targetRows.length
    ? 'Coverage uses only approved, payroll-ready qualifying attendance. Legacy prepaid balances are not read.'
    : 'No commitment required. No explicit Committed Hours target exists in this period.'

  elements.commitmentBody.replaceChildren()
  for (const target of targetRows) {
    appendTableRow(elements.commitmentBody, [
      formatDate(target.work_date),
      formatHours(target.expected_minutes),
      Number(target.carryover_minutes) > 0 ? formatHours(target.carryover_minutes) : '—',
      formatHours(target.payroll_ready_minutes),
      formatHours(target.covered_minutes),
      formatHours(target.remaining_minutes),
      formatHours(target.payable_minutes),
      String(target.day_type || 'ordinary').replaceAll('_', ' ')
    ])
  }
  if (!targetRows.length) setEmptyRow(elements.commitmentBody, 'No commitment required.', 8)
}

function renderLeave(rows, dailyBreakdown = []) {
  const leaveRows = Array.isArray(rows) ? rows : []
  const dailyByDate = new Map((Array.isArray(dailyBreakdown) ? dailyBreakdown : [])
    .map(day => [day.work_date, day]))
  elements.leaveBody.replaceChildren()
  for (const leave of leaveRows) {
    const pricedDate = dailyByDate.get(leave.work_date)
    appendTableRow(elements.leaveBody, [
      formatDate(leave.work_date),
      leave.leave_type || 'Paid leave',
      String(Number(leave.paid_minutes || 0)),
      pricedDate?.hourly_rate == null
        ? '—'
        : `${formatMoney(pricedDate.hourly_rate, pricedDate.currency_code)} / hour`,
      pricedDate?.leave_amount == null
        ? 'Run Preview Payroll'
        : formatMoney(pricedDate.leave_amount, pricedDate.currency_code),
      leave.status || 'Approved'
    ])
  }
  if (!leaveRows.length) setEmptyRow(elements.leaveBody, 'No approved paid leave in this period.', 6)
  elements.leaveStatus.textContent = leaveRows.length
    ? `${leaveRows.length} approved paid leave schedule row(s) loaded.`
    : 'No approved paid leave in this period.'
}

function canEditAdjustments() {
  const period = selectedPeriod()
  return Boolean(state.canCreate && period && String(period.status).toLowerCase() === 'draft'
    && elements.employeeSelect.value && (!state.calculated || state.recalculationPending))
}

function renderAdjustmentRows(body, rows, kind) {
  body.replaceChildren()
  for (const adjustment of rows) {
    const row = document.createElement('tr')
    makeCell(row, adjustment.description || (kind === 'earning' ? 'Manual earning' : 'Deduction'))
    makeCell(row, adjustment.amount == null ? '—' : `${adjustment.currency_code || 'USD'} ${Number(adjustment.amount).toFixed(2)}`)
    makeCell(row, adjustment.status || 'Approved')
    const actionCell = document.createElement('td')
    if (canEditAdjustments() && (adjustment.can_void || String(adjustment.status).toLowerCase() === 'approved')) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'plain-button payroll-v2-inline-action'
      button.textContent = 'Void'
      button.dataset.voidAdjustment = adjustment.id
      button.dataset.adjustmentKind = kind
      button.dataset.adjustmentDescription = adjustment.description || ''
      button.dataset.adjustmentAmount = String(adjustment.amount || '')
      actionCell.append(button)
    } else {
      actionCell.textContent = '—'
    }
    row.append(actionCell)
    body.append(row)
  }
  if (!rows.length) setEmptyRow(body, kind === 'earning'
    ? 'No manual earnings for this employee and period.'
    : 'No deductions for this employee and period.', 4)
}

function renderManualEarnings(manual) {
  const earnings = manual || {}
  const rows = Array.isArray(earnings.rows) ? earnings.rows : []
  state.adjustments.manual_earnings = rows
  renderAdjustmentRows(elements.manualEarningsBody, rows, 'earning')
  elements.addEarningButton.hidden = !canEditAdjustments()
  if (Number.isFinite(Number(earnings.approved_count))) {
    elements.manualEarningsStatus.textContent = rows.length
      ? `${earnings.approved_count} approved row(s) included; ${earnings.excluded_count || 0} pending, rejected, or void row(s) excluded.`
      : 'No V2 manual earnings. $0.00 included in the preview.'
  } else if (earnings.available === true) {
    elements.manualEarningsStatus.textContent = `${rows.filter(row => String(row.status).toLowerCase() === 'approved').length} approved manual earning row(s) loaded.`
  } else {
    elements.manualEarningsStatus.textContent = earnings.reason || 'Manual earnings are not available for this V2 period.'
  }
}

function renderDeductions(data = {}) {
  const rows = Array.isArray(data.rows) ? data.rows : []
  state.adjustments.deductions = rows
  renderAdjustmentRows(elements.deductionsBody, rows, 'deduction')
  elements.addDeductionButton.hidden = !canEditAdjustments()
  const included = Number(data.approved_count || rows.filter(row => row.included_in_preview || String(row.status).toLowerCase() === 'approved').length)
  const excluded = Number(data.excluded_count || 0)
  elements.deductionsStatus.textContent = `Approved deductions: ${included}; void deductions excluded: ${excluded}.`
}

function renderReadiness(data, payableMinutes) {
  const attendance = Array.isArray(data.attendance) ? data.attendance : []
  const readyAttendance = attendance.filter(row => row.is_payroll_ready && ['approved', 'locked'].includes(String(row.approval_status || '').toLowerCase()))
  const rate = data.employee.agent_rate
  const rateChanges = Number(data.employee.rate_changes_in_period || 0)
  const commitments = data.committed_hours || {}
  const leave = Array.isArray(data.leave) ? data.leave : []

  elements.readinessList.replaceChildren()
  addReadinessItem('Attendance Ready', attendance.length
    ? `${readyAttendance.length} of ${attendance.length} work dates ready; ${formatHours(payableMinutes)} payable attendance hours included in the time summary.`
    : 'No attendance or due scheduled shifts in this period.', attendance.length > 0 && readyAttendance.length === attendance.length)

  let rateMessage = rate ? formatRate(rate) : 'No Agent Rate is effective by the period end.'
  if (rateChanges > 0) {
    const rateDateText = rateChanges === 1
      ? '1 rate effective date is inside the period'
      : `${rateChanges} rate effective dates are inside the period`
    rateMessage += ` ${rateDateText}; payroll needs date-based rate allocation.`
  }
  addReadinessItem('Agent Rate Available', rateMessage, Boolean(rate) && rateChanges === 0 && rate.effective_date <= data.period.period_start)

  addReadinessItem('Committed Hours Ready', `${commitments.status || 'No commitment required'}; ${formatHours(commitments.remaining_minutes)} remaining.`, true)
  addReadinessItem('Leave Ready', leave.length
    ? `${leave.length} approved paid leave row(s) loaded.`
    : 'No approved paid leave in this period.', true)
  addReadinessItem('Manual Earnings Ready',
    'Approved V2 manual earnings are read when Preview Payroll runs.', true)
}

function renderPreview(preview, saved = false) {
  state.latestPreview = preview
  state.freshPreviewToken = !saved && preview.ready_to_preview && /^[0-9a-f]{32}$/.test(preview.preview_token || '')
    ? preview.preview_token
    : ''
  state.calculated = saved || Boolean(preview.persistence?.saved) || Boolean(state.savedCalculation)
  const persistence = preview.persistence || (state.recalculationPending ? state.savedCalculation?.persistence : null) || {}
  const recordStatus = String(preview.persistence?.record_status || '').toLowerCase()
  const displayStatus = state.recalculationPending
    ? 'Calculated — Recalculation Open'
    : recordStatus
    ? recordStatus.charAt(0).toUpperCase() + recordStatus.slice(1)
    : (state.calculated ? 'Calculated' : (preview.status || 'Blocked'))
  const currency = preview.currency_code || 'USD'
  const manual = preview.manual_earnings || {}
  const deductions = preview.deductions || {}
  const committed = preview.committed_hours || {}
  const commitmentTargets = Array.isArray(committed.payroll_targets)
    ? committed.payroll_targets
    : [
        ...(Array.isArray(committed.carryover_targets) ? committed.carryover_targets : []),
        ...(Array.isArray(committed.targets) ? committed.targets : [])
      ]
  const payableCommittedMinutes = commitmentTargets.reduce((total, target) =>
    total + Math.max(Number(target.payable_minutes || 0), 0), 0)
  const rateLines = Array.isArray(preview.rate_breakdown) && preview.rate_breakdown.length
    ? preview.rate_breakdown.map(rate => `${formatMoney(rate.hourly_rate, rate.currency_code)} / hour effective ${formatDate(rate.effective_date)}`).join('; ')
    : 'No payable attendance, leave, or Committed Hours dates.'
  const values = [
    ['Payroll Status', displayStatus],
    ['Total Payable Minutes', String(preview.total_payable_minutes ?? 0)],
    ['Total Payable Hours', formatHours(preview.total_payable_minutes)],
    ['Agent Rate Breakdown', rateLines],
    ['Attendance Earnings', formatMoney(preview.attendance_earnings, currency)],
    ['Paid Leave Earnings', formatMoney(preview.paid_leave_earnings, currency)],
    ['Committed Hours Expected', formatHours(committed.expected_minutes)],
    ['Committed Hours Qualifying', formatHours(committed.payroll_ready_minutes)],
    ['Committed Hours Covered', formatHours(committed.covered_minutes)],
    ['Committed Hours Remaining', formatHours(committed.remaining_minutes)],
    ['Committed Hours Payable', formatHours(payableCommittedMinutes)],
    ['Committed Hours Earnings', formatMoney(committed.monetary_effect, currency)],
    ['Approved Manual Earnings', formatMoney(manual.approved_amount, currency)],
    ['Approved Deductions', formatMoney(deductions.approved_amount ?? preview.total_deductions, currency)],
    ['Gross Pay', formatMoney(preview.gross_pay, currency)],
    ['Net Pay', formatMoney(preview.net_pay, currency)]
  ]
  if (state.calculated) {
    values.splice(1, 0,
      ['Calculated At', formatTimestamp(persistence.calculated_at)],
      ['Approved At', formatTimestamp(persistence.approved_at)],
      ['Approved By', persistence.approved_by_name || '—'],
      ...(recordStatus === 'finalized' ? [
        ['Finalized At', formatTimestamp(persistence.finalized_at)],
        ['Finalized By', persistence.finalized_by_name || '—']
      ] : []))
  }
  elements.previewBody.replaceChildren()
  for (const value of values) appendTableRow(elements.previewBody, value)
  elements.previewStatus.replaceChildren()
  const blockers = Array.isArray(preview.blockers) ? preview.blockers : []
  if (preview.ready_to_preview) {
    const readyMessage = state.recalculationPending
      ? 'Fresh read-only preview ready. The saved calculation remains unchanged until Recalculate Employee succeeds.'
      : `${preview.persistence?.message || 'Read-only preview. No payroll data has been saved.'}${state.calculated ? '' : ` Approved manual earnings: ${manual.approved_count || 0}; excluded earnings: ${manual.excluded_count || 0}; approved deductions: ${deductions.approved_count || 0}; excluded deductions: ${deductions.excluded_count || 0}.`}`
    const attendanceExclusionNote = blockers.length
      ? ` ${blockers.length} attendance readiness issue(s) remain; unfinished attendance is excluded from WORKED earnings while payable Committed Hours and other ready inputs remain included.`
      : ''
    elements.previewStatus.textContent = `${readyMessage}${attendanceExclusionNote}`
    elements.previewStatus.classList.remove('is-blocked')
  } else {
    const summary = document.createElement('strong')
    summary.textContent = 'Blocked. Final monetary totals are unavailable.'
    elements.previewStatus.append(summary)
    const list = document.createElement('ul')
    list.className = 'payroll-v2-preview-blockers'
    for (const blocker of blockers) {
      const item = document.createElement('li')
      const date = blocker.work_date ? `${formatDate(blocker.work_date)}: ` : ''
      item.textContent = `${date}${blocker.message || String(blocker.code || 'Payroll readiness issue').replaceAll('_', ' ')}`
      list.append(item)
    }
    elements.previewStatus.append(list)
    elements.previewStatus.classList.add('is-blocked')
  }

  const dailyRows = Array.isArray(preview.daily_breakdown) ? preview.daily_breakdown : []
  elements.dailyBreakdownBody.replaceChildren()
  for (const day of dailyRows) {
    const rateText = day.hourly_rate == null ? '—' : `${formatMoney(day.hourly_rate, day.currency_code)} / h`
    appendTableRow(elements.dailyBreakdownBody, [
      formatDate(day.work_date),
      String(day.payable_minutes ?? 0),
      rateText,
      formatMoney(day.attendance_amount, currency),
      formatMoney(day.leave_amount, currency),
      formatMoney(day.committed_hours_amount, currency),
      formatMoney(day.total_amount, currency)
    ])
  }
  if (!dailyRows.length) setEmptyRow(elements.dailyBreakdownBody,
    preview.ready_to_preview ? 'No payable work dates in this period.' : 'Daily amounts are unavailable while blocked.', 7)
  renderManualEarnings(manual)
  renderDeductions(deductions)
  renderLeave(preview.paid_leave_rows, preview.daily_breakdown)
  const period = selectedPeriod()
  const draftPeriod = Boolean(period && String(period.status).toLowerCase() === 'draft')
  elements.calculateButton.hidden = state.calculated || !preview.ready_to_preview || !state.canCreate || !draftPeriod
  elements.calculateButton.disabled = state.calculated || !preview.ready_to_preview || !state.canCreate || !draftPeriod
  const canApproveRecord = recordStatus === 'calculated'
    && Boolean(preview.persistence?.payroll_v2_record_id)
    && state.canApprove
  elements.approveButton.hidden = !canApproveRecord
  elements.approveButton.disabled = !canApproveRecord || state.approving
  const savedStatus = String(state.savedCalculation?.persistence?.record_status || '').toLowerCase()
  const canReopen = savedStatus === 'calculated' && !state.recalculationPending
    && state.savedCalculation?.persistence?.approved_at == null
    && state.canCreate && draftPeriod
  const canRecalculate = savedStatus === 'calculated' && state.recalculationPending
    && Boolean(state.freshPreviewToken) && preview.ready_to_preview
    && state.canCreate && draftPeriod
  elements.recalculateButton.hidden = !(canReopen || (savedStatus === 'calculated' && state.recalculationPending))
  elements.recalculateButton.disabled = state.recalculationPending ? !canRecalculate : !canReopen
  elements.recalculateButton.textContent = state.recalculationPending
    ? 'Recalculate Employee'
    : 'Reopen for Recalculation'
  elements.approveButton.hidden = elements.approveButton.hidden || state.recalculationPending
  elements.approveButton.disabled = elements.approveButton.disabled || state.recalculationPending
  const canFinalizeRecord = canFinalizeEmployeeAction(preview.persistence, {
    canFinalize: state.canFinalize,
    recalculationPending: state.recalculationPending,
    periodStatus: period?.status
  }) && Boolean(period)
  elements.finalizeButton.hidden = !canFinalizeRecord
  elements.finalizeButton.disabled = !canFinalizeRecord || state.finalizing
}

async function loadIndividualEmployeeData(employeeUserId) {
  const employeeRequestId = ++state.individualEmployeeRequestId
  const workspaceRequestId = state.individualWorkspaceRequestId
  const period = selectedPeriod()
  if (!period || !employeeUserId) {
    resetIndividualSections('Select an employee to load the read-only payslip structure.')
    return
  }
  resetIndividualSections('Loading employee payroll data…')
  elements.employeeSections.hidden = false

  const { data, error } = await supabase.rpc('payroll_v2_get_individual_payslip_data', {
    p_payroll_v2_period_id: period.period_id,
    p_employee_user_id: employeeUserId
  })

  if (workspaceRequestId !== state.individualWorkspaceRequestId
      || employeeRequestId !== state.individualEmployeeRequestId
      || state.selectedPeriodId !== period.period_id
      || elements.employeeSelect.value !== employeeUserId) return

  if (error) {
    resetIndividualSections(`Employee payroll data could not be loaded: ${error.message || 'Unknown data source error.'}`)
    elements.employeeSections.hidden = false
    return
  }

  if (data?.period?.period_id !== period.period_id
      || data?.employee?.employee_user_id !== employeeUserId) {
    resetIndividualSections('Attendance data did not match the selected payroll period and employee. Select the employee again to retry.')
    elements.employeeSections.hidden = false
    return
  }

  const inPeriodAttendance = (Array.isArray(data.attendance) ? data.attendance : []).filter(attendance => {
    const workDate = String(attendance.work_date || '')
    return workDate >= period.period_start && workDate <= period.period_end
  })
  const { data: savedCalculation, error: savedCalculationError } = await supabase.rpc('payroll_v2_get_calculated_employee', {
    p_payroll_v2_period_id: period.period_id,
    p_employee_user_id: employeeUserId
  })
  if (workspaceRequestId !== state.individualWorkspaceRequestId
      || employeeRequestId !== state.individualEmployeeRequestId
      || state.selectedPeriodId !== period.period_id
      || elements.employeeSelect.value !== employeeUserId) return
  if (savedCalculationError) {
    resetIndividualSections(`Saved V2 payroll could not be loaded: ${savedCalculationError.message || 'Unknown result error.'}`)
    elements.employeeSections.hidden = false
    return
  }

  const { data: adjustments, error: adjustmentsError } = await supabase.rpc('payroll_v2_list_employee_adjustments', {
    p_payroll_v2_period_id: period.period_id,
    p_employee_user_id: employeeUserId
  })
  if (workspaceRequestId !== state.individualWorkspaceRequestId
      || employeeRequestId !== state.individualEmployeeRequestId
      || state.selectedPeriodId !== period.period_id
      || elements.employeeSelect.value !== employeeUserId) return
  if (adjustmentsError) {
    resetIndividualSections(`Payroll V2 adjustments could not be loaded: ${adjustmentsError.message || 'Unknown adjustment error.'}`)
    elements.employeeSections.hidden = false
    return
  }

  const isCalculated = Boolean(savedCalculation?.persistence?.saved)
  state.savedCalculation = isCalculated ? savedCalculation : null
  state.calculated = isCalculated
  state.recalculationPending = Boolean(savedCalculation?.persistence?.recalculation_pending)
  state.recalculationReason = savedCalculation?.persistence?.recalculation_pending_reason || ''
  state.freshPreviewToken = ''
  state.adjustments = isCalculated && !state.recalculationPending
    ? { manual_earnings: savedCalculation.manual_earnings?.rows || [], deductions: savedCalculation.deductions?.rows || [] }
    : { manual_earnings: adjustments?.manual_earnings || [], deductions: adjustments?.deductions || [] }
  const savedAttendance = isCalculated && !state.recalculationPending && Array.isArray(savedCalculation.attendance_source_rows)
    ? savedCalculation.attendance_source_rows.filter(attendance => {
      const workDate = String(attendance.work_date || '')
      return workDate >= period.period_start && workDate <= period.period_end
    })
    : null
  const scopedData = {
    ...data,
    attendance: savedAttendance || inPeriodAttendance,
    employee: {
      ...data.employee,
      payslip_status: isCalculated
        ? (savedCalculation.status || savedCalculation.persistence?.record_status || 'Calculated')
        : data.employee.payslip_status
    }
  }

  elements.individualWorkspaceMessage.textContent = state.recalculationNotice
    ? state.recalculationNotice
    : state.recalculationPending
    ? 'Open for recalculation. The saved calculation remains unchanged until a new recalculation succeeds.'
    : isCalculated
    ? 'Calculated Payroll V2 result loaded from its saved calculation and snapshots. Live source changes do not rewrite this result.'
    : 'Read-only employee view. Payroll has not been calculated or saved.'
  state.recalculationNotice = ''
  elements.employeeSections.hidden = false
  elements.employeeName.textContent = scopedData.employee.employee_name || '—'
  elements.employeeNumber.textContent = scopedData.employee.employee_number || '—'
  elements.employeePeriod.textContent = periodRange(scopedData.period)
  elements.employeeRate.textContent = formatRate(scopedData.employee.agent_rate)
  elements.employeePayslipStatus.textContent = String(scopedData.employee.payslip_status || 'Not Calculated')
    .replace(/^./, character => character.toUpperCase())

  const payableMinutes = renderAttendance(scopedData)
  state.previewInput = { periodId: period.period_id, employeeUserId }
  elements.previewButton.disabled = isCalculated && !state.recalculationPending
  elements.previewButton.textContent = isCalculated && !state.recalculationPending ? 'Calculated Payroll' : 'Preview Payroll'
  if (isCalculated && !state.recalculationPending) {
    renderCommitments(savedCalculation.committed_hours)
    renderLeave(savedCalculation.paid_leave_rows, savedCalculation.daily_breakdown)
    renderManualEarnings(savedCalculation.manual_earnings)
    renderDeductions(savedCalculation.deductions)
  } else {
    renderCommitments(scopedData.committed_hours)
    renderLeave(scopedData.leave)
    renderManualEarnings({
      rows: state.adjustments.manual_earnings,
      available: true,
      approved_count: state.adjustments.manual_earnings.filter(row => row.status === 'Approved').length,
      excluded_count: state.adjustments.manual_earnings.filter(row => row.status !== 'Approved').length
    })
    renderDeductions({
      rows: state.adjustments.deductions,
      approved_count: state.adjustments.deductions.filter(row => row.status === 'Approved').length,
      excluded_count: state.adjustments.deductions.filter(row => row.status !== 'Approved').length
    })
  }
  renderReadiness(isCalculated && !state.recalculationPending
    ? { ...scopedData, committed_hours: savedCalculation.committed_hours, leave: savedCalculation.paid_leave_rows }
    : scopedData, payableMinutes)
  if (isCalculated) {
    renderPreview(savedCalculation, true)
  } else {
    state.latestPreview = null
    state.calculated = false
    state.savedCalculation = null
    elements.calculateButton.hidden = true
    elements.calculateButton.disabled = true
    elements.approveButton.hidden = true
    elements.approveButton.disabled = true
    elements.previewStatus.textContent = 'Select Preview Payroll to calculate a read-only estimate.'
    setEmptyRow(elements.previewBody, 'Preview not run.', 2)
    setEmptyRow(elements.dailyBreakdownBody, 'Preview not run.', 7)
  }
}

async function runEmployeePreview() {
  const input = state.previewInput
  const period = selectedPeriod()
  if (!input || !period || input.periodId !== period.period_id
      || input.employeeUserId !== elements.employeeSelect.value) return

  const requestId = ++state.previewRequestId
  const workspaceRequestId = state.individualWorkspaceRequestId
  const employeeRequestId = state.individualEmployeeRequestId
  state.freshPreviewToken = ''
  if (state.recalculationPending) elements.recalculateButton.disabled = true
  elements.previewButton.disabled = true
  elements.previewButton.textContent = 'Calculating…'
  elements.previewStatus.textContent = 'Loading current attendance, rates, Committed Hours, leave, manual earnings, and deductions…'

  const { data, error } = await supabase.rpc('payroll_v2_preview_employee', {
    p_payroll_v2_period_id: input.periodId,
    p_employee_user_id: input.employeeUserId
  })

  if (requestId !== state.previewRequestId
      || workspaceRequestId !== state.individualWorkspaceRequestId
      || employeeRequestId !== state.individualEmployeeRequestId
      || state.selectedPeriodId !== input.periodId
      || elements.employeeSelect.value !== input.employeeUserId) return

  elements.previewButton.disabled = false
  elements.previewButton.textContent = 'Preview Payroll'
  if (error) {
    elements.previewStatus.textContent = `Preview could not be loaded: ${error.message || 'Unknown preview error.'}`
    elements.previewStatus.classList.add('is-blocked')
    setEmptyRow(elements.previewBody, 'Preview unavailable.', 2)
    setEmptyRow(elements.dailyBreakdownBody, 'Preview unavailable.', 7)
    return
  }

  if (data?.period?.period_id !== input.periodId
      || data?.employee?.employee_user_id !== input.employeeUserId) {
    elements.previewStatus.textContent = 'Preview response did not match the selected period and employee.'
    elements.previewStatus.classList.add('is-blocked')
    return
  }

  renderPreview(data)
}

function openCalculateConfirmation() {
  const input = state.previewInput
  const period = selectedPeriod()
  const preview = state.latestPreview
  if (!state.canCreate || !input || !period || !preview?.ready_to_preview || state.calculated
      || input.periodId !== period.period_id
      || input.employeeUserId !== elements.employeeSelect.value) return
  state.pendingCalculationInput = { ...input }
  elements.calculateEmployeeName.textContent = preview.employee?.employee_name || elements.employeeName.textContent || '—'
  elements.calculateEmployeePeriod.textContent = periodRange(period)
  elements.calculateEmployeeHours.textContent = formatHours(preview.total_payable_minutes)
  elements.calculateEmployeeAttendance.textContent = formatMoney(preview.attendance_earnings, preview.currency_code)
  elements.calculateEmployeeLeave.textContent = formatMoney(preview.paid_leave_earnings, preview.currency_code)
  elements.calculateEmployeeCommitted.textContent = formatMoney(preview.committed_hours?.monetary_effect, preview.currency_code)
  elements.calculateEmployeeManual.textContent = formatMoney(preview.manual_earnings?.approved_amount, preview.currency_code)
  elements.calculateEmployeeDeductions.textContent = formatMoney(preview.deductions?.approved_amount ?? preview.total_deductions, preview.currency_code)
  elements.calculateEmployeeGross.textContent = formatMoney(preview.gross_pay, preview.currency_code)
  elements.calculateEmployeeNet.textContent = formatMoney(preview.net_pay, preview.currency_code)
  elements.calculateEmployeeError.textContent = ''
  elements.confirmCalculateButton.disabled = false
  elements.confirmCalculateButton.textContent = 'Calculate Employee'
  elements.calculateDialog.showModal()
}

async function confirmCalculateEmployee() {
  const input = state.pendingCalculationInput
  const period = selectedPeriod()
  if (!input || !period || state.calculating || state.calculated
      || input.periodId !== period.period_id
      || input.employeeUserId !== elements.employeeSelect.value) return

  state.calculating = true
  elements.confirmCalculateButton.disabled = true
  elements.confirmCalculateButton.textContent = 'Calculating…'
  elements.calculateEmployeeError.textContent = ''
  const { data, error } = await supabase.rpc('payroll_v2_calculate_employee', {
    p_payroll_v2_period_id: input.periodId,
    p_employee_user_id: input.employeeUserId
  })
  state.calculating = false
  elements.confirmCalculateButton.disabled = false
  elements.confirmCalculateButton.textContent = 'Calculate Employee'

  if (error) {
    elements.calculateEmployeeError.textContent = String(error.message || 'Payroll could not be calculated.')
    return
  }
  if (data?.period?.period_id !== input.periodId
      || data?.employee?.employee_user_id !== input.employeeUserId
      || data?.persistence?.saved !== true) {
    elements.calculateEmployeeError.textContent = 'The saved calculation did not match the selected employee and payroll period.'
    return
  }

  state.pendingCalculationInput = null
  if (elements.calculateDialog.open) elements.calculateDialog.close()
  await loadIndividualEmployeeData(input.employeeUserId)
  try {
    await loadPeriods()
  } catch (refreshError) {
    elements.previewStatus.textContent = `Calculation saved, but Payroll History could not refresh: ${refreshError.message || 'Reload to refresh the count.'}`
  }
}

function openRecalculationDialog() {
  const period = selectedPeriod()
  const saved = state.savedCalculation
  const persistence = saved?.persistence
  const draft = period && String(period.status || '').toLowerCase() === 'draft'
  if (!state.canCreate || !draft || persistence?.record_status !== 'calculated'
      || persistence?.approved_at != null || !persistence?.payroll_v2_record_id) return
  if (state.recalculationPending
      && (!state.latestPreview?.ready_to_preview || !state.freshPreviewToken)) return

  state.recalculationDialogMode = state.recalculationPending ? 'recalculate' : 'reopen'
  elements.recalculateTitle.textContent = state.recalculationPending
    ? 'Recalculate Employee?'
    : 'Reopen for Recalculation?'
  elements.recalculateMessage.textContent = state.recalculationPending
    ? 'The saved calculation remains intact unless the fresh preview succeeds and the replacement commits. This affects only this employee.'
    : 'The saved calculation remains unchanged. This opens only Manual Earnings and Deductions for this employee; Attendance, Leave, Agent Rates, and Committed Hours remain authoritative source data.'
  elements.recalculateReason.value = state.recalculationPending ? state.recalculationReason : ''
  elements.recalculateError.textContent = ''
  elements.confirmRecalculateButton.disabled = false
  elements.confirmRecalculateButton.textContent = state.recalculationPending
    ? 'Recalculate Employee'
    : 'Reopen for Recalculation'
  elements.recalculateDialog.showModal()
  elements.recalculateReason.focus()
}

async function confirmRecalculationAction(event) {
  event?.preventDefault()
  const period = selectedPeriod()
  const saved = state.savedCalculation
  const input = state.previewInput
  const reason = elements.recalculateReason.value.trim()
  const mode = state.recalculationDialogMode
  if (state.recalculating || !state.canCreate || !period || !input
      || String(period.status || '').toLowerCase() !== 'draft'
      || input.periodId !== period.period_id
      || input.employeeUserId !== elements.employeeSelect.value
      || saved?.persistence?.record_status !== 'calculated'
      || !saved.persistence.payroll_v2_record_id
      || saved.employee?.employee_user_id !== input.employeeUserId
      || reason.length < 5 || reason.length > 240) {
    elements.recalculateError.textContent = 'Check the selected Draft period and enter a reason between 5 and 240 characters.'
    return
  }

  state.recalculating = true
  elements.confirmRecalculateButton.disabled = true
  elements.confirmRecalculateButton.textContent = mode === 'reopen' ? 'Reopening…' : 'Recalculating…'
  elements.recalculateError.textContent = ''
  const rpc = mode === 'reopen'
    ? supabase.rpc('payroll_v2_reopen_employee_for_recalculation', {
      p_payroll_v2_record_id: saved.persistence.payroll_v2_record_id,
      p_reason: reason
    })
    : supabase.rpc('payroll_v2_recalculate_employee', {
      p_payroll_v2_record_id: saved.persistence.payroll_v2_record_id,
      p_preview_token: state.freshPreviewToken,
      p_reason: reason
    })
  const { data, error } = await rpc
  state.recalculating = false
  elements.confirmRecalculateButton.disabled = false
  elements.confirmRecalculateButton.textContent = mode === 'reopen'
    ? 'Reopen for Recalculation'
    : 'Recalculate Employee'
  if (error) {
    elements.recalculateError.textContent = String(error.message || 'Payroll V2 recalculation could not be completed.')
    return
  }
  const responseRecordId = mode === 'recalculate'
    ? data?.persistence?.payroll_v2_record_id
    : data?.payroll_v2_record_id
  if (responseRecordId !== saved.persistence.payroll_v2_record_id
      || (mode === 'reopen' && data?.recalculation_pending !== true)
      || (mode === 'recalculate' && (data?.persistence?.recalculated !== true
        || data?.persistence?.record_status !== 'calculated'))) {
    elements.recalculateError.textContent = 'The response did not match the selected saved Payroll V2 calculation.'
    return
  }

  state.recalculationReason = reason
  state.recalculationPending = mode === 'reopen'
  state.freshPreviewToken = ''
  state.recalculationDialogMode = ''
  elements.recalculateDialog.close()
  if (mode === 'recalculate') {
    await loadIndividualEmployeeData(input.employeeUserId)
    elements.individualWorkspaceMessage.textContent = 'Recalculated successfully. The saved Payroll V2 payslip now shows the refreshed calculation.'
    try {
      await loadPeriods()
    } catch (refreshError) {
      elements.previewStatus.textContent = `Recalculated successfully, but Payroll History could not refresh: ${refreshError.message || 'Reload to update the list.'}`
    }
  } else {
    await loadIndividualEmployeeData(input.employeeUserId)
  }
}

function openApproveConfirmation() {
  const saved = state.savedCalculation
  const period = selectedPeriod()
  const persistence = saved?.persistence
  if (!state.canApprove || !period || !persistence?.saved
      || persistence.record_status !== 'calculated'
      || !persistence.payroll_v2_record_id
      || saved.period?.period_id !== period.period_id
      || saved.employee?.employee_user_id !== elements.employeeSelect.value
      || state.previewInput?.periodId !== period.period_id
      || String(period.status || '').toLowerCase() === 'void'
      || elements.employeeSelect.value !== state.previewInput?.employeeUserId) return

  state.pendingApprovalRecordId = persistence.payroll_v2_record_id
  const currency = saved.currency_code || 'USD'
  elements.approveEmployeeName.textContent = saved.employee?.employee_name || elements.employeeName.textContent || '—'
  elements.approveEmployeePeriod.textContent = periodRange(period)
  elements.approveEmployeeCalculatedAt.textContent = formatTimestamp(persistence.calculated_at)
  elements.approveEmployeeHours.textContent = formatHours(saved.total_payable_minutes)
  elements.approveEmployeeAttendance.textContent = formatMoney(saved.attendance_earnings, currency)
  elements.approveEmployeeLeave.textContent = formatMoney(saved.paid_leave_earnings, currency)
  elements.approveEmployeeCommitted.textContent = formatMoney(saved.committed_hours?.monetary_effect, currency)
  elements.approveEmployeeManual.textContent = formatMoney(saved.manual_earnings?.approved_amount, currency)
  elements.approveEmployeeDeductions.textContent = formatMoney(saved.deductions?.approved_amount ?? saved.total_deductions, currency)
  elements.approveEmployeeGross.textContent = formatMoney(saved.gross_pay, currency)
  elements.approveEmployeeNet.textContent = formatMoney(saved.net_pay, currency)
  elements.approveEmployeeError.textContent = ''
  elements.confirmApproveButton.disabled = false
  elements.confirmApproveButton.textContent = 'Approve Employee'
  elements.approveDialog.showModal()
}

function openFinalizeConfirmation() {
  if (state.finalizing) return
  const saved = state.savedCalculation
  const period = selectedPeriod()
  const persistence = saved?.persistence
  if (!period || !canFinalizeEmployeeAction(persistence, {
        canFinalize: state.canFinalize,
        recalculationPending: state.recalculationPending,
        periodStatus: period.status
      })
      || saved.period?.period_id !== period.period_id
      || saved.employee?.employee_user_id !== elements.employeeSelect.value
      || state.previewInput?.periodId !== period.period_id
      || String(period.status || '').toLowerCase() === 'void'
      || elements.employeeSelect.value !== state.previewInput?.employeeUserId
      || state.recalculationPending) return

  state.pendingFinalizationRecordId = persistence.payroll_v2_record_id
  const summary = finalizeEmployeeSummary(saved, period)
  const currency = saved.currency_code || 'USD'
  const employeeName = summary.employee === '—'
    ? (elements.employeeName.textContent || '—')
    : summary.employee
  elements.finalizeTitle.textContent = `Review ${employeeName}’s Payslip`
  elements.finalizeEmployeeName.textContent = employeeName
  elements.finalizeEmployeePeriod.textContent = summary.period
  elements.finalizeEmployeePaymentDate.textContent = formatDate(summary.paymentDate)
  elements.finalizeEmployeeStatus.textContent = summary.status
  elements.finalizeEmployeeHours.textContent = formatHours(summary.totalPayableMinutes)
  elements.finalizeEmployeeAttendance.textContent = formatMoney(summary.attendanceEarnings, currency)
  elements.finalizeEmployeeLeave.textContent = formatMoney(summary.paidLeaveEarnings, currency)
  elements.finalizeEmployeeCommitted.textContent = formatMoney(summary.committedHours.monetaryEffect, currency)
  elements.finalizeEmployeeManual.textContent = formatMoney(summary.manualEarnings, currency)
  elements.finalizeEmployeeGross.textContent = formatMoney(summary.grossPay, currency)
  elements.finalizeEmployeeDeductions.textContent = formatMoney(summary.deductions, currency)
  elements.finalizeEmployeeNet.textContent = formatMoney(summary.netPay, currency)
  elements.finalizeEmployeeCommittedStatus.textContent = summary.committedHours.status

  elements.finalizeEmployeeRateBody.replaceChildren()
  for (const rate of summary.rateBreakdown) {
    const workDates = Array.isArray(rate.work_dates)
      ? rate.work_dates.map(formatDate).join(', ')
      : String(rate.work_dates ?? '—')
    appendTableRow(elements.finalizeEmployeeRateBody, [
      formatDate(rate.effective_date),
      rate.hourly_rate == null ? '—' : `${formatMoney(rate.hourly_rate, rate.currency_code || currency)} / hour`,
      workDates,
      formatHours(rate.attendance_minutes),
      formatHours(rate.leave_minutes),
      formatHours(rate.committed_minutes)
    ])
  }
  if (!summary.rateBreakdown.length) {
    setEmptyRow(elements.finalizeEmployeeRateBody, 'No payable rate details.', 6)
  }

  elements.finalizeEmployeeCommittedBody.replaceChildren()
  for (const snapshot of summary.committedHours.snapshots) {
    appendTableRow(elements.finalizeEmployeeCommittedBody, [
      formatDate(snapshot.work_date),
      formatHours(snapshot.expected_committed_minutes),
      formatHours(snapshot.covered_committed_minutes),
      formatHours(snapshot.remaining_committed_minutes)
    ])
  }
  if (!summary.committedHours.snapshots.length) {
    setEmptyRow(elements.finalizeEmployeeCommittedBody, 'No commitment required.', 4)
  }

  elements.finalizeEmployeeItemsBody.replaceChildren()
  for (const item of summary.items) {
    const itemCurrency = item.metadata?.currency_code || currency
    appendTableRow(elements.finalizeEmployeeItemsBody, [
      String(item.item_type || 'payroll item').replaceAll('_', ' '),
      item.work_date ? formatDate(item.work_date) : '—',
      item.description || '—',
      item.minutes == null ? '—' : formatHours(item.minutes),
      item.rate == null ? '—' : `${formatMoney(item.rate, itemCurrency)} / hour`,
      item.amount == null ? '—' : formatMoney(item.amount, itemCurrency)
    ])
  }
  if (!summary.items.length) setEmptyRow(elements.finalizeEmployeeItemsBody, 'No saved payslip items.', 6)

  elements.finalizeEmployeeDeductionsBody.replaceChildren()
  for (const deduction of summary.approvedDeductions) {
    const itemCurrency = deduction.metadata?.currency_code || currency
    appendTableRow(elements.finalizeEmployeeDeductionsBody, [
      deduction.description || 'Deduction',
      deduction.amount == null ? '—' : formatMoney(deduction.amount, itemCurrency)
    ])
  }
  if (!summary.approvedDeductions.length) {
    setEmptyRow(elements.finalizeEmployeeDeductionsBody, 'No approved deductions.', 2)
  }

  elements.finalizeEmployeeError.textContent = ''
  elements.confirmFinalizeButton.disabled = false
  elements.confirmFinalizeButton.textContent = `Finalize ${employeeName}’s Payslip`
  elements.finalizeDialog.showModal()
}

function openAdjustmentDialog(kind) {
  if (!canEditAdjustments()) return
  state.pendingAdjustmentKind = kind
  elements.adjustmentTitle.textContent = kind === 'earning' ? 'Add Manual Earning' : 'Add Deduction'
  elements.saveAdjustmentButton.textContent = kind === 'earning' ? 'Save Earning' : 'Save Deduction'
  elements.adjustmentDescription.value = ''
  elements.adjustmentAmount.value = ''
  elements.adjustmentError.textContent = ''
  elements.adjustmentDialog.showModal()
  elements.adjustmentDescription.focus()
}

async function saveEmployeeAdjustment(event) {
  event.preventDefault()
  const period = selectedPeriod()
  const input = state.previewInput
  if (!canEditAdjustments() || !period || !input || state.savingAdjustment
      || input.periodId !== period.period_id || input.employeeUserId !== elements.employeeSelect.value) return
  state.savingAdjustment = true
  elements.saveAdjustmentButton.disabled = true
  elements.saveAdjustmentButton.textContent = 'Saving…'
  elements.adjustmentError.textContent = ''
  const { error } = await supabase.rpc('payroll_v2_add_employee_adjustment', {
    p_payroll_v2_period_id: input.periodId,
    p_employee_user_id: input.employeeUserId,
    p_kind: state.pendingAdjustmentKind,
    p_description: elements.adjustmentDescription.value.trim(),
    p_amount: Number(elements.adjustmentAmount.value)
  })
  state.savingAdjustment = false
  elements.saveAdjustmentButton.disabled = false
  elements.saveAdjustmentButton.textContent = state.pendingAdjustmentKind === 'earning' ? 'Save Earning' : 'Save Deduction'
  if (error) {
    elements.adjustmentError.textContent = error.message || 'Adjustment could not be saved.'
    return
  }
  state.pendingAdjustmentKind = ''
  elements.adjustmentDialog.close()
  await loadIndividualEmployeeData(input.employeeUserId)
}

function openVoidAdjustment(event) {
  const button = event.target.closest('[data-void-adjustment]')
  if (!button || !canEditAdjustments()) return
  const period = selectedPeriod()
  const input = state.previewInput
  if (!period || !input || input.periodId !== period.period_id) return
  state.pendingVoidAdjustment = {
    id: button.dataset.voidAdjustment,
    kind: button.dataset.adjustmentKind,
    description: button.dataset.adjustmentDescription || 'Payroll adjustment',
    amount: button.dataset.adjustmentAmount,
    periodId: input.periodId,
    employeeUserId: input.employeeUserId
  }
  elements.voidAdjustmentSummary.textContent = `${state.pendingVoidAdjustment.kind === 'earning' ? 'Manual earning' : 'Deduction'}: ${state.pendingVoidAdjustment.description} — USD ${Number(state.pendingVoidAdjustment.amount || 0).toFixed(2)}`
  elements.voidAdjustmentError.textContent = ''
  elements.confirmVoidAdjustmentButton.disabled = false
  elements.voidAdjustmentDialog.showModal()
}

async function confirmVoidEmployeeAdjustment() {
  const pending = state.pendingVoidAdjustment
  const period = selectedPeriod()
  if (!pending || !period || !canEditAdjustments() || state.voidingAdjustment
      || period.period_id !== pending.periodId || elements.employeeSelect.value !== pending.employeeUserId) return
  state.voidingAdjustment = true
  elements.confirmVoidAdjustmentButton.disabled = true
  elements.confirmVoidAdjustmentButton.textContent = 'Voiding…'
  elements.voidAdjustmentError.textContent = ''
  const { error } = await supabase.rpc('payroll_v2_void_employee_adjustment', {
    p_payroll_v2_period_id: pending.periodId,
    p_employee_user_id: pending.employeeUserId,
    p_adjustment_id: pending.id,
    p_kind: pending.kind
  })
  state.voidingAdjustment = false
  elements.confirmVoidAdjustmentButton.disabled = false
  elements.confirmVoidAdjustmentButton.textContent = 'Void Adjustment'
  if (error) {
    elements.voidAdjustmentError.textContent = error.message || 'Adjustment could not be voided.'
    return
  }
  state.pendingVoidAdjustment = null
  elements.voidAdjustmentDialog.close()
  await loadIndividualEmployeeData(pending.employeeUserId)
}

async function confirmApproveEmployee() {
  const recordId = state.pendingApprovalRecordId
  const saved = state.savedCalculation
  const period = selectedPeriod()
  if (!recordId || !state.canApprove || state.approving || !period
      || saved?.persistence?.record_status !== 'calculated'
      || saved.persistence.payroll_v2_record_id !== recordId
      || saved.period?.period_id !== period.period_id
      || saved.employee?.employee_user_id !== elements.employeeSelect.value
      || state.previewInput?.periodId !== period.period_id
      || String(period.status || '').toLowerCase() === 'void') return

  state.approving = true
  elements.confirmApproveButton.disabled = true
  elements.confirmApproveButton.textContent = 'Approving…'
  elements.approveButton.disabled = true
  elements.approveEmployeeError.textContent = ''
  const { data, error } = await supabase.rpc('payroll_v2_approve_employee', {
    p_payroll_v2_record_id: recordId
  })
  state.approving = false
  elements.confirmApproveButton.disabled = false
  elements.confirmApproveButton.textContent = 'Approve Employee'
  if (error) {
    elements.approveButton.disabled = false
    elements.approveEmployeeError.textContent = String(error.message || 'Payroll could not be approved.')
    return
  }
  if (data?.payroll_v2_record_id !== recordId || data?.record_status !== 'approved') {
    elements.approveButton.disabled = false
    elements.approveEmployeeError.textContent = 'The approval response did not match the selected saved payslip.'
    return
  }

  state.pendingApprovalRecordId = ''
  if (elements.approveDialog.open) elements.approveDialog.close()
  const employeeUserId = saved.employee?.employee_user_id || state.previewInput?.employeeUserId
  await loadIndividualEmployeeData(employeeUserId)
  try {
    await loadPeriods()
  } catch (refreshError) {
    elements.previewStatus.textContent = `Employee approved, but Payroll History could not refresh: ${refreshError.message || 'Refresh to update the list.'}`
  }
}

async function confirmFinalizeEmployee() {
  const recordId = state.pendingFinalizationRecordId
  const saved = state.savedCalculation
  const period = selectedPeriod()
  const persistence = saved?.persistence
  if (!recordId || state.finalizing || !period
      || !canFinalizeEmployeeAction(persistence, {
        canFinalize: state.canFinalize,
        recalculationPending: state.recalculationPending,
        periodStatus: period.status
      })
      || persistence.payroll_v2_record_id !== recordId
      || saved.period?.period_id !== period.period_id
      || saved.employee?.employee_user_id !== elements.employeeSelect.value
      || state.previewInput?.periodId !== period.period_id
      || elements.employeeSelect.value !== state.previewInput?.employeeUserId
      || String(period.status || '').toLowerCase() === 'void'
      || state.recalculationPending) return

  elements.confirmFinalizeButton.disabled = true
  elements.confirmFinalizeButton.textContent = 'Finalizing…'
  elements.finalizeButton.disabled = true
  elements.finalizeEmployeeError.textContent = ''
  const result = await submitEmployeeFinalization(recordId, state, id => supabase.rpc('payroll_v2_finalize_employee', {
    p_payroll_v2_record_id: id
  }))
  if (result.skipped) return
  const { data, error } = result
  elements.confirmFinalizeButton.disabled = false
  elements.confirmFinalizeButton.textContent = `Finalize ${elements.finalizeEmployeeName.textContent}’s Payslip`
  if (error) {
    elements.finalizeButton.disabled = false
    elements.finalizeEmployeeError.textContent = String(error.message || 'Payroll could not be finalized.')
    return
  }
  if (data?.payroll_v2_record_id !== recordId || data?.record_status !== 'finalized') {
    elements.finalizeButton.disabled = false
    elements.finalizeEmployeeError.textContent = 'The finalization response did not match the selected saved payslip.'
    return
  }

  state.pendingFinalizationRecordId = ''
  if (elements.finalizeDialog.open) elements.finalizeDialog.close()
  const employeeUserId = saved.employee?.employee_user_id || state.previewInput?.employeeUserId
  await loadIndividualEmployeeData(employeeUserId)
  try {
    await loadPeriods()
  } catch (refreshError) {
    elements.previewStatus.textContent = `Employee finalized, but Payroll History could not refresh: ${refreshError.message || 'Refresh to update the list.'}`
  }
}

async function openIndividualWorkspace(preferredEmployeeUserId = '') {
  const period = selectedPeriod()
  if (!period) return
  const workspaceRequestId = ++state.individualWorkspaceRequestId
  state.individualEmployeeRequestId += 1

  elements.addMenu.hidden = true
  elements.addButton.setAttribute('aria-expanded', 'false')
  elements.individualWorkspace.hidden = false
  elements.individualPeriodRange.textContent = periodRange(period)
  elements.individualPeriodStart.textContent = formatDate(period.period_start)
  elements.individualPeriodEnd.textContent = formatDate(period.period_end)
  elements.individualPaymentDate.textContent = formatDate(period.payment_date)
  elements.individualPeriodStatus.textContent = String(period.status || 'draft').replaceAll('_', ' ')
  elements.employeeSelect.disabled = true
  elements.employeeSelect.replaceChildren(new Option('Loading employees…', ''))
  resetIndividualSections('Select an employee to load the read-only payslip structure.')

  const { data, error } = await supabase.rpc('payroll_v2_list_individual_employees', {
    p_payroll_v2_period_id: period.period_id
  })
  if (workspaceRequestId !== state.individualWorkspaceRequestId
      || state.selectedPeriodId !== period.period_id) return

  if (error) {
    elements.individualWorkspaceMessage.textContent = `Employee list could not be loaded: ${error.message || 'Unknown employee source error.'}`
    elements.employeeSelect.replaceChildren(new Option('Employee list unavailable', ''))
    return
  }

  elements.employeeSelect.replaceChildren(new Option('Select Employee', ''))
  for (const employee of Array.isArray(data) ? data : []) {
    const option = new Option(employee.employee_name || employee.employee_number || 'Employee', employee.employee_user_id)
    elements.employeeSelect.append(option)
  }
  elements.employeeSelect.disabled = !elements.employeeSelect.options.length || elements.employeeSelect.options.length === 1
  if (preferredEmployeeUserId
      && Array.from(elements.employeeSelect.options).some(option => option.value === preferredEmployeeUserId)) {
    elements.employeeSelect.value = preferredEmployeeUserId
  }
  elements.individualWorkspaceMessage.textContent = elements.employeeSelect.disabled
    ? 'No active payroll eligible employees are available for selection.'
    : 'Select an employee to load the read-only payslip structure.'
  if (elements.employeeSelect.value) void loadIndividualEmployeeData(elements.employeeSelect.value)
}

function renderPeriods() {
  elements.tableBody.replaceChildren()

  if (!state.periods.length) {
    const row = document.createElement('tr')
    const cell = makeCell(row, 'No Payroll V2 periods yet.')
    cell.colSpan = 7
    elements.tableBody.append(row)
    state.selectedPeriodId = ''
    renderSelection()
    return
  }

  for (const period of state.periods) {
    const row = document.createElement('tr')
    row.dataset.periodId = period.period_id
    row.setAttribute('aria-selected', String(period.period_id === state.selectedPeriodId))
    makeCell(row, formatDate(period.period_start))
    makeCell(row, formatDate(period.period_end))
    makeCell(row, formatDate(period.payment_date))
    const status = String(period.status || 'draft').replaceAll('_', ' ')
    const statusCell = makeCell(row, status.charAt(0).toUpperCase() + status.slice(1))
    applyStatusBadge(statusCell, status.charAt(0).toUpperCase() + status.slice(1), status)
    makeCell(row, formatPaypalRate(period.paypal_conversion_rate))
    const payslipCountCell = makeCell(row, String(Number(period.payslip_count || 0)))
    payslipCountCell.dataset.payslipCount = ''

    const actionCell = document.createElement('td')
    actionCell.className = 'payroll-v2-period-actions-cell'
    const actionControls = document.createElement('div')
    actionControls.className = 'payroll-v2-actions'
    const selectButton = document.createElement('button')
    if (String(period.status || '').toLowerCase() === 'void') {
      actionControls.textContent = '—'
    } else {
      selectButton.className = 'plain-button'
      selectButton.type = 'button'
      selectButton.dataset.selectPeriod = period.period_id
      selectButton.textContent = period.period_id === state.selectedPeriodId ? 'Selected' : 'Select'
      actionControls.append(selectButton)
    }
    if (state.canCreate && String(period.status || '').toLowerCase() === 'draft') {
      const voidButton = document.createElement('button')
      voidButton.className = 'payroll-v2-void-action'
      voidButton.type = 'button'
      voidButton.dataset.voidPeriod = period.period_id
      voidButton.textContent = '×'
      voidButton.setAttribute('aria-label', 'Void payroll period')
      voidButton.title = 'Void payroll period'
      actionControls.append(voidButton)
    }
    if (!actionControls.childElementCount && !actionControls.textContent) actionControls.textContent = '—'
    actionCell.append(actionControls)
    row.append(actionCell)
    elements.tableBody.append(row)
  }

  renderSelection()
}

function renderSelection() {
  const period = selectedPeriod()
  const closed = periodIsClosed(period)
  elements.addButton.disabled = !period || closed
  elements.selectedPeriodLabel.textContent = period
    ? `Selected: ${periodRange(period)}${closed ? ' · Closed 🔒' : ''}`
    : 'Select a payroll period first.'

  const periodId = period?.period_id || ''
  if (state.periodRateEditorPeriodId !== periodId) {
    state.periodRateEditorPeriodId = periodId
    elements.selectedPeriodPaypalRate.value = period?.paypal_conversion_rate == null
      ? ''
      : String(period.paypal_conversion_rate)
    elements.periodPaypalRateMessage.textContent = ''
  }
  elements.periodPaypalRateForm.hidden = !period
  elements.selectedPeriodPaypalRate.disabled = !state.canCreate || state.savingPaypalRate
    || String(period?.status || '').toLowerCase() === 'void'
  elements.savePeriodPaypalRateButton.disabled = elements.selectedPeriodPaypalRate.disabled
  elements.savePeriodPaypalRateButton.textContent = state.savingPaypalRate
    ? 'Saving…'
    : 'Save Conversion Rate'

  renderPeriodCloseControls()

  for (const row of elements.tableBody.querySelectorAll('tr[data-period-id]')) {
    const selected = row.dataset.periodId === state.selectedPeriodId
    row.setAttribute('aria-selected', String(selected))
    const button = row.querySelector('[data-select-period]')
    if (button) button.textContent = selected ? 'Selected' : 'Select'
  }
}

function renderPeriodCloseControls() {
  const period = selectedPeriod()
  const closeState = state.periodCloseState?.period_id === period?.period_id
    ? state.periodCloseState
    : null
  const closed = periodIsClosed(period)

  elements.closePeriodButton.hidden = !period || closed || !state.canCreate
  elements.closePeriodButton.disabled = !closeState?.close_eligible || state.closing
  elements.closePeriodButton.textContent = state.closing ? 'Closing…' : 'Close Period'

  let reason = ''
  if (period && !closed && state.canCreate) {
    reason = closeState?.reason || (closeState ? '' : 'Loading close eligibility…')
  }
  elements.periodCloseReason.textContent = reason
  elements.periodCloseReason.hidden = !reason
}

function setCompletedPayslipsStatus(message = '') {
  elements.completedPayslipsStatus.textContent = message
  elements.completedPayslipsStatus.hidden = !message
}

function updatePeriodPayslipCount(periodId, count) {
  const period = state.periods.find(item => item.period_id === periodId)
  const row = Array.from(elements.tableBody.querySelectorAll('tr[data-period-id]'))
    .find(item => item.dataset.periodId === periodId)
  const cell = row?.querySelector('[data-payslip-count]')
  if (Number.isInteger(count) && period) period.payslip_count = count
  if (cell) cell.textContent = Number.isInteger(count) ? String(count) : count
}

function appendEyeIcon(link) {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  icon.setAttribute('viewBox', '0 0 24 24')
  icon.setAttribute('aria-hidden', 'true')
  icon.setAttribute('focusable', 'false')
  const outline = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  outline.setAttribute('d', 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z')
  const pupil = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  pupil.setAttribute('cx', '12')
  pupil.setAttribute('cy', '12')
  pupil.setAttribute('r', '3')
  for (const shape of [outline, pupil]) {
    shape.setAttribute('fill', 'none')
    shape.setAttribute('stroke', 'currentColor')
    shape.setAttribute('stroke-width', '1.8')
  }
  icon.append(outline, pupil)
  link.append(icon)
}

function renderCompletedPayslips(rows) {
  elements.completedPayslipsList.replaceChildren()
  const completed = visibleCompletedPayslips(rows)
  updatePeriodPayslipCount(selectedPeriod()?.period_id, completed.length)

  if (!completed.length) {
    setCompletedPayslipsStatus('No completed payslips yet.')
    return
  }

  setCompletedPayslipsStatus()
  const fragment = document.createDocumentFragment()
  for (const record of completed) {
    const recordId = String(record.payroll_v2_record_id || '')
    if (!recordId) continue
    const name = String(record.employee_name || 'Employee')
    const status = String(record.status).toLowerCase()
    const row = document.createElement('li')
    row.className = 'payroll-v2-completed-row'
    const nameLabel = document.createElement('span')
    nameLabel.className = 'payroll-v2-completed-name'
    nameLabel.textContent = name
    const statusLabel = document.createElement('span')
    statusLabel.className = `payroll-v2-completed-badge status-${status}`
    statusLabel.textContent = status === 'finalized' ? 'Finalized' : 'Approved'
    const view = document.createElement('a')
    view.className = 'payroll-v2-view-payslip'
    view.href = `./payslip-v2-preview.html?${new URLSearchParams({ record: recordId, admin: '1' })}`
    view.setAttribute('aria-label', `View ${name} payslip`)
    view.title = `View ${name} payslip`
    appendEyeIcon(view)
    row.append(nameLabel, statusLabel, view)
    fragment.append(row)
  }

  if (!fragment.childElementCount) {
    setCompletedPayslipsStatus('No completed payslips yet.')
    return
  }
  elements.completedPayslipsList.replaceChildren(fragment)
}

async function loadCompletedPayslips() {
  const requestId = ++state.completedPayslipRequestId
  const period = selectedPeriod()
  elements.completedPayslipsList.replaceChildren()
  if (!period) {
    setCompletedPayslipsStatus('Select a payroll period first.')
    return
  }

  setCompletedPayslipsStatus('Loading completed payslips…')
  updatePeriodPayslipCount(period.period_id, '…')
  const { data, error } = await supabase.rpc('payroll_v2_list_completed_payslips', {
    p_payroll_v2_period_id: period.period_id
  })
  if (requestId !== state.completedPayslipRequestId
      || state.selectedPeriodId !== period.period_id) return
  if (error) {
    updatePeriodPayslipCount(period.period_id, '—')
    setCompletedPayslipsStatus('Completed payslips could not be loaded. Refresh the page to retry.')
    return
  }
  renderCompletedPayslips(data)
}

async function loadPeriodCloseState() {
  const requestId = ++state.periodCloseRequestId
  const period = selectedPeriod()
  state.periodCloseState = null
  renderPeriodCloseControls()
  if (!period) return

  const { data, error } = await supabase.rpc('payroll_v2_get_period_close_state', {
    p_payroll_v2_period_id: period.period_id
  })
  if (requestId !== state.periodCloseRequestId
      || state.selectedPeriodId !== period.period_id) return
  if (error) {
    state.periodCloseState = {
      period_id: period.period_id,
      close_eligible: false,
      reason: 'Period closure status could not be loaded. Refresh to retry.'
    }
    renderPeriodCloseControls()
    return
  }
  state.periodCloseState = data || null
  renderPeriodCloseControls()
}

async function loadPeriods() {
  const { data, error } = await supabase.rpc('payroll_v2_list_periods_with_rate')
  if (error) throw error

  state.periods = Array.isArray(data) ? data : []
  if (!state.periods.some(period => period.period_id === state.selectedPeriodId
      && String(period.status || '').toLowerCase() !== 'void')) {
    const requestedId = new URLSearchParams(window.location.search).get('period')
    state.selectedPeriodId = state.periods.some(period => period.period_id === requestedId
      && String(period.status || '').toLowerCase() !== 'void')
      ? requestedId
      : ''
  }
  renderPeriods()
  await loadCompletedPayslips()
  await loadPeriodCloseState()
}

function validatePeriodDates() {
  const start = elements.start.value
  const end = elements.end.value
  if (!start) return 'Start Date is required.'
  if (!end) return 'End Date is required.'
  if (!elements.payment.value) return 'Payment Date is required.'
  if (end < start) return 'End Date cannot be before Start Date.'
  return ''
}

async function savePeriod(event) {
  event.preventDefault()
  const validationError = validatePeriodDates()
  if (validationError) {
    elements.formError.textContent = validationError
    return
  }

  const paypalRate = optionalPaypalRate(elements.createPaypalRate)
  if (paypalRate.error) {
    elements.formError.textContent = paypalRate.error
    return
  }

  state.saving = true
  elements.saveButton.disabled = true
  elements.formError.textContent = ''

  const { data, error } = await supabase.rpc('payroll_v2_create_period', {
    p_period_start: elements.start.value,
    p_period_end: elements.end.value,
    p_payment_date: elements.payment.value,
    p_paypal_conversion_rate: paypalRate.value
  })

  state.saving = false
  elements.saveButton.disabled = false

  if (error) {
    elements.formError.textContent = error.code === '23P01'
      ? String(error.message || 'This date range overlaps another Payroll V2 period.')
      : String(error.message || 'The period could not be created.')
    return
  }

  elements.createDialog.close()
  elements.createForm.reset()
  state.selectedPeriodId = data?.period_id || ''
  setMessage('Draft period created. Payroll has not been calculated.', 'success')

  try {
    await loadPeriods()
    if (data?.period_id) state.selectedPeriodId = data.period_id
    renderPeriods()
  } catch {
    setMessage('The period was saved, but the list could not refresh. Reload the page to see it.', 'error')
  }
}

async function saveSelectedPeriodPaypalRate(event) {
  event.preventDefault()
  const period = selectedPeriod()
  if (!period || !state.canCreate || String(period.status || '').toLowerCase() === 'void'
      || state.savingPaypalRate) return

  const paypalRate = optionalPaypalRate(elements.selectedPeriodPaypalRate)
  if (paypalRate.error) {
    elements.periodPaypalRateMessage.textContent = paypalRate.error
    return
  }

  state.savingPaypalRate = true
  elements.periodPaypalRateMessage.textContent = ''
  renderSelection()
  const { error } = await supabase.rpc('payroll_v2_set_period_paypal_conversion_rate', {
    p_payroll_v2_period_id: period.period_id,
    p_paypal_conversion_rate: paypalRate.value
  })
  state.savingPaypalRate = false

  if (error) {
    elements.periodPaypalRateMessage.textContent = error.message
      || 'PayPal Conversion Rate could not be saved.'
    renderSelection()
    return
  }

  try {
    await loadPeriods()
    elements.periodPaypalRateMessage.textContent = 'PayPal Conversion Rate saved for this period.'
  } catch {
    elements.periodPaypalRateMessage.textContent = 'The rate was saved, but the period could not refresh. Reload to verify it.'
  }
  renderSelection()
}

function openPlaceholder(kind) {
  const period = selectedPeriod()
  if (!period || periodIsClosed(period)) return

  if (kind === 'individual') {
    void openIndividualWorkspace()
    return
  }

  elements.placeholderTitle.textContent = kind === 'individual'
    ? 'Individual Payslip'
    : 'Group Payslip'
  elements.placeholderPeriod.textContent = `Payroll Period: ${periodRange(period)}`
  elements.addMenu.hidden = true
  elements.addButton.setAttribute('aria-expanded', 'false')
  elements.placeholderDialog.showModal()
}

function openVoidConfirmation(periodId) {
  if (!state.canCreate || state.voiding) return
  const period = state.periods.find(candidate => candidate.period_id === periodId)
  if (!period || String(period.status || '').toLowerCase() !== 'draft') return

  state.pendingVoidPeriodId = period.period_id
  elements.voidStart.textContent = formatDate(period.period_start)
  elements.voidEnd.textContent = formatDate(period.period_end)
  elements.voidPaymentDate.textContent = formatDate(period.payment_date)
  elements.voidError.textContent = ''
  elements.confirmVoidButton.disabled = false
  elements.confirmVoidButton.textContent = 'Void Period'
  elements.voidDialog.showModal()
}

function openCloseConfirmation() {
  const period = selectedPeriod()
  const closeState = state.periodCloseState
  if (!state.canCreate || state.closing || !period || periodIsClosed(period)
      || closeState?.period_id !== period.period_id || !closeState.close_eligible) return

  state.pendingClosePeriodId = period.period_id
  elements.closePeriodRange.textContent = `${formatDate(period.period_start)} – ${formatDate(period.period_end)}`
  elements.closePeriodPayslipCount.textContent = String(Number(closeState.payslip_count || 0))
  elements.closePeriodApprovedCount.textContent = String(Number(closeState.approved_count || 0))
  elements.closePeriodFinalizedCount.textContent = String(Number(closeState.finalized_count || 0))
  elements.closePeriodError.textContent = ''
  elements.confirmClosePeriodButton.disabled = false
  elements.confirmClosePeriodButton.textContent = 'Close Period'
  elements.closePeriodDialog.showModal()
}

async function confirmClosePeriod() {
  if (!state.canCreate || state.closing || !state.pendingClosePeriodId) return
  const period = state.periods.find(candidate => candidate.period_id === state.pendingClosePeriodId)
  if (!period || periodIsClosed(period)) {
    elements.closePeriodError.textContent = 'This period is already closed or unavailable.'
    return
  }

  state.closing = true
  elements.confirmClosePeriodButton.disabled = true
  elements.confirmClosePeriodButton.textContent = 'Closing…'
  renderPeriodCloseControls()
  elements.closePeriodError.textContent = ''

  const { data, error } = await supabase.rpc('payroll_v2_close_period', {
    p_payroll_v2_period_id: period.period_id
  })

  state.closing = false
  elements.confirmClosePeriodButton.disabled = false
  elements.confirmClosePeriodButton.textContent = 'Close Period'
  renderPeriodCloseControls()
  if (error) {
    elements.closePeriodError.textContent = String(error.message || 'The period could not be closed.')
    await loadPeriodCloseState()
    return
  }

  state.pendingClosePeriodId = ''
  if (elements.closePeriodDialog.open) elements.closePeriodDialog.close()
  state.periods = state.periods.map(candidate => candidate.period_id === period.period_id
    ? { ...candidate, ...data, status: 'closed' }
    : candidate)
  state.periodCloseState = data || { period_id: period.period_id, status: 'closed' }
  renderPeriods()
  setMessage('Payroll period closed. Existing payslips remain unchanged.', 'success')

  try {
    await loadPeriods()
  } catch (refreshError) {
    setMessage(`The period was closed, but History could not refresh: ${refreshError.message || 'Refresh to update its status.'}`, 'error')
  }
}

function resetVoidedPeriodWorkspaces() {
  state.individualWorkspaceRequestId += 1
  state.individualEmployeeRequestId += 1
  elements.individualWorkspace.hidden = true
  elements.individualEmployeeSections.hidden = true
  elements.employeeSelect.replaceChildren(new Option('Select Employee', ''))
  elements.employeeSelect.disabled = true
  resetIndividualSections('Select an employee.')
  if (elements.placeholderDialog.open) elements.placeholderDialog.close()
  elements.addMenu.hidden = true
  elements.addButton.setAttribute('aria-expanded', 'false')
}

async function confirmVoidPeriod() {
  if (!state.canCreate || state.voiding) return
  const period = state.periods.find(candidate => candidate.period_id === state.pendingVoidPeriodId)
  if (!period || String(period.status || '').toLowerCase() !== 'draft') {
    elements.voidError.textContent = 'Only a Draft Payroll V2 period can be voided.'
    return
  }

  state.voiding = true
  elements.confirmVoidButton.disabled = true
  elements.confirmVoidButton.textContent = 'Voiding…'
  elements.voidError.textContent = ''

  const { data, error } = await supabase.rpc('payroll_v2_void_period', {
    p_payroll_v2_period_id: period.period_id
  })

  state.voiding = false
  elements.confirmVoidButton.disabled = false
  elements.confirmVoidButton.textContent = 'Void Period'

  if (error) {
    elements.voidError.textContent = String(error.message || 'The period could not be voided.')
    return
  }

  const voidedPeriodWasSelected = state.selectedPeriodId === period.period_id
  if (voidedPeriodWasSelected) state.selectedPeriodId = ''
  state.pendingVoidPeriodId = ''
  if (elements.voidDialog.open) elements.voidDialog.close()
  if (data?.period_id === period.period_id) {
    state.periods = state.periods.map(candidate => candidate.period_id === period.period_id
      ? { ...candidate, ...data }
      : candidate)
  } else {
    state.periods = state.periods.map(candidate => candidate.period_id === period.period_id
      ? { ...candidate, status: 'void' }
      : candidate)
  }
  renderPeriods()
  if (voidedPeriodWasSelected) {
    try {
      resetVoidedPeriodWorkspaces()
    } catch (resetError) {
      console.error('Unable to fully reset the voided Payroll V2 workspace:', resetError)
    }
    renderSelection()
  }
  setMessage('Payroll V2 period marked Void and retained in Payroll History.', 'success')

  try {
    await loadPeriods()
  } catch (refreshError) {
    setMessage(`The period was voided, but History could not refresh: ${refreshError.message || 'Refresh the page to see its status.'}`, 'error')
  }
}

async function initialize() {
  try {
    const access = await loadCurrentWorkforceAccess(supabase)
    if (!access.authenticated) {
      window.location.replace('./login.html?returnTo=payroll-v2.html')
      return
    }

    const canView = VIEW_PERMISSIONS.some(permission =>
      hasWorkforcePermission(access, permission)
    )
    if (!access.allowed || !canView) {
      window.alert('You do not have permission to access Payroll Dashboard V2.')
      window.location.replace('./home.html')
      return
    }

    state.canCreate = hasWorkforcePermission(access, 'create_payroll')
    state.canApprove = hasWorkforcePermission(access, 'review_payroll')
    state.canFinalize = hasWorkforcePermission(access, 'finalize_payroll')
    elements.createButton.disabled = !state.canCreate
    document.body.classList.remove('payroll-v2-access-pending')
    await loadPeriods()
  } catch (error) {
    console.error('Unable to initialize Payroll Dashboard V2:', error)
    setMessage('Payroll V2 could not load. Refresh the page and try again.', 'error')
    document.body.classList.remove('payroll-v2-access-pending')
  }
}

elements.createButton.addEventListener('click', () => {
  if (!state.canCreate) return
  elements.formError.textContent = ''
  elements.createDialog.showModal()
})
elements.createForm.addEventListener('submit', savePeriod)
elements.periodPaypalRateForm.addEventListener('submit', saveSelectedPeriodPaypalRate)
elements.cancelButton.addEventListener('click', () => elements.createDialog.close())
elements.addButton.addEventListener('click', () => {
  if (elements.addButton.disabled) return
  elements.addMenu.hidden = !elements.addMenu.hidden
  elements.addButton.setAttribute('aria-expanded', String(!elements.addMenu.hidden))
})
elements.tableBody.addEventListener('click', event => {
  const voidButton = event.target.closest('[data-void-period]')
  if (voidButton) {
    openVoidConfirmation(voidButton.dataset.voidPeriod)
    return
  }
  const button = event.target.closest('[data-select-period]')
  if (!button) return
  const workspaceWasOpen = !elements.individualWorkspace.hidden
  const selectedEmployeeUserId = elements.employeeSelect.value
  state.selectedPeriodId = button.dataset.selectPeriod
  state.periodCloseState = null
  renderPeriods()
  void loadCompletedPayslips()
  void loadPeriodCloseState()
  if (workspaceWasOpen) void openIndividualWorkspace(selectedEmployeeUserId)
})
elements.confirmVoidButton.addEventListener('click', confirmVoidPeriod)
elements.cancelVoidButton.addEventListener('click', () => {
  state.pendingVoidPeriodId = ''
  elements.voidDialog.close()
})
elements.closePeriodButton.addEventListener('click', openCloseConfirmation)
elements.confirmClosePeriodButton.addEventListener('click', confirmClosePeriod)
elements.cancelClosePeriodButton.addEventListener('click', () => {
  state.pendingClosePeriodId = ''
  elements.closePeriodDialog.close()
})
elements.addMenu.addEventListener('click', event => {
  const button = event.target.closest('[data-workflow]')
  if (button) openPlaceholder(button.dataset.workflow)
})
elements.closePlaceholderButton.addEventListener('click', () => elements.placeholderDialog.close())
elements.closeIndividualWorkspaceButton.addEventListener('click', () => {
  state.individualWorkspaceRequestId += 1
  state.individualEmployeeRequestId += 1
  elements.individualWorkspace.hidden = true
})
elements.employeeSelect.addEventListener('change', () => {
  void loadIndividualEmployeeData(elements.employeeSelect.value)
})
elements.previewButton.addEventListener('click', runEmployeePreview)
elements.addEarningButton.addEventListener('click', () => openAdjustmentDialog('earning'))
elements.addDeductionButton.addEventListener('click', () => openAdjustmentDialog('deduction'))
elements.manualEarningsBody.addEventListener('click', openVoidAdjustment)
elements.deductionsBody.addEventListener('click', openVoidAdjustment)
elements.adjustmentForm.addEventListener('submit', saveEmployeeAdjustment)
elements.cancelAdjustmentButton.addEventListener('click', () => {
  state.pendingAdjustmentKind = ''
  elements.adjustmentDialog.close()
})
elements.confirmVoidAdjustmentButton.addEventListener('click', confirmVoidEmployeeAdjustment)
elements.cancelVoidAdjustmentButton.addEventListener('click', () => {
  state.pendingVoidAdjustment = null
  elements.voidAdjustmentDialog.close()
})
elements.calculateButton.addEventListener('click', openCalculateConfirmation)
elements.confirmCalculateButton.addEventListener('click', confirmCalculateEmployee)
elements.cancelCalculateButton.addEventListener('click', () => {
  state.pendingCalculationInput = null
  elements.calculateDialog.close()
})
elements.recalculateButton.addEventListener('click', openRecalculationDialog)
elements.recalculateForm.addEventListener('submit', confirmRecalculationAction)
elements.cancelRecalculateButton.addEventListener('click', () => {
  state.recalculationDialogMode = ''
  elements.recalculateDialog.close()
})
elements.approveButton.addEventListener('click', openApproveConfirmation)
elements.confirmApproveButton.addEventListener('click', confirmApproveEmployee)
elements.cancelApproveButton.addEventListener('click', () => {
  state.pendingApprovalRecordId = ''
  elements.approveDialog.close()
})
elements.finalizeButton.addEventListener('click', openFinalizeConfirmation)
elements.confirmFinalizeButton.addEventListener('click', confirmFinalizeEmployee)
elements.cancelFinalizeButton.addEventListener('click', () => {
  state.pendingFinalizationRecordId = ''
  elements.finalizeDialog.close()
})

initialize()
