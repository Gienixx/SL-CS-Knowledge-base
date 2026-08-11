import { supabase } from './supabaseClient.js?v=11'
import {
  hasWorkforcePermission,
  loadCurrentWorkforceAccess
} from './workforce-permissions.js?v=1'

const PROCESS_PERMISSIONS = [
  'create_payroll',
  'review_payroll',
  'finalize_payroll',
  'reopen_payroll'
]

const ATTENDANCE_EXCEPTION_CODES = new Set([
  'incomplete_attendance',
  'unapproved_attendance',
  'missing_clock_out',
  'overtime_above_limit',
  'duplicate_attendance',
  'overlapping_schedules',
  'changed_attendance_after_import',
  'missing_attendance'
])

const PREPLOT_EXCEPTION_CODES = new Set([
  'schedule_changed_after_preplot_approval',
  'preplot_missing_payroll_approval',
  'invalid_preplot_minutes',
  'prepaid_balance_missing_source',
  'duplicate_prepaid_balance',
  'unaudited_prepaid_balance',
  'unresolved_prepaid_balance'
])

const state = {
  periodId: new URLSearchParams(window.location.search).get('id') || '',
  period: null,
  employees: [],
  preplots: [],
  prepaidBalances: [],
  selectedPreplots: new Set(),
  exceptions: [],
  calculations: [],
  adjustments: [],
  lifecycle: null,
  exceptionFilter: 'all',
  missingAttendance: new Map(),
  importStatuses: new Map(),
  canViewAttendance: false,
  canImportAttendance: false,
  canApprovePreplots: false,
  canManageSchedules: false,
  canManageRates: false,
  canCalculatePayroll: false,
  canReviewPayroll: false,
  canFinalizePayroll: false,
  canReopenPayroll: false,
  loading: false,
  loadSucceeded: false,
  loadError: null,
  sectionErrors: new Map(),
  payrollEmployeeSearch: '',
  importing: false,
  calculating: false,
  refreshingEmployee: false,
  savingAdjustment: false,
  savingLifecycle: false,
  lifecycleMode: 'review',
  adjustmentMode: 'add',
  selectedAdjustment: null,
  approvingPreplots: false,
  savingPrepaid: false,
  prepaidCandidate: null
  ,rateOverrides: new Map(),
  activeStep: 'readiness'
}

const elements = {
  message: document.getElementById('payrollPeriodMessage'),
  refresh: document.getElementById('refreshPayrollPeriodButton'),
  importButton: document.getElementById('importPayrollAttendanceButton'),
  importStatus: document.getElementById('payrollImportStatus'),
  preplotBody: document.getElementById('payrollPreplotBody'),
  preplotCount: document.getElementById('payrollPreplotCount'),
  preplotEligibleCount: document.getElementById('payrollPreplotEligibleCount'),
  preplotSelectedCount: document.getElementById('payrollPreplotSelectedCount'),
  preplotApprovedCount: document.getElementById('payrollPreplotApprovedCount'),
  preplotRemainingHours: document.getElementById(
    'payrollPreplotRemainingHours'
  ),
  preplotActions: document.getElementById('payrollPreplotActions'),
  preplotReason: document.getElementById('payrollPreplotReason'),
  approvePreplotsButton: document.getElementById(
    'approvePayrollPreplotsButton'
  ),
  preplotStatus: document.getElementById('payrollPreplotStatus'),
  addPrepaidButton: document.getElementById('addPayrollPrepaidButton'),
  prepaidDialog: document.getElementById('payrollPrepaidDialog'),
  prepaidForm: document.getElementById('payrollPrepaidForm'),
  prepaidEmployee: document.getElementById('payrollPrepaidEmployee'),
  prepaidDate: document.getElementById('payrollPrepaidDate'),
  prepaidLogin: document.getElementById('payrollPrepaidLogin'),
  prepaidLogout: document.getElementById('payrollPrepaidLogout'),
  prepaidTimezone: document.getElementById('payrollPrepaidTimezone'),
  prepaidHours: document.getElementById('payrollPrepaidHours'),
  prepaidSourceStatus: document.getElementById(
    'payrollPrepaidSourceStatus'
  ),
  prepaidConfirmWrap: document.getElementById(
    'payrollPrepaidConfirmWrap'
  ),
  prepaidConfirm: document.getElementById(
    'payrollPrepaidConfirmScheduleChange'
  ),
  prepaidConfirmText: document.getElementById(
    'payrollPrepaidConfirmText'
  ),
  prepaidReason: document.getElementById(
    'payrollPrepaidApprovalReason'
  ),
  prepaidMessage: document.getElementById('payrollPrepaidMessage'),
  savePrepaidButton: document.getElementById(
    'savePayrollPrepaidButton'
  ),
  closePrepaidButton: document.getElementById(
    'closePayrollPrepaidDialogButton'
  ),
  cancelPrepaidButton: document.getElementById(
    'cancelPayrollPrepaidButton'
  ),
  body: document.getElementById('payrollReadinessBody'),
  exceptionSummary: document.getElementById('payrollExceptionSummary'),
  exceptionTitle: document.getElementById('payrollExceptionTitle'),
  exceptionText: document.getElementById('payrollExceptionText'),
  exceptionChips: document.getElementById('payrollExceptionChips'),
  exceptionFilter: document.getElementById('payrollExceptionFilter'),
  exceptionCount: document.getElementById('payrollExceptionCount'),
  exceptionBody: document.getElementById('payrollExceptionBody'),
  calculateButton: document.getElementById('calculatePayrollButton'),
  calculationStatus: document.getElementById('payrollCalculationStatus'),
  calculationSearch: document.getElementById('payrollEmployeeSearch'),
  calculationSearchCount: document.getElementById('payrollEmployeeSearchCount'),
  calculationBody: document.getElementById('payrollCalculationBody'),
  calculatedEmployeeCount: document.getElementById(
    'payrollCalculatedEmployeeCount'
  ),
  calculatedGross: document.getElementById('payrollCalculatedGross'),
  calculatedDeductions: document.getElementById(
    'payrollCalculatedDeductions'
  ),
  calculatedNet: document.getElementById('payrollCalculatedNet'),
  addAdjustmentButton: document.getElementById(
    'addPayrollAdjustmentButton'
  ),
  adjustmentBody: document.getElementById('payrollAdjustmentBody'),
  adjustmentCount: document.getElementById('payrollAdjustmentCount'),
  adjustmentDialog: document.getElementById('payrollAdjustmentDialog'),
  adjustmentForm: document.getElementById('payrollAdjustmentForm'),
  adjustmentDialogTitle: document.getElementById(
    'payrollAdjustmentDialogTitle'
  ),
  adjustmentDialogText: document.getElementById(
    'payrollAdjustmentDialogText'
  ),
  adjustmentEmployee: document.getElementById(
    'payrollAdjustmentEmployee'
  ),
  adjustmentType: document.getElementById('payrollAdjustmentType'),
  adjustmentAmount: document.getElementById('payrollAdjustmentAmount'),
  adjustmentDescription: document.getElementById(
    'payrollAdjustmentDescription'
  ),
  adjustmentReasonLabel: document.getElementById(
    'payrollAdjustmentReasonLabel'
  ),
  adjustmentReason: document.getElementById('payrollAdjustmentReason'),
  adjustmentNotes: document.getElementById('payrollAdjustmentNotes'),
  adjustmentMessage: document.getElementById('payrollAdjustmentMessage'),
  saveAdjustmentButton: document.getElementById(
    'savePayrollAdjustmentButton'
  ),
  closeAdjustmentButton: document.getElementById(
    'closePayrollAdjustmentDialogButton'
  ),
  cancelAdjustmentButton: document.getElementById(
    'cancelPayrollAdjustmentButton'
  ),
  reviewPayrollButton: document.getElementById('reviewPayrollButton'),
  finalizePayrollButton: document.getElementById(
    'finalizePayrollButton'
  ),
  reopenPayrollButton: document.getElementById('reopenPayrollButton'),
  lifecycleStatus: document.getElementById('payrollLifecycleStatus'),
  lifecycleDialog: document.getElementById('payrollLifecycleDialog'),
  lifecycleForm: document.getElementById('payrollLifecycleForm'),
  lifecycleDialogEyebrow: document.getElementById(
    'payrollLifecycleDialogEyebrow'
  ),
  lifecycleDialogTitle: document.getElementById(
    'payrollLifecycleDialogTitle'
  ),
  lifecycleDialogText: document.getElementById(
    'payrollLifecycleDialogText'
  ),
  lifecycleSummary: document.getElementById(
    'payrollLifecycleConfirmationSummary'
  ),
  lifecycleReasonLabel: document.getElementById(
    'payrollLifecycleReasonLabel'
  ),
  lifecycleReason: document.getElementById('payrollLifecycleReason'),
  lifecycleConfirmWrap: document.getElementById(
    'payrollLifecycleConfirmWrap'
  ),
  lifecycleConfirm: document.getElementById('payrollLifecycleConfirm'),
  lifecycleConfirmText: document.getElementById(
    'payrollLifecycleConfirmText'
  ),
  lifecycleDialogMessage: document.getElementById(
    'payrollLifecycleDialogMessage'
  ),
  saveLifecycleButton: document.getElementById(
    'savePayrollLifecycleButton'
  ),
  closeLifecycleButton: document.getElementById(
    'closePayrollLifecycleDialogButton'
  ),
  cancelLifecycleButton: document.getElementById(
    'cancelPayrollLifecycleButton'
  )
}

const dateFormatter = new Intl.DateTimeFormat('en-PH', {
  year: 'numeric',
  month: 'short',
  day: 'numeric'
})

const moneyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})

function formatDate(value) {
  return value ? dateFormatter.format(new Date(`${value}T00:00:00`)) : '—'
}

function formatShiftTime(value, timezone = 'America/New_York') {
  if (!value) return '—'
  try {
    return new Intl.DateTimeFormat('en-PH', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: timezone || 'America/New_York'
    }).format(new Date(value))
  } catch {
    return '—'
  }
}

function formatHours(minutes) {
  const hours = Number(minutes || 0) / 60
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(2)
}

function approvedBilledMinutes(calculation) {
  return [
    calculation.regular_minutes,
    calculation.overtime_minutes,
    calculation.rest_day_minutes,
    calculation.holiday_minutes
  ].reduce((total, value) => total + Math.max(0, Number(value) || 0), 0)
}

function calculationHourlyRate(calculation) {
  const regularLine = (calculation.line_items || []).find(
    line => line.item_code === 'regular_earnings'
  )
  return Number(
    state.rateOverrides.get(calculation.payroll_record_id) ??
    regularLine?.unit_rate ?? 0
  )
}

function formatMoney(value) {
  return moneyFormatter.format(Number(value || 0))
}

function formatDateTime(value) {
  if (!value) return '—'
  try {
    return new Intl.DateTimeFormat('en-PH', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'Asia/Manila',
      timeZoneName: 'short'
    }).format(new Date(value))
  } catch {
    return '—'
  }
}

function setMessage(message = '', type = '') {
  elements.message.textContent = message
  elements.message.classList.toggle('error', type === 'error')
  elements.message.classList.toggle('success', type === 'success')
}

