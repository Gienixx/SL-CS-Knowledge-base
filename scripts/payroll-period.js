import { supabase } from './supabaseClient.js?v=10'
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
  exceptionFilter: 'all',
  missingAttendance: new Map(),
  importStatuses: new Map(),
  canViewAttendance: false,
  canImportAttendance: false,
  canApprovePreplots: false,
  canManageSchedules: false,
  canManageRates: false,
  loading: false,
  importing: false,
  approvingPreplots: false,
  savingPrepaid: false,
  prepaidCandidate: null
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
  exceptionBody: document.getElementById('payrollExceptionBody')
}

const dateFormatter = new Intl.DateTimeFormat('en-PH', {
  year: 'numeric',
  month: 'short',
  day: 'numeric'
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
  renderEmployees()
}

async function loadPeriod() {
  if (state.loading) return
  state.loading = true
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
    prepaidBalancesResult
  ] =
    await Promise.all([
      supabase.rpc('payroll_get_period_dashboard'),
      supabase.rpc('payroll_get_period_employee_readiness', {
        p_payroll_period_id: state.periodId
      }),
      supabase.rpc('payroll_get_period_missing_attendance', {
        p_payroll_period_id: state.periodId
      }),
      supabase.rpc('payroll_get_period_attendance_import_status', {
        p_payroll_period_id: state.periodId
      }),
      supabase.rpc('payroll_get_period_exceptions', {
        p_payroll_period_id: state.periodId
      }),
      supabase.rpc('payroll_get_preplot_candidates', {
        p_payroll_period_id: state.periodId
      }),
      supabase.rpc('payroll_get_period_prepaid_hours', {
        p_payroll_period_id: state.periodId
      })
    ])

  state.loading = false
  elements.refresh.disabled = false

  if (
    dashboardResult.error ||
    readinessResult.error ||
    missingAttendanceResult.error ||
    importStatusResult.error ||
    exceptionsResult.error ||
    preplotsResult.error ||
    prepaidBalancesResult.error
  ) {
    setMessage(
      'Payroll readiness could not be loaded. Refresh or contact a system administrator.',
      'error'
    )
    return
  }

  state.period = (dashboardResult.data || []).find(
    period => period.payroll_period_id === state.periodId
  ) || null

  if (!state.period) {
    setMessage('Payroll period was not found.', 'error')
    return
  }

  state.employees = readinessResult.data || []
  state.preplots = preplotsResult.data || []
  state.prepaidBalances = prepaidBalancesResult.data || []
  state.exceptions = exceptionsResult.data || []
  state.missingAttendance = new Map()
  for (const entry of missingAttendanceResult.data || []) {
    const rows = state.missingAttendance.get(entry.employee_user_id) || []
    rows.push(entry)
    state.missingAttendance.set(entry.employee_user_id, rows)
  }
  state.importStatuses = new Map(
    (importStatusResult.data || []).map(status => [
      status.employee_user_id,
      status
    ])
  )
  renderAll()
  setMessage('')
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
    document.body.classList.remove('payroll-access-pending')
    await loadPeriod()
  } catch {
    window.location.replace('./home.html')
  }
}

elements.refresh.addEventListener('click', loadPeriod)
elements.importButton.addEventListener('click', importApprovedAttendance)
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
