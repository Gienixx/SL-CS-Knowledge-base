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

const state = {
  periodId: new URLSearchParams(window.location.search).get('id') || '',
  period: null,
  employees: [],
  missingAttendance: new Map(),
  importStatuses: new Map(),
  canViewAttendance: false,
  canImportAttendance: false,
  loading: false,
  importing: false
}

const elements = {
  message: document.getElementById('payrollPeriodMessage'),
  refresh: document.getElementById('refreshPayrollPeriodButton'),
  importButton: document.getElementById('importPayrollAttendanceButton'),
  importStatus: document.getElementById('payrollImportStatus'),
  body: document.getElementById('payrollReadinessBody'),
  exceptionSummary: document.getElementById('payrollExceptionSummary'),
  exceptionTitle: document.getElementById('payrollExceptionTitle'),
  exceptionText: document.getElementById('payrollExceptionText'),
  exceptionChips: document.getElementById('payrollExceptionChips')
}

const dateFormatter = new Intl.DateTimeFormat('en-PH', {
  year: 'numeric',
  month: 'short',
  day: 'numeric'
})

function formatDate(value) {
  return value ? dateFormatter.format(new Date(`${value}T00:00:00`)) : '—'
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

function renderPeriod() {
  const period = state.period
  if (!period) return

  document.getElementById('payrollPeriodTitle').textContent =
    `${formatDate(period.period_start)} – ${formatDate(period.period_end)}`
  document.getElementById('payrollPeriodSubtitle').textContent =
    `Payment date ${formatDate(period.payment_date)} · ${Number(period.employee_count || 0)} eligible employees loaded`
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

function addExceptionChip(fragment, count, label) {
  if (!count) return
  fragment.append(
    element('span', 'payroll-exception-chip', `${count} ${label}`)
  )
}

function renderExceptions() {
  const missingRates =
    state.employees.filter(employee => !employee.has_effective_rate).length
  const incompleteAttendance =
    state.employees.filter(employee => employeeHasAttendanceIssue(employee)).length
  const missingEntries = state.employees.reduce(
    (total, employee) => total + Number(employee.missing_attendance_count || 0),
    0
  )
  const missingClockOuts = state.employees.reduce(
    (total, employee) => total + Number(employee.missing_clock_out_count || 0),
    0
  )
  const pendingReviews = state.employees.reduce(
    (total, employee) => total + Number(employee.pending_review_count || 0),
    0
  )
  const hasExceptions = missingRates > 0 || incompleteAttendance > 0

  elements.exceptionSummary.className =
    `payroll-exception-summary ${hasExceptions ? 'warning' : 'clear'}`
  elements.exceptionTitle.textContent = hasExceptions
    ? 'Readiness issues need attention'
    : 'Employees are ready for attendance import'
  elements.exceptionText.textContent = hasExceptions
    ? 'Resolve missing rates and attendance issues before payroll calculation.'
    : 'No missing rates or incomplete attendance were detected for the loaded employees.'

  const fragment = document.createDocumentFragment()
  addExceptionChip(fragment, missingRates, 'missing rates')
  addExceptionChip(fragment, incompleteAttendance, 'employees with attendance issues')
  addExceptionChip(fragment, missingEntries, 'missing attendance entries')
  addExceptionChip(fragment, missingClockOuts, 'missing clock-outs')
  addExceptionChip(fragment, pendingReviews, 'awaiting review')
  elements.exceptionChips.replaceChildren(fragment)
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

function renderAll() {
  renderPeriod()
  renderMetrics()
  renderExceptions()
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
    importStatusResult
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
      })
    ])

  state.loading = false
  elements.refresh.disabled = false

  if (
    dashboardResult.error ||
    readinessResult.error ||
    missingAttendanceResult.error ||
    importStatusResult.error
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
    document.body.classList.remove('payroll-access-pending')
    await loadPeriod()
  } catch {
    window.location.replace('./home.html')
  }
}

elements.refresh.addEventListener('click', loadPeriod)
elements.importButton.addEventListener('click', importApprovedAttendance)
document.addEventListener('DOMContentLoaded', initialize)