function element(tag, className = '', text = '') {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

function hasProcessingAccess(access) {
  return PROCESS_PERMISSIONS.some(permission =>
    hasWorkforcePermission(access, permission)
  )
}

function statusLabel(status) {
  return String(status || 'draft').replaceAll('_', ' ')
}

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function addCalendarDays(value, days) {
  const date = new Date(`${value}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function timeInputValue(value, timezone = 'America/New_York') {
  if (!value) return ''
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: timezone || 'America/New_York'
    }).formatToParts(new Date(value))
    const part = type => parts.find(entry => entry.type === type)?.value || ''
    return `${part('hour')}:${part('minute')}`
  } catch {
    return ''
  }
}

function timezoneParts(timestamp, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(timestamp))
  return Object.fromEntries(
    parts.map(part => [part.type, Number(part.value)])
  )
}

function zonedDateTimeTimestamp(date, time, timezone) {
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0)
  const calculateOffset = timestamp => {
    const parts = timezoneParts(timestamp, timezone)
    return Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    ) - timestamp
  }
  let timestamp = utcGuess - calculateOffset(utcGuess)
  timestamp = utcGuess - calculateOffset(timestamp)
  return timestamp
}

function prepaidMinutes(workDate, login, logout, timezone) {
  if (!workDate || !login || !logout || !timezone) return 0
  const [loginHour, loginMinute] = login.split(':').map(Number)
  const [logoutHour, logoutMinute] = logout.split(':').map(Number)
  if (
    [loginHour, loginMinute, logoutHour, logoutMinute].some(
      value => !Number.isFinite(value)
    )
  ) {
    return 0
  }
  try {
    const startMinute = (loginHour * 60) + loginMinute
    const endMinute = (logoutHour * 60) + logoutMinute
    const endDate = endMinute <= startMinute
      ? addCalendarDays(workDate, 1)
      : workDate
    const start = zonedDateTimeTimestamp(
      workDate,
      login,
      timezone
    )
    const end = zonedDateTimeTimestamp(
      endDate,
      logout,
      timezone
    )
    return Math.max(0, Math.round((end - start) / 60000))
  } catch {
    return 0
  }
}

function setPrepaidMessage(message = '', type = '') {
  elements.prepaidMessage.textContent = message
  elements.prepaidMessage.className = 'payroll-prepaid-message'
  if (type) elements.prepaidMessage.classList.add(type)
}

function selectedPrepaidCandidates() {
  const employeeId = elements.prepaidEmployee.value
  const workDate = elements.prepaidDate.value
  if (!employeeId || !workDate) return []
  return state.preplots.filter(
    candidate =>
      candidate.employee_user_id === employeeId &&
      candidate.work_date === workDate
  )
}

function prepaidValuesDiffer(candidate) {
  if (!candidate) return false
  const timezone = candidate.timezone || 'America/New_York'
  return (
    elements.prepaidLogin.value !==
      timeInputValue(candidate.shift_start, timezone) ||
    elements.prepaidLogout.value !==
      timeInputValue(candidate.shift_end, timezone) ||
    elements.prepaidTimezone.value.trim() !== timezone
  )
}

function updatePrepaidFormState({ loadCandidateTimes = false } = {}) {
  const candidates = selectedPrepaidCandidates()
  const candidate = candidates.length === 1 ? candidates[0] : null
  const hasSelection =
    Boolean(elements.prepaidEmployee.value) &&
    Boolean(elements.prepaidDate.value)
  const editablePeriod = ['draft', 'reopened'].includes(
    state.period?.period_status
  )

  state.prepaidCandidate = candidate

  if (candidate && loadCandidateTimes) {
    const timezone = candidate.timezone || 'America/New_York'
    elements.prepaidTimezone.value = timezone
    elements.prepaidLogin.value = timeInputValue(
      candidate.shift_start,
      timezone
    )
    elements.prepaidLogout.value = timeInputValue(
      candidate.shift_end,
      timezone
    )
    elements.prepaidConfirm.checked = false
  } else if (loadCandidateTimes) {
    elements.prepaidTimezone.value = 'America/New_York'
    elements.prepaidLogin.value = ''
    elements.prepaidLogout.value = ''
    elements.prepaidConfirm.checked = false
  }

  const minutes = prepaidMinutes(
    elements.prepaidDate.value,
    elements.prepaidLogin.value,
    elements.prepaidLogout.value,
    elements.prepaidTimezone.value.trim()
  )
  elements.prepaidHours.textContent = minutes
    ? `${formatHours(minutes)} hours`
    : '—'

  const candidateNeedsRepair = Boolean(candidate) &&
    ['unpublished', 'incomplete_shift', 'invalid_shift'].includes(
      candidate.approval_status
    )
  const existingNeedsManager =
    Boolean(candidate) &&
    (
      candidateNeedsRepair ||
      prepaidValuesDiffer(candidate)
    )
  const missingNeedsManager = hasSelection && candidates.length === 0
  const requiresManager = existingNeedsManager || missingNeedsManager
  const requiresConfirmation = existingNeedsManager

  elements.prepaidConfirmWrap.hidden = !requiresConfirmation
  if (requiresConfirmation) {
    elements.prepaidConfirmText.textContent =
      candidate?.schedule_status === 'scheduled' && !prepaidValuesDiffer(candidate)
        ? 'I confirm this source schedule should be published. This change will be permission-checked and audited.'
        : 'I confirm these times will change the source schedule. This change will be permission-checked and audited.'
  } else {
    elements.prepaidConfirm.checked = false
  }

  const lockTimes = Boolean(candidate) && !state.canManageSchedules
  elements.prepaidLogin.readOnly = lockTimes
  elements.prepaidLogout.readOnly = lockTimes
  elements.prepaidTimezone.readOnly = lockTimes

  let sourceMessage =
    'Select an employee and date to check the source schedule.'
  let sourceClass = ''
  let blocked = false

  if (hasSelection && candidates.length > 1) {
    sourceMessage =
      'Multiple schedules exist for this employee and date. Resolve them in Team Attendance before prepaid approval.'
    sourceClass = 'blocked'
    blocked = true
  } else if (candidate?.approval_status === 'approved') {
    sourceMessage =
      'This exact schedule version is already approved and preserved as prepaid hours.'
    sourceClass = 'ready'
    blocked = true
  } else if (
    candidate &&
    (
      ['rest_day', 'guaranteed_special_day', 'attendance_exists'].includes(
        candidate.approval_status
      ) ||
      ['cancelled', 'completed'].includes(candidate.schedule_status)
    )
  ) {
    sourceMessage =
      candidate.approval_message ||
      'This schedule cannot create prepaid hours.'
    sourceClass = 'blocked'
    blocked = true
  } else if (candidate && requiresManager && !state.canManageSchedules) {
    sourceMessage =
      'A schedule manager must publish or correct this source schedule first. Your payroll permission can approve it after that.'
    sourceClass = 'blocked'
    blocked = true
  } else if (candidate && requiresManager) {
    sourceMessage =
      'A source schedule exists. Confirm the audited schedule change, then it can be approved as prepaid hours.'
    sourceClass = 'warning'
  } else if (candidate) {
    sourceMessage =
      'An eligible source schedule exists. Its exact current version will be preserved when approved.'
    sourceClass = 'ready'
  } else if (hasSelection && !state.canManageSchedules) {
    sourceMessage =
      'No source schedule exists. A schedule manager must create it before payroll can approve prepaid hours.'
    sourceClass = 'blocked'
    blocked = true
  } else if (hasSelection) {
    sourceMessage =
      'No source schedule exists. Saving will create a published schedule, audit it, and approve its exact version.'
    sourceClass = 'warning'
  }

  elements.prepaidSourceStatus.className =
    `payroll-prepaid-source payroll-prepaid-wide${sourceClass ? ` ${sourceClass}` : ''}`
  elements.prepaidSourceStatus.textContent = sourceMessage

  const complete =
    hasSelection &&
    Boolean(elements.prepaidLogin.value) &&
    Boolean(elements.prepaidLogout.value) &&
    Boolean(elements.prepaidTimezone.value.trim()) &&
    Boolean(elements.prepaidReason.value.trim()) &&
    minutes > 0
  const confirmed =
    !requiresConfirmation || elements.prepaidConfirm.checked

  elements.savePrepaidButton.disabled =
    state.savingPrepaid ||
    !state.canApprovePreplots ||
    !editablePeriod ||
    blocked ||
    (requiresManager && !state.canManageSchedules) ||
    !complete ||
    !confirmed
  elements.savePrepaidButton.textContent =
    candidates.length === 0 && hasSelection
      ? 'Create schedule and approve'
      : requiresManager
        ? 'Update schedule and approve'
        : 'Approve prepaid schedule'
}

function renderPeriod() {
  const period = state.period
  if (!period) return

  document.getElementById('payrollPeriodTitle').textContent =
    `${formatDate(period.period_start)} – ${formatDate(period.period_end)}`
  document.getElementById('payrollPeriodSubtitle').textContent =
    `Payment date ${formatDate(period.payment_date)}${Number(period.early_payment_days || 0) ? ` · ${Number(period.early_payment_days)} ${Number(period.early_payment_days) === 1 ? 'day' : 'days'} early` : ' · cutoff day'} · ${Number(period.employee_count || 0)} eligible employees loaded`
  document.getElementById('payrollDetailStart').textContent =
    formatDate(period.period_start)
  document.getElementById('payrollDetailEnd').textContent =
    formatDate(period.period_end)
  document.getElementById('payrollDetailPayment').textContent =
    formatDate(period.payment_date)
  document.getElementById('payrollDetailCurrency').textContent =
    period.currency_code || 'USD'

  const status = document.getElementById('payrollDetailStatus')
  status.className = `payroll-status-badge ${period.period_status}`
  status.textContent = statusLabel(period.period_status)

  const importable = ['draft', 'reopened'].includes(period.period_status)
  elements.importButton.hidden = !state.canImportAttendance
  elements.importButton.disabled =
    state.loading || state.importing || !importable
  elements.importButton.title = importable
    ? 'Copy current payroll-ready attendance into immutable snapshots'
    : 'Attendance can only be imported into draft or reopened payroll periods'
  const hasPrepaidWindow =
    Boolean(period.payment_date) &&
    Boolean(period.period_end) &&
    period.payment_date < period.period_end
  elements.addPrepaidButton.hidden = !state.canApprovePreplots
  elements.addPrepaidButton.disabled =
    state.loading || !importable || !hasPrepaidWindow
  elements.addPrepaidButton.title = !hasPrepaidWindow
    ? 'This period is paid on the cutoff date and has no prepaid work dates'
    : importable
      ? 'Add prepaid hours from a real source schedule'
      : 'Prepaid schedules can only be added to draft or reopened periods'

  const blockingCount = state.exceptions.filter(
    issue => issue.is_blocking
  ).length
  elements.calculateButton.hidden = !state.canCalculatePayroll
  elements.calculateButton.disabled =
    state.loading ||
    state.calculating ||
    !state.loadSucceeded ||
    !importable ||
    blockingCount > 0
  elements.calculateButton.textContent = state.calculating
    ? 'Calculating…'
    : state.calculations.length
      ? 'Recalculate draft payroll'
      : 'Calculate draft payroll'
  elements.calculateButton.title = !state.loadSucceeded
    ? 'Refresh the period before calculating'
    : !importable
    ? 'Only draft or reopened payroll periods can be calculated'
    : blockingCount
      ? `Resolve ${blockingCount} blocking ${blockingCount === 1 ? 'exception' : 'exceptions'} before calculating`
      : 'Rebuild employee totals from the current approved snapshots'

  elements.addAdjustmentButton.hidden = !state.canCalculatePayroll
  elements.addAdjustmentButton.disabled =
    state.loading ||
    state.savingAdjustment ||
    !importable ||
    !state.calculations.length
  elements.addAdjustmentButton.title = !state.calculations.length
    ? 'Calculate draft payroll before adding adjustments'
    : importable
      ? 'Add an audited manual earning or deduction'
      : 'Adjustments are allowed only while payroll is editable'
}

function setLifecycleCheck(name, ready, readyText, blockedText) {
  const check = document.querySelector(
    `[data-lifecycle-check="${name}"]`
  )
  if (!check) return
  check.classList.toggle('ready', ready)
  check.classList.toggle('blocked', !ready)
  const icon = check.querySelector('.payroll-lifecycle-check-icon')
  if (icon) icon.textContent = ready ? '✓' : '!'
  const detail = check.querySelector('small')
  if (detail) detail.textContent = ready ? readyText : blockedText
}

function renderLifecycle() {
  const period = state.period
  if (!period) return

  const lifecycle = state.lifecycle || {}
  const blockingCount = state.exceptions.filter(
    issue => issue.is_blocking
  ).length
  const expectedRecords = Number(period.employee_count || 0)
  const recalculationCount = [...state.importStatuses.values()].filter(
    status => status.requires_recalculation
  ).length
  const calculationsReady =
    state.calculations.length > 0 &&
    (!expectedRecords || state.calculations.length === expectedRecords) &&
    recalculationCount === 0
  const exceptionsReady = blockingCount === 0
  const snapshotIssue = state.exceptions.some(
    issue =>
      issue.is_blocking &&
      (
        ATTENDANCE_EXCEPTION_CODES.has(issue.exception_code) ||
        PREPLOT_EXCEPTION_CODES.has(issue.exception_code)
      )
  )
  const snapshotsReady = calculationsReady && !snapshotIssue
  const balanceIssue = state.exceptions.some(
    issue =>
      issue.is_blocking &&
      PREPLOT_EXCEPTION_CODES.has(issue.exception_code)
  )
  const balancesReady = calculationsReady && !balanceIssue
  const rateIssue = state.exceptions.some(
    issue =>
      issue.is_blocking &&
      (
        issue.exception_code === 'missing_rate' ||
        issue.exception_code === 'changed_rate_after_calculation'
      )
  )
  const ratesReady = calculationsReady && !rateIssue
  const readyForReview =
    calculationsReady &&
    exceptionsReady &&
    snapshotsReady &&
    balancesReady &&
    ratesReady
  const status = period.period_status

  setLifecycleCheck(
    'calculation',
    calculationsReady,
    `${state.calculations.length} employee calculation${state.calculations.length === 1 ? '' : 's'} are current.`,
    recalculationCount
      ? `${recalculationCount} employee record${recalculationCount === 1 ? '' : 's'} require recalculation.`
      : 'Calculate every employee before review.'
  )
  setLifecycleCheck(
    'exceptions',
    exceptionsReady,
    'No blocking payroll exceptions were detected.',
    `${blockingCount} blocking exception${blockingCount === 1 ? '' : 's'} must be resolved.`
  )
  setLifecycleCheck(
    'snapshots',
    snapshotsReady,
    'Attendance and pre-plotted schedule versions are confirmed.',
    'Snapshot evidence is incomplete or has changed.'
  )
  setLifecycleCheck(
    'balances',
    balancesReady,
    'Prepaid-minute balances are ready to preserve.',
    'Resolve prepaid schedule or balance issues.'
  )
  setLifecycleCheck(
    'rates',
    ratesReady,
    'Effective USD rates and explicit rounding rules are confirmed.',
    'A rate is missing, changed, or not yet calculated.'
  )

  elements.reviewPayrollButton.hidden = !state.canReviewPayroll
  elements.reviewPayrollButton.disabled =
    state.loading ||
    state.savingLifecycle ||
    !['draft', 'reopened'].includes(status) ||
    !readyForReview

  elements.finalizePayrollButton.hidden = !state.canFinalizePayroll
  elements.finalizePayrollButton.disabled =
    state.loading ||
    state.savingLifecycle ||
    status !== 'review' ||
    !exceptionsReady

  elements.reopenPayrollButton.hidden =
    !state.canReopenPayroll || status !== 'finalized'
  elements.reopenPayrollButton.disabled =
    state.loading || state.savingLifecycle

  document.getElementById('payrollReviewer').textContent =
    lifecycle.reviewed_by_name || 'Not reviewed'
  document.getElementById('payrollReviewedAt').textContent =
    formatDateTime(lifecycle.reviewed_at)
  document.getElementById('payrollApprover').textContent =
    lifecycle.approved_by_name || 'Not approved'
  document.getElementById('payrollApprovedAt').textContent =
    formatDateTime(lifecycle.approved_at)
  document.getElementById('payrollFinalizationStatus').textContent =
    lifecycle.finalized_by_name
      ? `Finalized by ${lifecycle.finalized_by_name}`
      : 'Not finalized'
  document.getElementById('payrollFinalizedAt').textContent =
    formatDateTime(lifecycle.finalized_at)
  document.getElementById('payrollReopeningStatus').textContent =
    lifecycle.reopened_by_name
      ? `Reopened by ${lifecycle.reopened_by_name}`
      : 'No reopening recorded'
  document.getElementById('payrollReopenedAt').textContent =
    formatDateTime(lifecycle.reopened_at)

  elements.lifecycleStatus.className = 'payroll-import-status'
  if (status === 'finalized') {
    elements.lifecycleStatus.textContent =
      `Finalized payroll is locked · Version ${Number(lifecycle.finalization_version || 1)}. Later corrections require a future adjustment or controlled reopening.`
    elements.lifecycleStatus.classList.add('ready')
  } else if (status === 'review') {
    elements.lifecycleStatus.textContent =
      'Review evidence is recorded. An authorized approver can run the final checks and lock payroll.'
    elements.lifecycleStatus.classList.add('ready')
  } else if (status === 'reopened') {
    elements.lifecycleStatus.textContent =
      'This payroll was reopened under audit control. Recalculate every employee before submitting it for approval again.'
  } else if (readyForReview) {
    elements.lifecycleStatus.textContent =
      'All visible checks are clear. Submit payroll for approval to record the reviewer and full database evidence.'
    elements.lifecycleStatus.classList.add('ready')
  } else {
    elements.lifecycleStatus.textContent =
      'Complete the highlighted calculation and exception checks before review.'
  }
}

function employeeHasAttendanceIssue(employee) {
  return (
    Number(employee.incomplete_attendance_count || 0) > 0 ||
    Number(employee.missing_attendance_count || 0) > 0
  )
}

function missingAttendanceFor(employee) {
  return state.missingAttendance.get(employee.employee_user_id) || []
}

function teamAttendanceUrl(employeeId, workDate) {
  const params = new URLSearchParams({
    employee: employeeId,
    start: workDate,
    end: workDate,
    source: 'payroll-missing'
  })
  return `./team-attendance.html?${params}`
}

function agentRatesUrl(employeeId, workDate) {
  const params = new URLSearchParams()
  if (employeeId) params.set('employee', employeeId)
  if (workDate) params.set('effectiveDate', workDate)
  params.set('source', 'payroll-exception')
  return `./agent-rates.html?${params}`
}

function preplotTarget(scheduleId) {
  return scheduleId
    ? `#payroll-preplot-${scheduleId}`
    : '#payrollPreplotTitle'
}

function renderMetrics() {
  const employeeCount = state.employees.length
  const rateReadyCount =
    state.employees.filter(employee => employee.has_effective_rate).length
  const attendanceReadyCount =
    state.employees.filter(employee => !employeeHasAttendanceIssue(employee)).length
  const attentionCount =
    state.employees.filter(employee =>
      !employee.has_effective_rate || employeeHasAttendanceIssue(employee)
    ).length

  document.getElementById('payrollEmployeeCount').textContent = employeeCount
  document.getElementById('payrollRatesReadyCount').textContent = rateReadyCount
  document.getElementById('payrollAttendanceReadyCount').textContent =
    attendanceReadyCount
  document.getElementById('payrollAttentionCount').textContent = attentionCount
  document.getElementById('payrollReadinessCount').textContent =
    `${employeeCount} ${employeeCount === 1 ? 'employee' : 'employees'}`
}

function preplotStatusLabel(candidate) {
  const labels = {
    approved: 'Approved',
    attendance_exists: 'Attendance available',
    rest_day: 'Rest day',
    guaranteed_special_day: 'Guaranteed special day',
    unpublished: 'Not published',
    incomplete_shift: 'Incomplete shift',
    invalid_shift: 'Invalid shift',
    schedule_changed: 'Changed · reapprove',
    eligible: 'Eligible'
  }
  return labels[candidate.approval_status] || 'Review'
}

function renderPreplots() {
  if (state.sectionErrors.has('prepaid')) {
    elements.preplotBody.replaceChildren(errorRow('Prepaid schedules could not be loaded. Refresh to try again.', 8))
    return
  }
  const eligible = state.preplots.filter(candidate => candidate.can_approve)
  const approved = state.preplots.filter(
    candidate => candidate.approval_status === 'approved'
  )
  const prepaidBySchedule = new Map(
    state.prepaidBalances.map(balance => [balance.schedule_id, balance])
  )
  const remainingMinutes = state.prepaidBalances
    .filter(balance => balance.balance_status !== 'void')
    .reduce(
      (total, balance) => total + Number(balance.remaining_minutes || 0),
      0
    )
  const validIds = new Set(eligible.map(candidate => candidate.schedule_id))
  for (const scheduleId of state.selectedPreplots) {
    if (!validIds.has(scheduleId)) state.selectedPreplots.delete(scheduleId)
  }

  elements.preplotCount.textContent =
    `${state.preplots.length} ${state.preplots.length === 1 ? 'schedule' : 'schedules'}`
  elements.preplotEligibleCount.textContent = eligible.length
  elements.preplotSelectedCount.textContent = state.selectedPreplots.size
  elements.preplotApprovedCount.textContent = approved.length
  elements.preplotRemainingHours.textContent = formatHours(remainingMinutes)
  elements.preplotActions.hidden = !state.canApprovePreplots

  const periodCanApprove = ['draft', 'reopened'].includes(
    state.period?.period_status
  )
  elements.approvePreplotsButton.disabled =
    !state.canApprovePreplots ||
    !periodCanApprove ||
    state.approvingPreplots ||
    state.selectedPreplots.size === 0 ||
    !elements.preplotReason.value.trim()

  if (!state.preplots.length) {
    const row = document.createElement('tr')
    const cell = element(
      'td',
      'payroll-table-empty',
      Number(state.period?.early_payment_days || 0) > 0
        ? 'No schedules fall after the payment date in this payroll period.'
        : 'Payment is on the cutoff date, so this period has no pre-plot candidates.'
    )
    cell.colSpan = 7
    row.append(cell)
    elements.preplotBody.replaceChildren(row)
    elements.preplotStatus.className = 'payroll-import-status'
    elements.preplotStatus.textContent =
      'No future ordinary shifts require pre-plot approval.'
    return
  }

  const fragment = document.createDocumentFragment()
  for (const candidate of state.preplots) {
    const row = document.createElement('tr')
    row.id = `payroll-preplot-${candidate.schedule_id}`
    if (candidate.approval_status === 'approved') {
      row.classList.add('payroll-preplot-approved-row')
    }

    const selectCell = document.createElement('td')
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.className = 'payroll-preplot-checkbox'
    checkbox.dataset.scheduleId = candidate.schedule_id
    checkbox.disabled =
      !state.canApprovePreplots || !periodCanApprove || !candidate.can_approve
    checkbox.checked = state.selectedPreplots.has(candidate.schedule_id)
    checkbox.setAttribute(
      'aria-label',
      `Select ${candidate.employee_name || candidate.employee_email} on ${formatDate(candidate.work_date)}`
    )
    selectCell.append(checkbox)

    const employeeCell = element('td', 'payroll-employee-cell')
    employeeCell.append(
      element('strong', '', candidate.employee_name || candidate.employee_email),
      element(
        'small',
        '',
        [candidate.employee_number, candidate.employee_email]
          .filter(Boolean)
          .join(' · ')
      )
    )

    const shiftCell = document.createElement('td')
    shiftCell.append(
      element(
        'strong',
        'payroll-preplot-shift',
        `${formatShiftTime(candidate.shift_start, candidate.timezone)} – ${formatShiftTime(candidate.shift_end, candidate.timezone)}`
      ),
      element('small', 'payroll-cell-note', candidate.timezone)
    )

    const typeCell = document.createElement('td')
    typeCell.append(
      element(
        'span',
        `payroll-preplot-type ${candidate.special_day_type}`,
        String(candidate.special_day_type || 'ordinary').replaceAll('_', ' ')
      )
    )
    if (candidate.holiday_name) {
      typeCell.append(
        element('small', 'payroll-cell-note', candidate.holiday_name)
      )
    }

    const statusCell = document.createElement('td')
    const prepaidBalance = prepaidBySchedule.get(candidate.schedule_id)
    statusCell.append(
      element(
        'span',
        `payroll-preplot-status ${candidate.approval_status}`,
        preplotStatusLabel(candidate)
      ),
      element(
        'small',
        'payroll-cell-note',
        candidate.approval_message || ''
      )
    )
    if (candidate.approved_at) {
      statusCell.append(
        element(
          'small',
          'payroll-cell-note',
          `Approved by ${candidate.approved_by_name || 'payroll'}`
        )
      )
    }
    if (prepaidBalance) {
      const balanceNote = element(
        'small',
        'payroll-cell-note payroll-prepaid-balance-note'
      )
      balanceNote.append(
        document.createTextNode(
          `${formatHours(prepaidBalance.settled_minutes)}h rendered · ${formatHours(prepaidBalance.remaining_minutes)}h remaining`
        )
      )
      if (Number(prepaidBalance.remaining_minutes || 0) > 0) {
        balanceNote.append(document.createTextNode(' · '))
        const reviewLink = element(
          'a',
          'payroll-prepaid-review-link',
          'Review balance'
        )
        reviewLink.href = '#payrollExceptionReviewTitle'
        reviewLink.dataset.exceptionFilter = 'unresolved_prepaid_balance'
        reviewLink.title = 'Show this period’s unresolved prepaid balances'
        balanceNote.append(reviewLink)
      }
      statusCell.append(balanceNote)
    }

    row.append(
      selectCell,
      employeeCell,
      element('td', '', formatDate(candidate.work_date)),
      shiftCell,
      element('td', '', formatHours(candidate.scheduled_minutes)),
      typeCell,
      statusCell
    )
    fragment.append(row)
  }
  elements.preplotBody.replaceChildren(fragment)

  elements.preplotStatus.className = 'payroll-import-status'
  if (state.selectedPreplots.size) {
    elements.preplotStatus.textContent =
      `${state.selectedPreplots.size} ${state.selectedPreplots.size === 1 ? 'schedule is' : 'schedules are'} selected. Add one approval reason for this batch.`
    elements.preplotStatus.classList.add('warning')
  } else if (eligible.length) {
    elements.preplotStatus.textContent =
      `${eligible.length} eligible ${eligible.length === 1 ? 'schedule requires' : 'schedules require'} explicit approval before early payment.`
    elements.preplotStatus.classList.add('warning')
  } else {
    elements.preplotStatus.textContent =
      `All ${approved.length} eligible schedule ${approved.length === 1 ? 'version is' : 'versions are'} approved.`
    elements.preplotStatus.classList.add('ready')
  }
}

function addExceptionChip(fragment, count, label) {
  if (!count) return
  fragment.append(
    element('span', 'payroll-exception-chip', `${count} ${label}`)
  )
}

function renderExceptions() {
  if (state.sectionErrors.has('exceptions')) {
    elements.exceptionBody.replaceChildren(errorRow('Payroll exceptions could not be loaded. Refresh to try again.', 8))
    return
  }
  const blockingExceptions = state.exceptions.filter(issue => issue.is_blocking)
  const warningExceptions = state.exceptions.filter(issue => !issue.is_blocking)
  const hasExceptions = blockingExceptions.length > 0

  elements.exceptionSummary.className =
    `payroll-exception-summary ${hasExceptions ? 'warning' : 'clear'}`
  elements.exceptionTitle.textContent = hasExceptions
    ? `${blockingExceptions.length} blocking ${blockingExceptions.length === 1 ? 'exception needs' : 'exceptions need'} attention`
    : 'No blocking payroll exceptions detected'
  elements.exceptionText.textContent = hasExceptions
    ? 'Resolve every blocking issue before payroll calculation and finalization.'
    : warningExceptions.length
      ? `${warningExceptions.length} non-blocking carry-forward ${warningExceptions.length === 1 ? 'item remains' : 'items remain'} visible for follow-up.`
      : 'Rates, attendance, schedules, imports, and period dates passed the current checks.'

  const counts = new Map()
  for (const issue of blockingExceptions) {
    const current = counts.get(issue.exception_code) || {
      count: 0,
      label: issue.exception_label
    }
    current.count += 1
    counts.set(issue.exception_code, current)
  }
  const fragment = document.createDocumentFragment()
  for (const { count, label } of counts.values()) {
    addExceptionChip(fragment, count, label.toLowerCase())
  }
  elements.exceptionChips.replaceChildren(fragment)
}

function syncExceptionFilter() {
  const labels = new Map()
  for (const issue of state.exceptions) {
    labels.set(issue.exception_code, issue.exception_label)
  }

  const options = [new Option('All exceptions', 'all')]
  for (const [code, label] of [...labels.entries()].sort((left, right) =>
    left[1].localeCompare(right[1])
  )) {
    options.push(new Option(label, code))
  }
  elements.exceptionFilter.replaceChildren(...options)

  if (state.exceptionFilter !== 'all' && !labels.has(state.exceptionFilter)) {
    state.exceptionFilter = 'all'
  }
  elements.exceptionFilter.value = state.exceptionFilter
}

function exceptionAction(issue) {
  if (issue.exception_code === 'missing_rate') {
    if (!state.canManageRates) return null
    return {
      href: agentRatesUrl(issue.employee_user_id, issue.work_date),
      label: 'Open rates',
      title: 'Open this employee in effective-dated rate management'
    }
  }

  if (issue.exception_code === 'duplicate_hour_allocation') {
    if (
      state.canViewAttendance &&
      issue.employee_user_id &&
      issue.work_date
    ) {
      return {
        href: teamAttendanceUrl(issue.employee_user_id, issue.work_date),
        label: 'Open attendance',
        title: `Review the allocated attendance on ${formatDate(issue.work_date)}`
      }
    }
    return {
      href: preplotTarget(),
      label: 'Review pre-plot',
      title: 'Review prepaid balances for this payroll period'
    }
  }

  if (PREPLOT_EXCEPTION_CODES.has(issue.exception_code)) {
    return {
      href: preplotTarget(issue.schedule_id),
      label: issue.exception_code === 'unresolved_prepaid_balance'
        ? 'Review balance'
        : 'Review pre-plot',
      title: issue.schedule_id
        ? 'Open the related prepaid schedule'
        : 'Open prepaid schedule review'
    }
  }

  if (issue.exception_code === 'payroll_period_overlap') {
    return {
      href: './payroll-dashboard.html',
      label: 'Open periods',
      title: 'Review payroll period dates'
    }
  }

  if (
    ATTENDANCE_EXCEPTION_CODES.has(issue.exception_code) &&
    state.canViewAttendance &&
    issue.employee_user_id &&
    issue.work_date
  ) {
    return {
      href: teamAttendanceUrl(issue.employee_user_id, issue.work_date),
      label: 'Open attendance',
      title: `Open Team Attendance on ${formatDate(issue.work_date)}`
    }
  }

  return null
}

function renderExceptionReview() {
  if (state.sectionErrors.has('exceptions')) {
    elements.exceptionCount.textContent = 'Unavailable'
    elements.exceptionBody.replaceChildren(errorRow('Payroll exceptions could not be loaded. Refresh to try again.', 5))
    return
  }
  syncExceptionFilter()
  const visibleIssues = state.exceptionFilter === 'all'
    ? state.exceptions
    : state.exceptions.filter(
      issue => issue.exception_code === state.exceptionFilter
    )

  elements.exceptionCount.textContent =
    `${visibleIssues.length} ${visibleIssues.length === 1 ? 'issue' : 'issues'}`

  if (!visibleIssues.length) {
    const row = document.createElement('tr')
    const cell = element(
      'td',
      'payroll-table-empty',
      state.exceptions.length
        ? 'No exceptions match this filter.'
        : 'No payroll exceptions were detected for this period.'
    )
    cell.colSpan = 5
    row.append(cell)
    elements.exceptionBody.replaceChildren(row)
    return
  }

  const fragment = document.createDocumentFragment()
  for (const issue of visibleIssues) {
    const row = document.createElement('tr')

    const issueCell = document.createElement('td')
    issueCell.append(
      element('strong', 'payroll-exception-name', issue.exception_label),
      element(
        'span',
        `payroll-exception-severity ${issue.is_blocking ? 'blocking' : 'warning'}`,
        issue.is_blocking ? 'Blocking' : 'Warning'
      )
    )

    const employeeCell = element('td', 'payroll-employee-cell')
    employeeCell.append(
      element('strong', '', issue.employee_name || 'Payroll period')
    )
    if (issue.employee_number) {
      employeeCell.append(element('small', '', issue.employee_number))
    }

    const workDateCell = element('td', '', formatDate(issue.work_date))
    const detailCell = element('td', 'payroll-exception-detail', issue.message)
    const actionCell = document.createElement('td')
    const action = exceptionAction(issue)
    if (action) {
      const link = element(
        'a',
        'payroll-exception-action',
        action.label
      )
      link.href = action.href
      link.title = action.title
      actionCell.append(link)
    } else {
      actionCell.append(
        element(
          'span',
          'payroll-exception-action-unavailable',
          issue.employee_user_id ? 'Restricted' : '—'
        )
      )
    }

    row.append(
      issueCell,
      employeeCell,
      workDateCell,
      detailCell,
      actionCell
    )
    fragment.append(row)
  }

  elements.exceptionBody.replaceChildren(fragment)
}

function importStatusFor(employee) {
  return state.importStatuses.get(employee.employee_user_id) || {
    imported_attendance_count: 0,
    current_snapshot_count: 0,
    outdated_snapshot_count: 0,
    requires_recalculation: false,
    recalculation_reason: ''
  }
}

function renderImportStatus() {
  if (state.sectionErrors.has('readiness')) {
    elements.importStatus.className = 'payroll-import-status error'
    elements.importStatus.textContent = 'Attendance snapshot status could not be loaded. Refresh to try again.'
    return
  }
  const statuses = [...state.importStatuses.values()]
  const readyAttendanceCount = state.employees.reduce(
    (total, employee) =>
      total + Number(employee.payroll_ready_attendance_count || 0),
    0
  )
  const currentSnapshotCount = statuses.reduce(
    (total, status) => total + Number(status.current_snapshot_count || 0),
    0
  )
  const importedEmployeeCount = statuses.filter(
    status => Number(status.current_snapshot_count || 0) > 0
  ).length
  const recalculationFlagCount = statuses.filter(
    status => status.requires_recalculation
  ).length

  document.getElementById('payrollCurrentSnapshotCount').textContent =
    currentSnapshotCount
  document.getElementById('payrollImportedEmployeeCount').textContent =
    importedEmployeeCount
  document.getElementById('payrollRecalculationFlagCount').textContent =
    recalculationFlagCount

  elements.importStatus.className = 'payroll-import-status'
  if (recalculationFlagCount) {
    elements.importStatus.textContent =
      `${recalculationFlagCount} payroll ${recalculationFlagCount === 1 ? 'record requires' : 'records require'} recalculation because attendance changed after import.`
    elements.importStatus.classList.add('warning')
  } else if (!currentSnapshotCount) {
    elements.importStatus.textContent =
      'No attendance snapshots have been imported yet.'
  } else if (currentSnapshotCount < readyAttendanceCount) {
    elements.importStatus.textContent =
      `${currentSnapshotCount} of ${readyAttendanceCount} currently payroll-ready attendance entries are captured.`
    elements.importStatus.classList.add('warning')
  } else {
    elements.importStatus.textContent =
      `All ${currentSnapshotCount} currently payroll-ready attendance ${currentSnapshotCount === 1 ? 'entry is' : 'entries are'} preserved for this period.`
    elements.importStatus.classList.add('ready')
  }
}

function calculationLineSummary(calculation) {
  const parts = [
    `${formatHours(calculation.regular_minutes)}h regular`,
    `${formatHours(calculation.prepaid_minutes)}h prepaid`
  ]
  const optionalMinutes = [
    ['overtime', calculation.overtime_minutes],
    ['rest day', calculation.rest_day_minutes],
    ['holiday', calculation.holiday_minutes]
  ]
  for (const [label, minutes] of optionalMinutes) {
    if (Number(minutes || 0)) {
      parts.push(`${formatHours(minutes)}h ${label}`)
    }
  }
  return parts.join(' · ')
}

function calculationEarningsSummary(calculation) {
  const parts = []
  const basePay = approvedBilledMinutes(calculation) / 60 * calculationHourlyRate(calculation)
  const estimatedFinalPay = basePay + Number(calculation.other_earnings || 0) - Number(calculation.total_deductions || 0)
  parts.push(`Base Pay ${formatMoney(basePay)}`)
  parts.push(`Estimated Final Pay ${formatMoney(estimatedFinalPay)}`)
  const values = [
    ['Regular', calculation.basic_pay],
    ['Prepaid', calculation.prepaid_pay],
    ['Overtime', calculation.overtime_pay],
    ['Rest day', calculation.rest_day_pay],
    ['Holiday', calculation.holiday_pay],
    ['Other', calculation.other_earnings]
  ]
  for (const [label, amount] of values) {
    if (Number(amount || 0)) {
      parts.push(`${label} ${formatMoney(amount)}`)
    }
  }
  return parts.length ? parts.join(' · ') : '$0.00'
}

function calculationDetails(calculation) {
  const details = element('details', 'payroll-calculation-details')
  const lines = Array.isArray(calculation.line_items)
    ? calculation.line_items
    : []
  details.append(
    element(
      'summary',
      '',
      `${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`
    )
  )

  const list = element('div', 'payroll-calculation-lines')
  if (!lines.length) {
    list.append(element('span', '', 'No calculation lines.'))
  } else {
    for (const line of lines) {
      const row = element('div', 'payroll-calculation-line')
      const copy = element('span')
      copy.append(
        element('strong', '', line.description || line.item_code),
        element(
          'small',
          '',
          [
            line.work_date ? formatDate(line.work_date) : '',
            Number(line.quantity || 0)
              ? `${Number(line.quantity).toFixed(2)} × ${formatMoney(line.unit_rate)}`
              : line.informational_only
                ? 'Informational only'
                : ''
          ].filter(Boolean).join(' · ')
        )
      )
      row.append(copy, element('strong', '', formatMoney(line.amount)))
      list.append(row)
    }
  }
  details.append(list)
  return details
}

function renderCalculations() {
  if (state.sectionErrors.has('payroll')) {
    elements.calculationBody.replaceChildren(errorRow('Payroll calculations could not be loaded. Refresh to try again.', 8))
    return
  }
  const calculations = state.calculations
  const query = state.payrollEmployeeSearch.trim().toLowerCase()
  const visibleCalculations = query
    ? calculations.filter(calculation => [
      calculation.employee_name,
      calculation.employee_number,
      calculation.employee_email
    ].filter(Boolean).join(' ').toLowerCase().includes(query))
    : calculations
  const totals = calculations.reduce(
    (sum, calculation) => ({
      gross: sum.gross + Number(calculation.gross_pay || 0),
      deductions:
        sum.deductions + Number(calculation.total_deductions || 0),
      net: sum.net + Number(calculation.net_pay || 0)
    }),
    { gross: 0, deductions: 0, net: 0 }
  )

  elements.calculatedEmployeeCount.textContent = calculations.length
  elements.calculatedGross.textContent = formatMoney(totals.gross)
  elements.calculatedDeductions.textContent =
    formatMoney(totals.deductions)
  elements.calculatedNet.textContent = formatMoney(totals.net)
  elements.calculationSearchCount.textContent =
    `${visibleCalculations.length} of ${calculations.length} employee${calculations.length === 1 ? '' : 's'}`
  elements.calculationStatus.className = 'payroll-import-status'

  if (!calculations.length) {
    elements.calculationStatus.textContent =
      'Draft payroll has not been calculated.'
    const row = document.createElement('tr')
    const cell = element(
      'td',
      'payroll-table-empty',
      'Calculate the period to review employee totals.'
    )
    cell.colSpan = 7
    row.append(cell)
    elements.calculationBody.replaceChildren(row)
    return
  }

  const latestCalculation = calculations.reduce(
    (latest, calculation) =>
      String(calculation.calculated_at || '') >
      String(latest.calculated_at || '')
        ? calculation
        : latest,
    calculations[0]
  )
  const calculatedAt = latestCalculation.calculated_at
    ? new Intl.DateTimeFormat('en-PH', {
        dateStyle: 'medium',
        timeStyle: 'short'
      }).format(new Date(latestCalculation.calculated_at))
    : '—'
  elements.calculationStatus.textContent =
    `${calculations.length} employee ${calculations.length === 1 ? 'record is' : 'records are'} calculated in USD · Version ${Number(latestCalculation.calculation_version || 1)} · ${calculatedAt}.`
  elements.calculationStatus.classList.add('ready')

  const fragment = document.createDocumentFragment()
  if (!visibleCalculations.length) {
    fragment.append(errorRow('No employees match this search.', 8))
    elements.calculationBody.replaceChildren(fragment)
    return
  }
  for (const calculation of visibleCalculations) {
    const row = document.createElement('tr')
    const employeeCell = element('td', 'payroll-employee-cell')
    employeeCell.append(
      element(
        'strong',
        '',
        calculation.employee_name || calculation.employee_email
      ),
      element(
        'small',
        '',
        [calculation.employee_number, calculation.employee_email]
          .filter(Boolean)
          .join(' · ')
      )
    )

    const billedMinutes = approvedBilledMinutes(calculation)
    const prepaidMinutes = Number(calculation.prepaid_minutes || 0)
    const consumedMinutes = Number(calculation.applied_prepaid_minutes || 0)
    const regularPayableMinutes = Math.max(0, billedMinutes - consumedMinutes)
    const newPrepaidMinutes = Math.max(0, prepaidMinutes - consumedMinutes)
    const totalBilledMinutes = regularPayableMinutes + newPrepaidMinutes
    const rateCell = document.createElement('td')
    const rateInput = document.createElement('input')
    rateInput.className = 'payroll-control payroll-rate-override'
    rateInput.type = 'number'
    rateInput.min = '0'
    rateInput.step = '0.01'
    rateInput.value = calculationHourlyRate(calculation).toFixed(2)
    rateInput.disabled = state.period?.period_status === 'finalized' || !state.canCalculatePayroll
    rateInput.title = 'Draft hourly-rate override'
    rateInput.addEventListener('change', () => {
      const value = Number(rateInput.value)
      if (!Number.isFinite(value) || value < 0) return
      state.rateOverrides.set(calculation.payroll_record_id, value)
      renderCalculations()
    })
    rateCell.append(element('span', '', 'Hourly rate'), rateInput)

    const hoursCell = element(
      'td',
      'payroll-calculation-time',
      `Total billed ${formatHours(totalBilledMinutes)}h · Approved worked ${formatHours(billedMinutes)}h · Prepaid consumed ${formatHours(consumedMinutes)}h · New regular ${formatHours(regularPayableMinutes)}h · New prepaid ${formatHours(newPrepaidMinutes)}h · Remaining prepaid ${formatHours(newPrepaidMinutes)}h`
    )

    row.append(
      employeeCell,
      hoursCell,
      rateCell,
      element(
        'td',
        'payroll-calculation-earnings',
        calculationEarningsSummary(calculation)
      ),
      element('td', 'payroll-money', formatMoney(calculation.gross_pay)),
      element(
        'td',
        'payroll-money',
        formatMoney(calculation.total_deductions)
      ),
      element(
        'td',
        'payroll-money payroll-net-pay',
        formatMoney(calculation.net_pay)
      )
    )
    const detailCell = document.createElement('td')
    if (
      state.canCalculatePayroll &&
      ['draft', 'reopened'].includes(state.period?.period_status) &&
      !['finalized', 'void'].includes(calculation.record_status)
    ) {
      const recalculateButton = element(
        'button',
        'payroll-button payroll-button-secondary payroll-row-action',
        'Recalculate'
      )
      recalculateButton.type = 'button'
      recalculateButton.dataset.payrollRecordId = calculation.payroll_record_id
      recalculateButton.dataset.payrollAction = 'recalculate'
      recalculateButton.title = 'Recalculate this employee only'
      detailCell.append(recalculateButton)
    }
    if (
      state.canImportAttendance &&
      state.canCalculatePayroll &&
      ['draft', 'reopened'].includes(state.period?.period_status) &&
      !['finalized', 'void'].includes(calculation.record_status)
    ) {
      const refreshButton = element(
        'button',
        'payroll-button payroll-button-secondary payroll-row-action',
        'Refresh attendance & recalculate'
      )
      refreshButton.type = 'button'
      refreshButton.dataset.payrollRecordId = calculation.payroll_record_id
      refreshButton.dataset.payrollAction = 'refresh-employee'
      refreshButton.title = 'Refresh attendance and recalculate this employee only'
      detailCell.append(refreshButton)
    }
    detailCell.append(calculationDetails(calculation))
    if (state.period?.period_status === 'finalized') {
      const previewLink = element(
        'a',
        'payroll-payslip-preview-link',
        'Preview payslip'
      )
      previewLink.href =
        `./payslip-preview.html?record=${encodeURIComponent(calculation.payroll_record_id)}`
      detailCell.append(previewLink)
    }
    row.append(detailCell)
    fragment.append(row)
  }
  elements.calculationBody.replaceChildren(fragment)
}

function errorRow(message, colspan = 1) {
  const row = document.createElement('tr')
  const cell = element('td', 'payroll-table-empty error', message)
  cell.colSpan = colspan
  row.append(cell)
  return row
}

async function recalculateEmployeeDraft(payrollRecordId) {
  if (
    !payrollRecordId ||
    !state.canCalculatePayroll ||
    !['draft', 'reopened'].includes(state.period?.period_status)
  ) return

  const calculation = state.calculations.find(
    row => row.payroll_record_id === payrollRecordId
  )
  const employeeName = calculation?.employee_name || 'this employee'
  if (!window.confirm(`Recalculate ${employeeName}'s Draft payroll only?`)) {
    return
  }

  setMessage(`Recalculating ${employeeName} from approved snapshots…`)
  const { error } = await supabase.rpc('payroll_calculate_employee_draft', {
    p_payroll_record_id: payrollRecordId
  })
  if (error) {
    setMessage(
      error.message || 'Employee Draft payroll could not be recalculated.',
      'error'
    )
    return
  }
  await loadPeriod()
  setMessage(`${employeeName}'s Draft payroll was recalculated.`, 'success')
}

async function refreshEmployeeAttendanceAndRecalculate(payrollRecordId) {
  if (
    !payrollRecordId ||
    state.refreshingEmployee ||
    !state.canImportAttendance ||
    !state.canCalculatePayroll ||
    !['draft', 'reopened'].includes(state.period?.period_status)
  ) return

  const calculation = state.calculations.find(
    row => row.payroll_record_id === payrollRecordId
  )
  if (!calculation || ['finalized', 'void'].includes(calculation.record_status)) {
    return
  }

  const employeeName = calculation.employee_name || 'this employee'
  if (!window.confirm(
    `Refresh attendance and recalculate ${employeeName}'s payroll only?\n\n` +
    'Only this employee will be refreshed. Historical snapshots remain preserved, ' +
    'derived payroll items may be recalculated, and payroll will not be approved or finalized.'
  )) {
    return
  }

  state.refreshingEmployee = true
  elements.refresh.disabled = true
  renderPeriod()
  setMessage(`Refreshing attendance for ${employeeName}…`)

  const { error: importError } = await supabase.rpc(
    'payroll_import_employee_attendance',
    { p_payroll_record_id: payrollRecordId }
  )
  if (importError) {
    state.refreshingEmployee = false
    elements.refresh.disabled = false
    renderPeriod()
    setMessage(
      importError.message || 'Employee attendance could not be refreshed.',
      'error'
    )
    return
  }

  const { error: calculationError } = await supabase.rpc(
    'payroll_calculate_employee_draft',
    { p_payroll_record_id: payrollRecordId }
  )
  state.refreshingEmployee = false
  elements.refresh.disabled = false

  if (calculationError) {
    renderPeriod()
    setMessage(
      calculationError.message || 'Employee Draft payroll could not be recalculated.',
      'error'
    )
    return
  }

  await loadPeriod()
  setMessage(
    `${employeeName}'s attendance was refreshed and Draft payroll recalculated.`,
    'success'
  )
}

function renderAdjustments() {
  if (state.sectionErrors.has('adjustments')) {
    elements.adjustmentBody.replaceChildren(errorRow('Payroll adjustments could not be loaded. Refresh to try again.', 7))
    return
  }
  const adjustments = state.adjustments
  elements.adjustmentCount.textContent =
    `${adjustments.length} ${adjustments.length === 1 ? 'adjustment' : 'adjustments'}`

  if (!adjustments.length) {
    const row = document.createElement('tr')
    const cell = element(
      'td',
      'payroll-table-empty',
      state.calculations.length
        ? 'No manual adjustments have been added.'
        : 'Calculate draft payroll before adding adjustments.'
    )
    cell.colSpan = 7
    row.append(cell)
    elements.adjustmentBody.replaceChildren(row)
    return
  }

  const editable = ['draft', 'reopened'].includes(
    state.period?.period_status
  )
  const fragment = document.createDocumentFragment()
  for (const adjustment of adjustments) {
    const row = document.createElement('tr')
    const employeeCell = element('td', 'payroll-employee-cell')
    employeeCell.append(
      element(
        'strong',
        '',
        adjustment.employee_name || adjustment.employee_email
      ),
      element(
        'small',
        '',
        [adjustment.employee_number, adjustment.employee_email]
          .filter(Boolean)
          .join(' · ')
      )
    )

    const changedCell = document.createElement('td')
    changedCell.append(
      element(
        'span',
        '',
        adjustment.last_changed_at
          ? new Intl.DateTimeFormat('en-PH', {
              dateStyle: 'medium',
              timeStyle: 'short'
            }).format(new Date(adjustment.last_changed_at))
          : '—'
      ),
      element(
        'small',
        'payroll-cell-note',
        [
          adjustment.last_changed_by_name ||
            adjustment.created_by_name,
          `Version ${Number(adjustment.adjustment_version || 1)}`
        ].filter(Boolean).join(' · ')
      )
    )

    const actionCell = element('td', 'payroll-adjustment-actions')
    if (state.canCalculatePayroll && editable) {
      const editButton = element(
        'button',
        'payroll-adjustment-action',
        'Edit'
      )
      editButton.type = 'button'
      editButton.dataset.adjustmentAction = 'edit'
      editButton.dataset.adjustmentId = adjustment.payroll_item_id

      const removeButton = element(
        'button',
        'payroll-adjustment-action remove',
        'Remove'
      )
      removeButton.type = 'button'
      removeButton.dataset.adjustmentAction = 'remove'
      removeButton.dataset.adjustmentId = adjustment.payroll_item_id
      actionCell.append(editButton, removeButton)
    } else {
      actionCell.append(
        element('span', 'payroll-exception-action-unavailable', 'Read only')
      )
    }

    row.append(
      employeeCell,
      element(
        'td',
        `payroll-adjustment-type ${adjustment.item_type}`,
        adjustment.item_type === 'earning'
          ? 'Manual earning'
          : 'Manual deduction'
      ),
      element('td', '', adjustment.description),
      element(
        'td',
        `payroll-money ${adjustment.item_type === 'deduction' ? 'payroll-deduction' : ''}`,
        formatMoney(adjustment.amount)
      ),
      element('td', '', adjustment.adjustment_reason),
      changedCell,
      actionCell
    )
    fragment.append(row)
  }
  elements.adjustmentBody.replaceChildren(fragment)
}

function rateStatus(employee) {
  const wrap = element('div')
  wrap.append(
    element(
      'span',
      `payroll-data-status ${employee.has_effective_rate ? 'ready' : 'missing'}`,
      employee.has_effective_rate ? 'Available' : 'Missing'
    )
  )
  if (!employee.has_effective_rate) {
    wrap.append(
      element(
        'small',
        'payroll-cell-note',
        `${Number(employee.missing_rate_date_count || 0)} uncovered date${Number(employee.missing_rate_date_count || 0) === 1 ? '' : 's'}`
      )
    )
  }
  return wrap
}

function attendanceStatus(employee) {
  const issueCount =
    Number(employee.incomplete_attendance_count || 0) +
    Number(employee.missing_attendance_count || 0)
  const wrap = element('div')
  const missingEntries = missingAttendanceFor(employee)
  const statusTag =
    issueCount && state.canViewAttendance && missingEntries.length ? 'a' : 'span'
  const status = element(
    statusTag,
    `payroll-data-status ${issueCount ? 'warning' : 'ready'}${statusTag === 'a' ? ' payroll-data-status-link' : ''}`,
    issueCount ? 'Incomplete' : 'Complete'
  )
  if (statusTag === 'a') {
    status.href = teamAttendanceUrl(
      employee.employee_user_id,
      missingEntries[0].work_date
    )
    status.title = 'Open the missing attendance date in Team Attendance'
    status.setAttribute(
      'aria-label',
      `Open missing attendance for ${employee.employee_name || employee.employee_email} on ${formatDate(missingEntries[0].work_date)}`
    )
  }
  wrap.append(status)

  const notes = []
  if (employee.missing_clock_out_count) {
    notes.push(`${employee.missing_clock_out_count} missing clock-out`)
  }
  if (employee.pending_review_count) {
    notes.push(`${employee.pending_review_count} awaiting review`)
  }
  if (notes.length) {
    wrap.append(element('small', 'payroll-cell-note', notes.join(' · ')))
  }
  if (employee.missing_attendance_count) {
    const missingCount = Number(employee.missing_attendance_count)
    const note = element('small', 'payroll-cell-note')
    note.append(
      document.createTextNode(
        `${missingCount} missing ${missingCount === 1 ? 'entry' : 'entries'}`
      )
    )

    if (state.canViewAttendance && missingEntries.length) {
      note.append(document.createTextNode(' · '))
      missingEntries.forEach((entry, index) => {
        if (index) note.append(document.createTextNode(', '))
        const link = element(
          'a',
          'payroll-missing-date-link',
          formatDate(entry.work_date)
        )
        link.href = teamAttendanceUrl(
          employee.employee_user_id,
          entry.work_date
        )
        link.title = 'Open this missing attendance date'
        note.append(link)
      })
    }
    wrap.append(note)
  }
  return wrap
}

function renderEmployees() {
  if (state.sectionErrors.has('readiness')) {
    elements.body.replaceChildren(errorRow('Employee readiness could not be loaded. Refresh to try again.', 6))
    return
  }
  if (!state.employees.length) {
    const row = document.createElement('tr')
    const cell = element(
      'td',
      'payroll-table-empty',
      'No eligible employees were loaded into this payroll period.'
    )
    cell.colSpan = 6
    row.append(cell)
    elements.body.replaceChildren(row)
    return
  }

  const fragment = document.createDocumentFragment()

  for (const employee of state.employees) {
    const row = document.createElement('tr')
    const employeeCell = element('td', 'payroll-employee-cell')
    employeeCell.append(
      element('strong', '', employee.employee_name || employee.employee_email),
      element(
        'small',
        '',
        [employee.employee_number, employee.employee_email]
          .filter(Boolean)
          .join(' · ')
      )
    )

    const rateCell = document.createElement('td')
    rateCell.append(rateStatus(employee))

    const attendanceCell = document.createElement('td')
    attendanceCell.append(attendanceStatus(employee))

    const scheduleCell = element(
      'td',
      '',
      String(Number(employee.scheduled_shift_count || 0))
    )
    const readyAttendanceCell = element(
      'td',
      '',
      `${Number(employee.payroll_ready_attendance_count || 0)} / ${Number(employee.attendance_record_count || 0)}`
    )
    const employeeImportStatus = importStatusFor(employee)
    readyAttendanceCell.append(
      element(
        'small',
        'payroll-cell-note',
        `${Number(employeeImportStatus.current_snapshot_count || 0)} imported`
      )
    )
    const statusCell = document.createElement('td')
    const ready = employee.readiness_status === 'ready'
    const requiresRecalculation = employeeImportStatus.requires_recalculation
    statusCell.append(element(
      'span',
      `payroll-readiness-badge ${ready && !requiresRecalculation ? 'ready' : 'attention'}`,
      requiresRecalculation
        ? 'Recalculation required'
        : ready
          ? 'Ready'
          : 'Attention required'
    ))
    if (requiresRecalculation && employeeImportStatus.recalculation_reason) {
      statusCell.append(
        element(
          'small',
          'payroll-cell-note',
          employeeImportStatus.recalculation_reason
        )
      )
    }
    const exceptionCount = state.exceptions.filter(
      issue =>
        issue.is_blocking &&
        issue.employee_user_id === employee.employee_user_id
    ).length
    if (exceptionCount) {
      statusCell.append(
        element(
          'small',
          'payroll-cell-note payroll-cell-note-alert',
          `${exceptionCount} blocking ${exceptionCount === 1 ? 'exception' : 'exceptions'}`
        )
      )
    }

    row.append(
      employeeCell,
      rateCell,
      attendanceCell,
      scheduleCell,
      readyAttendanceCell,
      statusCell
    )
    fragment.append(row)
  }

  elements.body.replaceChildren(fragment)
}

function renderPrepaidEntryControls() {
  const selectedEmployee = elements.prepaidEmployee.value
  const options = [new Option('Select an employee', '')]
  const employees = [...state.employees].sort((left, right) =>
    String(left.employee_name || left.employee_email || '').localeCompare(
      String(right.employee_name || right.employee_email || '')
    )
  )
  for (const employee of employees) {
    const label = [
      employee.employee_name || employee.employee_email,
      employee.employee_number
    ].filter(Boolean).join(' · ')
    options.push(new Option(label, employee.employee_user_id))
  }
  elements.prepaidEmployee.replaceChildren(...options)
  if (
    selectedEmployee &&
    employees.some(employee => employee.employee_user_id === selectedEmployee)
  ) {
    elements.prepaidEmployee.value = selectedEmployee
  }

  if (state.period) {
    elements.prepaidDate.min = addCalendarDays(
      state.period.payment_date,
      1
    )
    elements.prepaidDate.max = state.period.period_end
  }
  updatePrepaidFormState()
}

function renderAll() {
  renderPeriod()
  renderMetrics()
  renderPreplots()
  renderPrepaidEntryControls()
  renderExceptions()
  renderExceptionReview()
  renderImportStatus()
  renderCalculations()
  renderAdjustments()
  renderLifecycle()
  renderEmployees()
  renderStepStates()
  setPayrollStep(state.activeStep)
}

const PAYROLL_STEPS = ['readiness', 'prepaid', 'exceptions', 'payroll', 'adjustments', 'review']

function setPayrollStep(step, options = {}) {
  if (!PAYROLL_STEPS.includes(step)) return
  state.activeStep = step
  document.querySelectorAll('[data-payroll-step]').forEach(button => {
    const active = button.dataset.payrollStep === step
    button.classList.toggle('active', active)
    button.setAttribute('aria-selected', String(active))
  })
  document.querySelectorAll('[data-payroll-step-panel]').forEach(panel => {
    panel.hidden = panel.dataset.payrollStepPanel !== step
  })
  if (options.focus) {
    document.querySelector(`[data-payroll-step-panel="${step}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

function organizePayrollStepPanels() {
  const panel = step => document.querySelector(`[data-payroll-step-panel="${step}"]`)
  const move = (selector, step) => {
    const node = document.querySelector(selector)
    if (node) panel(step)?.append(node)
  }
  move('.payroll-import-card', 'readiness')
  move('.payroll-readiness-card', 'readiness')
  move('.payroll-preplot-card', 'prepaid')
  move('#payrollExceptionSummary', 'exceptions')
  move('.payroll-exception-review-card', 'exceptions')
  move('.payroll-calculation-card', 'payroll')
  const adjustmentCard = document.querySelector('.payroll-adjustments-step-card')
  const oldAdjustmentHeading = document.querySelector('.payroll-adjustment-heading')
  const oldAdjustmentTable = document.querySelector('.payroll-adjustment-table')?.closest('.payroll-table-wrap')
  if (adjustmentCard && oldAdjustmentHeading && oldAdjustmentTable) {
    adjustmentCard.replaceChildren(oldAdjustmentHeading, oldAdjustmentTable)
    oldAdjustmentHeading.append(elements.addAdjustmentButton)
  }
  move('.payroll-lifecycle-card', 'review')
}

function renderStepStates() {
  if (!state.loadSucceeded) {
    const statuses = {
      readiness: { label: '!', className: 'warning' },
      prepaid: { label: '!', className: 'warning' },
      exceptions: { label: '!', className: 'warning' },
      payroll: { label: '!', className: 'warning' },
      adjustments: { label: '—', className: '' },
      review: { label: '—', className: '' }
    }
    Object.entries(statuses).forEach(([step, status]) => {
      const button = document.querySelector(`[data-payroll-step="${step}"]`)
      const badge = document.querySelector(`[data-step-badge="${step}"]`)
      button?.classList.remove('complete', 'warning', 'blocked')
      if (status.className) button?.classList.add(status.className)
      if (badge) badge.textContent = status.label
    })
    return
  }
  const blocking = state.exceptions.filter(issue => issue.is_blocking).length
  const attention = state.employees.filter(employee => Number(employee.missing_attendance_count || 0) + Number(employee.incomplete_attendance_count || 0) > 0).length
  const eligiblePreplots = state.preplots.filter(item => item.approval_status === 'eligible').length
  const recalculation = state.calculations.filter(item => item.requires_recalculation).length
  const statuses = {
    readiness: attention ? { label: String(attention), className: 'warning' } : { label: '✓', className: 'complete' },
    prepaid: eligiblePreplots ? { label: String(eligiblePreplots), className: 'warning' } : { label: '✓', className: 'complete' },
    exceptions: blocking ? { label: String(blocking), className: 'blocked' } : { label: '✓', className: 'complete' },
    payroll: !state.loadSucceeded
      ? { label: '!', className: 'warning' }
      : recalculation
        ? { label: String(recalculation), className: 'warning' }
        : state.calculations.length
          ? { label: '✓', className: 'complete' }
          : { label: '—', className: '' },
    adjustments: { label: elements.adjustmentCount?.textContent || '0', className: '' },
    review: { label: state.period?.period_status || 'Draft', className: '' }
  }
  Object.entries(statuses).forEach(([step, status]) => {
    const button = document.querySelector(`[data-payroll-step="${step}"]`)
    const badge = document.querySelector(`[data-step-badge="${step}"]`)
    button?.classList.remove('complete', 'warning', 'blocked')
    if (status.className) button?.classList.add(status.className)
    if (badge) badge.textContent = status.label
  })
}

function clearUnresolvedLoadingStates() {
  const placeholders = [
    ['payrollReadinessBody', 'Employee readiness could not be loaded. Refresh to try again.', 6],
    ['payrollPreplotBody', 'Prepaid schedules could not be loaded. Refresh to try again.', 8],
    ['payrollExceptionBody', 'Payroll exceptions could not be loaded. Refresh to try again.', 5],
    ['payrollCalculationBody', 'Payroll calculations could not be loaded. Refresh to try again.', 8],
    ['payrollAdjustmentBody', 'Payroll adjustments could not be loaded. Refresh to try again.', 7]
  ]
  for (const [id, message, colspan] of placeholders) {
    const body = document.getElementById(id)
    if (!body || !body.textContent.includes('Loading')) continue
    body.replaceChildren(errorRow(message, colspan))
  }
}

async function safePayrollRpc(name, rpcName, params) {
  try {
    const result = params === undefined
      ? await supabase.rpc(rpcName)
      : await supabase.rpc(rpcName, params)
    return {
      name,
      ok: !result.error,
      data: result.data ?? null,
      error: result.error ?? null
    }
  } catch (error) {
    return { name, ok: false, data: null, error }
  }
}

async function loadPeriodUnsafe() {
  if (state.loading) return
  state.loading = true
  state.loadSucceeded = false
  state.loadError = null
  renderPeriod()
  renderStepStates()
  elements.refresh.disabled = true
  elements.importButton.disabled = true
  setMessage('Checking rates and attendance readiness…')

  const [
    dashboardResult,
    readinessResult,
    missingAttendanceResult,
    importStatusResult,
    exceptionsResult,
    preplotsResult,
    prepaidBalancesResult,
    calculationResult,
    adjustmentsResult,
    lifecycleResult
  ] =
    await Promise.all([
      safePayrollRpc('dashboard', 'payroll_get_period_dashboard'),
      safePayrollRpc('readiness', 'payroll_get_period_employee_readiness', {
        p_payroll_period_id: state.periodId
      }),
      safePayrollRpc('missingAttendance', 'payroll_get_period_missing_attendance', {
        p_payroll_period_id: state.periodId
      }),
      safePayrollRpc('importStatus', 'payroll_get_period_attendance_import_status', {
        p_payroll_period_id: state.periodId
      }),
      safePayrollRpc('exceptions', 'payroll_get_period_exceptions', {
        p_payroll_period_id: state.periodId
      }),
      safePayrollRpc('preplots', 'payroll_get_preplot_candidates', {
        p_payroll_period_id: state.periodId
      }),
      safePayrollRpc('prepaidBalances', 'payroll_get_period_prepaid_hours', {
        p_payroll_period_id: state.periodId
      }),
      safePayrollRpc('calculation', 'payroll_get_period_calculation', {
        p_payroll_period_id: state.periodId
      }),
      safePayrollRpc('adjustments', 'payroll_get_period_adjustments', {
        p_payroll_period_id: state.periodId
      }),
      safePayrollRpc('lifecycle', 'payroll_get_period_lifecycle', {
        p_payroll_period_id: state.periodId
      })
    ])

  state.loading = false
  elements.refresh.disabled = false

  const rpcResults = [
    ['payroll_get_period_dashboard', dashboardResult],
    ['payroll_get_period_employee_readiness', readinessResult],
    ['payroll_get_period_missing_attendance', missingAttendanceResult],
    ['payroll_get_period_attendance_import_status', importStatusResult],
    ['payroll_get_period_exceptions', exceptionsResult],
    ['payroll_get_preplot_candidates', preplotsResult],
    ['payroll_get_period_prepaid_hours', prepaidBalancesResult],
    ['payroll_get_period_calculation', calculationResult],
    ['payroll_get_period_adjustments', adjustmentsResult],
    ['payroll_get_period_lifecycle', lifecycleResult]
  ]
  const failedRpcs = rpcResults.filter(([, result]) => result.error)
  state.sectionErrors = new Map()
  for (const [rpcName, result] of failedRpcs) {
    const section = rpcName.includes('exceptions')
      ? 'exceptions'
      : rpcName.includes('calculation')
        ? 'payroll'
        : rpcName.includes('adjustment')
          ? 'adjustments'
          : rpcName.includes('preplot') || rpcName.includes('prepaid')
            ? 'prepaid'
            : 'readiness'
    state.sectionErrors.set(section, { rpcName, error: result.error })
    console.error(`Payroll Period load RPC failed: ${rpcName}`, result.error)
  }
  state.loadSucceeded = failedRpcs.length === 0
  state.loadError = failedRpcs.length
    ? failedRpcs.map(([rpcName, result]) => ({ rpcName, error: result.error }))
    : null

  if (!dashboardResult.error) {
    state.period = (dashboardResult.data || []).find(
      period => period.payroll_period_id === state.periodId
    ) || null
  }

  if (!state.period) {
    setMessage('Payroll period was not found.', 'error')
    return
  }

  if (!readinessResult.error) state.employees = readinessResult.data || []
  if (!preplotsResult.error) state.preplots = preplotsResult.data || []
  if (!prepaidBalancesResult.error) state.prepaidBalances = prepaidBalancesResult.data || []
  if (!exceptionsResult.error) state.exceptions = exceptionsResult.data || []
  if (!calculationResult.error) state.calculations = calculationResult.data || []
  if (!adjustmentsResult.error) state.adjustments = adjustmentsResult.data || []
  if (!lifecycleResult.error) state.lifecycle = lifecycleResult.data?.[0] || null
  state.loadSucceeded = true
  state.loadError = null
  state.missingAttendance = new Map()
  for (const entry of missingAttendanceResult.error ? [] : missingAttendanceResult.data || []) {
    const rows = state.missingAttendance.get(entry.employee_user_id) || []
    rows.push(entry)
    state.missingAttendance.set(entry.employee_user_id, rows)
  }
  state.importStatuses = new Map(
    (importStatusResult.error ? [] : importStatusResult.data || []).map(status => [
      status.employee_user_id,
      status
    ])
  )
  renderAll()
  if (failedRpcs.length) {
    setMessage(
      `Payroll Period refresh incomplete. ${failedRpcs.map(([, result]) => result.error.message || 'A section failed').join(' ')}`,
      'error'
    )
  } else {
    setMessage('')
  }
}

async function loadPeriod() {
  try {
    await loadPeriodUnsafe()
  } catch (error) {
    state.loadSucceeded = false
    state.loadError = { error }
    console.error('[Payroll] loadPeriod failed', error)
    clearUnresolvedLoadingStates()
    setMessage(
      `Payroll Period could not load: ${error.message || 'Unexpected loading error'}. Refresh and try again.`,
      'error'
    )
  } finally {
    state.loading = false
    if (elements.refresh) elements.refresh.disabled = false
    if (elements.importButton) elements.importButton.disabled = false
    clearUnresolvedLoadingStates()
  }
}

function setAdjustmentMessage(message = '', type = '') {
  elements.adjustmentMessage.textContent = message
  elements.adjustmentMessage.classList.toggle('error', type === 'error')
  elements.adjustmentMessage.classList.toggle(
    'success',
    type === 'success'
  )
}

function closeAdjustmentDialog() {
  if (state.savingAdjustment) return
  if (typeof elements.adjustmentDialog.close === 'function') {
    elements.adjustmentDialog.close()
  } else {
    elements.adjustmentDialog.removeAttribute('open')
  }
  state.selectedAdjustment = null
  state.adjustmentMode = 'add'
}

function openAdjustmentDialog(mode = 'add', adjustment = null) {
  if (
    !state.canCalculatePayroll ||
    !['draft', 'reopened'].includes(state.period?.period_status) ||
    !state.calculations.length
  ) {
    return
  }

  state.adjustmentMode = mode
  state.selectedAdjustment = adjustment
  elements.adjustmentForm.reset()
  setAdjustmentMessage('')

  const options = [
    new Option('Select an employee', '')
  ]
  for (const calculation of state.calculations) {
    options.push(new Option(
      [
        calculation.employee_name || calculation.employee_email,
        calculation.employee_number
      ].filter(Boolean).join(' · '),
      calculation.payroll_record_id
    ))
  }
  elements.adjustmentEmployee.replaceChildren(...options)

  if (adjustment) {
    elements.adjustmentEmployee.value = adjustment.payroll_record_id
    elements.adjustmentType.value = adjustment.item_type
    elements.adjustmentAmount.value =
      Number(adjustment.amount || 0).toFixed(2)
    elements.adjustmentDescription.value = adjustment.description || ''
    elements.adjustmentNotes.value =
      adjustment.private_correction_notes || ''
  } else {
    elements.adjustmentType.value = 'earning'
  }

  const removing = mode === 'remove'
  const editing = mode === 'edit'
  elements.adjustmentEmployee.disabled = editing || removing
  elements.adjustmentType.disabled = removing
  elements.adjustmentAmount.disabled = removing
  elements.adjustmentDescription.disabled = removing
  elements.adjustmentReason.value = editing
    ? adjustment.adjustment_reason || ''
    : ''
  elements.adjustmentReasonLabel.textContent = removing
    ? 'Removal reason'
    : 'Adjustment reason'
  elements.adjustmentReason.placeholder = removing
    ? 'Required reason for removing this adjustment'
    : 'Required reason for this payroll change'
  elements.adjustmentDialogTitle.textContent = removing
    ? 'Remove manual adjustment'
    : editing
      ? 'Edit manual adjustment'
      : 'Add manual adjustment'
  elements.adjustmentDialogText.textContent = removing
    ? 'The adjustment will be removed from payroll totals, while its complete history remains in the private audit log.'
    : 'The description will appear on the employee’s payroll record.'
  elements.saveAdjustmentButton.textContent = removing
    ? 'Remove adjustment'
    : editing
      ? 'Save changes'
      : 'Save adjustment'
  elements.saveAdjustmentButton.classList.toggle('danger', removing)
  elements.saveAdjustmentButton.disabled = false

  if (typeof elements.adjustmentDialog.showModal === 'function') {
    elements.adjustmentDialog.showModal()
  } else {
    elements.adjustmentDialog.setAttribute('open', '')
  }
}

async function savePayrollAdjustment(event) {
  event.preventDefault()
  if (
    state.savingAdjustment ||
    !state.canCalculatePayroll ||
    !['draft', 'reopened'].includes(state.period?.period_status)
  ) {
    return
  }

  if (!elements.adjustmentForm.reportValidity()) return

  state.savingAdjustment = true
  elements.saveAdjustmentButton.disabled = true
  elements.cancelAdjustmentButton.disabled = true
  elements.closeAdjustmentButton.disabled = true
  setAdjustmentMessage(
    state.adjustmentMode === 'remove'
      ? 'Removing adjustment and rebuilding payroll totals…'
      : 'Saving adjustment and rebuilding payroll totals…'
  )

  let result
  if (state.adjustmentMode === 'remove') {
    result = await supabase.rpc('payroll_remove_adjustment', {
      p_payroll_item_id: state.selectedAdjustment.payroll_item_id,
      p_removal_reason: elements.adjustmentReason.value.trim(),
      p_correction_notes: elements.adjustmentNotes.value.trim() || null
    })
  } else {
    result = await supabase.rpc('payroll_save_adjustment', {
      p_payroll_record_id: elements.adjustmentEmployee.value,
      p_payroll_item_id:
        state.selectedAdjustment?.payroll_item_id || null,
      p_item_type: elements.adjustmentType.value,
      p_description: elements.adjustmentDescription.value.trim(),
      p_amount: Number(elements.adjustmentAmount.value),
      p_adjustment_reason: elements.adjustmentReason.value.trim(),
      p_correction_notes: elements.adjustmentNotes.value.trim() || null
    })
  }

  state.savingAdjustment = false
  elements.cancelAdjustmentButton.disabled = false
  elements.closeAdjustmentButton.disabled = false

  if (result.error) {
    elements.saveAdjustmentButton.disabled = false
    setAdjustmentMessage(
      result.error.message ||
        'The payroll adjustment could not be saved.',
      'error'
    )
    return
  }

  const completedMode = state.adjustmentMode
  closeAdjustmentDialog()
  await loadPeriod()
  setMessage(
    completedMode === 'remove'
      ? 'The manual adjustment was removed and payroll totals were rebuilt. Its audit history was preserved.'
      : completedMode === 'edit'
        ? 'The manual adjustment and payroll totals were updated.'
        : 'The manual adjustment was added and payroll totals were updated.',
    'success'
  )
}

function setLifecycleDialogMessage(message = '', type = '') {
  elements.lifecycleDialogMessage.textContent = message
  elements.lifecycleDialogMessage.classList.toggle(
    'error',
    type === 'error'
  )
  elements.lifecycleDialogMessage.classList.toggle(
    'success',
    type === 'success'
  )
}

function closeLifecycleDialog() {
  if (state.savingLifecycle) return
  if (typeof elements.lifecycleDialog.close === 'function') {
    elements.lifecycleDialog.close()
  } else {
    elements.lifecycleDialog.removeAttribute('open')
  }
  elements.lifecycleForm.reset()
  setLifecycleDialogMessage()
}

function lifecycleTotals() {
  return state.calculations.reduce(
    (totals, record) => ({
      gross: totals.gross + Number(record.gross_pay || 0),
      deductions:
        totals.deductions + Number(record.total_deductions || 0),
      net: totals.net + Number(record.net_pay || 0)
    }),
    { gross: 0, deductions: 0, net: 0 }
  )
}

function openLifecycleDialog(mode) {
  const status = state.period?.period_status
  if (
    state.savingLifecycle ||
    (mode === 'review' &&
      (
        !state.canReviewPayroll ||
        !['draft', 'reopened'].includes(status)
      )) ||
    (mode === 'finalize' &&
      (!state.canFinalizePayroll || status !== 'review')) ||
    (mode === 'reopen' &&
      (!state.canReopenPayroll || status !== 'finalized'))
  ) {
    return
  }

  state.lifecycleMode = mode
  elements.lifecycleForm.reset()
  setLifecycleDialogMessage()

  const totals = lifecycleTotals()
  const blockingCount = state.exceptions.filter(
    issue => issue.is_blocking
  ).length
  const summaries = [
    element(
      'div',
      '',
      `${state.calculations.length} employees · Gross ${formatMoney(totals.gross)} · Deductions ${formatMoney(totals.deductions)} · Net ${formatMoney(totals.net)}`
    )
  ]

  if (mode === 'review') {
    elements.lifecycleDialogEyebrow.textContent = 'Payroll review'
    elements.lifecycleDialogTitle.textContent = 'Submit payroll for approval'
    elements.lifecycleDialogText.textContent =
      'The database will recalculate stored totals and verify exceptions, snapshots, prepaid balances, effective rates, and rounding rules.'
    elements.lifecycleReasonLabel.textContent = 'Review notes'
    elements.lifecycleReason.minLength = 3
    elements.lifecycleReason.placeholder =
      'Required review conclusion for the payroll audit trail'
    elements.lifecycleConfirmWrap.hidden = true
    elements.saveLifecycleButton.textContent = 'Record review'
    elements.saveLifecycleButton.className =
      'payroll-button payroll-button-primary'
    summaries.push(
      element(
        'div',
        '',
        blockingCount
          ? `${blockingCount} blocking exceptions remain.`
          : 'No blocking exceptions are currently visible.'
      )
    )
  } else if (mode === 'finalize') {
    elements.lifecycleDialogEyebrow.textContent =
      'Final payroll approval'
    elements.lifecycleDialogTitle.textContent =
      'Approve and finalize payroll'
    elements.lifecycleDialogText.textContent =
      'The server will run every final gate again before locking this payroll.'
    elements.lifecycleReasonLabel.textContent = 'Approval notes'
    elements.lifecycleReason.minLength = 3
    elements.lifecycleReason.placeholder =
      'Required approval conclusion for the payroll audit trail'
    elements.lifecycleConfirmWrap.hidden = false
    elements.lifecycleConfirmText.textContent =
      'I confirm the employee totals, snapshots, rates, prepaid-minute balances, and rounding rules. I understand finalized payroll is immutable.'
    elements.saveLifecycleButton.textContent = 'Approve and finalize'
    elements.saveLifecycleButton.className =
      'payroll-button payroll-button-primary'
    summaries.push(
      element(
        'div',
        '',
        `Reviewed by ${state.lifecycle?.reviewed_by_name || 'an authorized reviewer'} · ${formatDateTime(state.lifecycle?.reviewed_at)}`
      )
    )
  } else {
    elements.lifecycleDialogEyebrow.textContent =
      'Controlled reopening'
    elements.lifecycleDialogTitle.textContent = 'Reopen finalized payroll'
    elements.lifecycleDialogText.textContent =
      'Reopening preserves the prior approval evidence in the audit trail and marks every employee for full recalculation.'
    elements.lifecycleReasonLabel.textContent = 'Reopening reason'
    elements.lifecycleReason.minLength = 5
    elements.lifecycleReason.placeholder =
      'Required reason for reopening finalized payroll'
    elements.lifecycleConfirmWrap.hidden = false
    elements.lifecycleConfirmText.textContent =
      'I understand every employee must be recalculated, reviewed, and finalized again. Generated payslips require the controlled regeneration workflow.'
    elements.saveLifecycleButton.textContent = 'Reopen payroll'
    elements.saveLifecycleButton.className =
      'payroll-button danger'
    summaries.push(
      element(
        'div',
        '',
        `Finalized version ${Number(state.lifecycle?.finalization_version || 1)} · ${formatDateTime(state.lifecycle?.finalized_at)}`
      )
    )
  }

  elements.lifecycleSummary.replaceChildren(...summaries)
  if (typeof elements.lifecycleDialog.showModal === 'function') {
    elements.lifecycleDialog.showModal()
  } else {
    elements.lifecycleDialog.setAttribute('open', '')
  }
  elements.lifecycleReason.focus()
}

async function savePayrollLifecycle(event) {
  event.preventDefault()
  if (
    state.savingLifecycle ||
    !elements.lifecycleForm.reportValidity()
  ) {
    return
  }

  const requiresConfirmation =
    state.lifecycleMode === 'finalize' ||
    state.lifecycleMode === 'reopen'
  if (requiresConfirmation && !elements.lifecycleConfirm.checked) {
    setLifecycleDialogMessage(
      'Confirm the lifecycle statement before continuing.',
      'error'
    )
    return
  }

  state.savingLifecycle = true
  elements.saveLifecycleButton.disabled = true
  elements.cancelLifecycleButton.disabled = true
  elements.closeLifecycleButton.disabled = true
  setLifecycleDialogMessage(
    state.lifecycleMode === 'review'
      ? 'Recalculating totals and recording review evidence…'
      : state.lifecycleMode === 'finalize'
        ? 'Running final checks and locking payroll…'
        : 'Preserving finalization evidence and reopening payroll…'
  )

  const reason = elements.lifecycleReason.value.trim()
  let result
  if (state.lifecycleMode === 'review') {
    result = await supabase.rpc('payroll_review_period', {
      p_payroll_period_id: state.periodId,
      p_review_notes: reason
    })
  } else if (state.lifecycleMode === 'finalize') {
    result = await supabase.rpc('payroll_finalize_period', {
      p_payroll_period_id: state.periodId,
      p_approval_notes: reason
    })
  } else {
    result = await supabase.rpc('payroll_reopen_period', {
      p_payroll_period_id: state.periodId,
      p_reopen_reason: reason
    })
  }

  state.savingLifecycle = false
  elements.saveLifecycleButton.disabled = false
  elements.cancelLifecycleButton.disabled = false
  elements.closeLifecycleButton.disabled = false

  if (result.error) {
    setLifecycleDialogMessage(
      result.error.message ||
        'The payroll lifecycle action could not be completed.',
      'error'
    )
    return
  }

  const completedMode = state.lifecycleMode
  closeLifecycleDialog()
  await loadPeriod()
  setMessage(
    completedMode === 'review'
      ? 'Payroll review was recorded. The period is ready for an authorized final approver.'
      : completedMode === 'finalize'
        ? `Payroll was finalized and locked. Gross ${formatMoney(result.data?.gross_pay)} · Net ${formatMoney(result.data?.net_pay)}.`
        : 'Payroll was reopened under audit control. Every employee is marked for recalculation.',
    'success'
  )
}

async function calculateDraftPayroll() {
  const blockingCount = state.exceptions.filter(
    issue => issue.is_blocking
  ).length
  if (
    state.calculating ||
    !state.canCalculatePayroll ||
    blockingCount ||
    !['draft', 'reopened'].includes(state.period?.period_status)
  ) {
    return
  }

  state.calculating = true
  elements.calculateButton.disabled = true
  elements.refresh.disabled = true
  renderPeriod()
  setMessage('Calculating employee payroll from approved snapshots…')

  const { data, error } = await supabase.rpc('payroll_calculate_draft', {
    p_payroll_period_id: state.periodId
  })

  state.calculating = false
  elements.refresh.disabled = false

  if (error) {
    renderPeriod()
    setMessage(
      error.message ||
        'Draft payroll could not be calculated. Review the period exceptions.',
      'error'
    )
    return
  }

  await loadPeriod()
  const employeeCount = Number(data?.employee_count || 0)
  setMessage(
    `${employeeCount} employee ${employeeCount === 1 ? 'record was' : 'records were'} calculated. Gross ${formatMoney(data?.gross_pay)} · Net ${formatMoney(data?.net_pay)}.`,
    'success'
  )
}

async function importApprovedAttendance() {
  if (
    state.importing ||
    !state.canImportAttendance ||
    !['draft', 'reopened'].includes(state.period?.period_status)
  ) {
    return
  }

  state.importing = true
  elements.importButton.disabled = true
  elements.refresh.disabled = true
  setMessage('Importing payroll-ready attendance…')

  const { data, error } = await supabase.rpc('payroll_import_attendance', {
    p_payroll_period_id: state.periodId
  })

  state.importing = false
  elements.refresh.disabled = false

  if (error) {
    elements.importButton.disabled = false
    setMessage(
      error.message || 'Approved attendance could not be imported.',
      'error'
    )
    return
  }

  await loadPeriod()
  const importedCount = Number(data?.new_snapshot_count || 0)
  const alreadyCurrentCount = Number(
    data?.already_current_snapshot_count || 0
  )
  setMessage(
    `${importedCount} new attendance ${importedCount === 1 ? 'snapshot was' : 'snapshots were'} imported. ${alreadyCurrentCount} ${alreadyCurrentCount === 1 ? 'entry was' : 'entries were'} already current.`,
    'success'
  )
}

async function approveSelectedPreplots() {
  const reason = elements.preplotReason.value.trim()
  if (
    state.approvingPreplots ||
    !state.canApprovePreplots ||
    !state.selectedPreplots.size
  ) {
    return
  }

  if (!reason) {
    setMessage('Add an approval reason for the selected pre-plots.', 'error')
    renderPreplots()
    return
  }

  state.approvingPreplots = true
  elements.approvePreplotsButton.disabled = true
  elements.refresh.disabled = true
  setMessage('Validating and approving the selected schedule versions…')

  const { data, error } = await supabase.rpc('payroll_approve_preplots', {
    p_payroll_period_id: state.periodId,
    p_schedule_ids: [...state.selectedPreplots],
    p_approval_reason: reason
  })

  state.approvingPreplots = false
  elements.refresh.disabled = false

  if (error) {
    const safeMessage = String(error.message || '')
    setMessage(
      safeMessage.includes('cannot be approved') ||
      safeMessage.includes('required') ||
      safeMessage.includes('draft or reopened')
        ? safeMessage
        : 'The selected pre-plots could not be approved. Refresh and try again.',
      'error'
    )
    renderPreplots()
    return
  }

  const approvedCount = Number(data?.approved_schedule_count || 0)
  const alreadyCurrentCount = Number(data?.already_current_count || 0)
  state.selectedPreplots.clear()
  elements.preplotReason.value = ''
  await loadPeriod()
  setMessage(
    `${approvedCount} ${approvedCount === 1 ? 'schedule version was' : 'schedule versions were'} approved and preserved.${alreadyCurrentCount ? ` ${alreadyCurrentCount} ${alreadyCurrentCount === 1 ? 'selection was' : 'selections were'} already current.` : ''}`,
    'success'
  )
}

function openPrepaidDialog() {
  elements.prepaidForm.reset()
  elements.prepaidTimezone.value = 'America/New_York'
  elements.prepaidDate.min = addCalendarDays(
    state.period.payment_date,
    1
  )
  elements.prepaidDate.max = state.period.period_end
  state.prepaidCandidate = null
  setPrepaidMessage('')
  updatePrepaidFormState()
  if (typeof elements.prepaidDialog.showModal === 'function') {
    elements.prepaidDialog.showModal()
  } else {
    elements.prepaidDialog.setAttribute('open', '')
  }
}

function closePrepaidDialog() {
  if (typeof elements.prepaidDialog.close === 'function') {
    elements.prepaidDialog.close()
  } else {
    elements.prepaidDialog.removeAttribute('open')
  }
}

async function savePrepaidSchedule(event) {
  event.preventDefault()
  updatePrepaidFormState()

  if (
    state.savingPrepaid ||
    elements.savePrepaidButton.disabled
  ) {
    return
  }

  const candidate = state.prepaidCandidate
  const scheduleChangeConfirmed =
    Boolean(candidate) &&
    (
      candidate.schedule_status === 'scheduled' ||
      prepaidValuesDiffer(candidate) ||
      ['incomplete_shift', 'invalid_shift'].includes(
        candidate.approval_status
      )
    ) &&
    elements.prepaidConfirm.checked

  state.savingPrepaid = true
  updatePrepaidFormState()
  setPrepaidMessage(
    'Validating the source schedule and preserving its exact version…'
  )

  const { data, error } = await supabase.rpc(
    'payroll_save_and_approve_prepaid_schedule',
    {
      p_payroll_period_id: state.periodId,
      p_employee_id: elements.prepaidEmployee.value,
      p_work_date: elements.prepaidDate.value,
      p_prepaid_login: elements.prepaidLogin.value,
      p_prepaid_logout: elements.prepaidLogout.value,
      p_timezone: elements.prepaidTimezone.value.trim(),
      p_approval_reason: elements.prepaidReason.value.trim(),
      p_allow_schedule_change: scheduleChangeConfirmed
    }
  )

  state.savingPrepaid = false

  if (error) {
    setPrepaidMessage(
      error.message ||
        'The prepaid schedule could not be saved. Refresh and try again.',
      'error'
    )
    updatePrepaidFormState()
    return
  }

  const action = data?.schedule_action || 'existing'
  const alreadyCurrent = Number(data?.already_current_count || 0) > 0
  closePrepaidDialog()
  await loadPeriod()
  setMessage(
    alreadyCurrent
      ? 'That exact schedule version was already approved as prepaid hours.'
      : `${action === 'created' ? 'The source schedule was created and' : action === 'updated' || action === 'published' ? 'The source schedule was updated and' : 'The existing source schedule was'} approved as prepaid hours. No attendance entry was created.`,
    'success'
  )
}

async function initialize() {
  organizePayrollStepPanels()
  setPayrollStep(state.activeStep)
  if (!isValidUuid(state.periodId)) {
    window.location.replace('./payroll-dashboard.html')
    return
  }

  try {
    const access = await loadCurrentWorkforceAccess(supabase)

    if (!access.authenticated) {
      window.location.replace(
        `./login.html?returnTo=${encodeURIComponent(`payroll-period.html?id=${state.periodId}`)}`
      )
      return
    }

    if (!access.allowed || !hasProcessingAccess(access)) {
      window.alert('You do not have permission to view payroll period readiness.')
      window.location.replace('./home.html')
      return
    }

    state.canViewAttendance = hasWorkforcePermission(
      access,
      'view_team_attendance'
    )
    state.canImportAttendance = hasWorkforcePermission(
      access,
      'create_payroll'
    )
    state.canApprovePreplots = hasWorkforcePermission(
      access,
      'create_payroll'
    )
    state.canManageSchedules = hasWorkforcePermission(
      access,
      'manage_schedules'
    )
    state.canManageRates = hasWorkforcePermission(
      access,
      'manage_agent_rates'
    )
    state.canCalculatePayroll = hasWorkforcePermission(
      access,
      'create_payroll'
    )
    state.canReviewPayroll = hasWorkforcePermission(
      access,
      'review_payroll'
    )
    state.canFinalizePayroll = hasWorkforcePermission(
      access,
      'finalize_payroll'
    )
    state.canReopenPayroll = hasWorkforcePermission(
      access,
      'reopen_payroll'
    )
    document.body.classList.remove('payroll-access-pending')
    await loadPeriod()
  } catch (error) {
    console.error('Payroll Period initialization failed.', error)
    document.body.classList.remove('payroll-access-pending')
    setMessage(
      'Payroll Period could not load. Refresh the page or return to the Payroll Dashboard.',
      'error'
    )
  }
}

document.querySelectorAll('[data-payroll-step]').forEach(button => {
  button.addEventListener('click', () => setPayrollStep(button.dataset.payrollStep, { focus: true }))
})

document.addEventListener('click', event => {
  const link = event.target.closest('a[href^="#"]')
  if (!link) return
  const target = link.getAttribute('href')
  if (target?.includes('payrollPreplot')) setPayrollStep('prepaid')
  if (target?.includes('payrollException')) setPayrollStep('exceptions')
})

elements.refresh.addEventListener('click', loadPeriod)
elements.calculationSearch.addEventListener('input', event => {
  state.payrollEmployeeSearch = event.target.value
  renderCalculations()
})
elements.importButton.addEventListener('click', importApprovedAttendance)
elements.calculateButton.addEventListener('click', calculateDraftPayroll)
elements.calculationBody.addEventListener('click', event => {
  const button = event.target.closest('[data-payroll-action]')
  if (!button) return
  if (button.dataset.payrollAction === 'refresh-employee') {
    void refreshEmployeeAttendanceAndRecalculate(button.dataset.payrollRecordId)
    return
  }
  if (button.dataset.payrollAction === 'recalculate') {
    void recalculateEmployeeDraft(button.dataset.payrollRecordId)
  }
})
elements.reviewPayrollButton.addEventListener('click', () => {
  openLifecycleDialog('review')
})
elements.finalizePayrollButton.addEventListener('click', () => {
  openLifecycleDialog('finalize')
})
elements.reopenPayrollButton.addEventListener('click', () => {
  openLifecycleDialog('reopen')
})
elements.lifecycleForm.addEventListener('submit', savePayrollLifecycle)
elements.closeLifecycleButton.addEventListener(
  'click',
  closeLifecycleDialog
)
elements.cancelLifecycleButton.addEventListener(
  'click',
  closeLifecycleDialog
)
elements.lifecycleDialog.addEventListener('click', event => {
  if (event.target === elements.lifecycleDialog) {
    closeLifecycleDialog()
  }
})
elements.addAdjustmentButton.addEventListener('click', () => {
  openAdjustmentDialog('add')
})
elements.adjustmentBody.addEventListener('click', event => {
  const button = event.target.closest('[data-adjustment-action]')
  if (!button) return
  const adjustment = state.adjustments.find(
    item => item.payroll_item_id === button.dataset.adjustmentId
  )
  if (!adjustment) return
  openAdjustmentDialog(button.dataset.adjustmentAction, adjustment)
})
elements.adjustmentForm.addEventListener('submit', savePayrollAdjustment)
elements.closeAdjustmentButton.addEventListener(
  'click',
  closeAdjustmentDialog
)
elements.cancelAdjustmentButton.addEventListener(
  'click',
  closeAdjustmentDialog
)
elements.adjustmentDialog.addEventListener('click', event => {
  if (event.target === elements.adjustmentDialog) {
    closeAdjustmentDialog()
  }
})
elements.preplotBody.addEventListener('change', event => {
  const checkbox = event.target.closest('.payroll-preplot-checkbox')
  if (!checkbox) return
  if (checkbox.checked) {
    state.selectedPreplots.add(checkbox.dataset.scheduleId)
  } else {
    state.selectedPreplots.delete(checkbox.dataset.scheduleId)
  }
  renderPreplots()
})
elements.preplotBody.addEventListener('click', event => {
  const link = event.target.closest('[data-exception-filter]')
  if (!link) return
  event.preventDefault()
  state.exceptionFilter = link.dataset.exceptionFilter || 'all'
  setPayrollStep('exceptions', { focus: false })
  renderExceptionReview()
  document.getElementById('payrollExceptionReviewTitle')?.scrollIntoView({
    behavior: 'smooth',
    block: 'start'
  })
})
elements.preplotReason.addEventListener('input', renderPreplots)
elements.approvePreplotsButton.addEventListener(
  'click',
  approveSelectedPreplots
)
elements.addPrepaidButton.addEventListener('click', openPrepaidDialog)
elements.closePrepaidButton.addEventListener('click', closePrepaidDialog)
elements.cancelPrepaidButton.addEventListener('click', closePrepaidDialog)
elements.prepaidForm.addEventListener('submit', savePrepaidSchedule)
elements.prepaidEmployee.addEventListener('change', () => {
  updatePrepaidFormState({ loadCandidateTimes: true })
})
elements.prepaidDate.addEventListener('change', () => {
  updatePrepaidFormState({ loadCandidateTimes: true })
})
for (const input of [
  elements.prepaidLogin,
  elements.prepaidLogout,
  elements.prepaidTimezone,
  elements.prepaidReason,
  elements.prepaidConfirm
]) {
  input.addEventListener('input', () => updatePrepaidFormState())
  input.addEventListener('change', () => updatePrepaidFormState())
}
elements.prepaidDialog.addEventListener('click', event => {
  if (event.target === elements.prepaidDialog) closePrepaidDialog()
})
elements.exceptionFilter.addEventListener('change', event => {
  state.exceptionFilter = event.target.value
  renderExceptionReview()
})
document.addEventListener('DOMContentLoaded', initialize)
