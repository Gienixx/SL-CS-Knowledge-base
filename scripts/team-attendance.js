import { supabase } from './supabaseClient.js?v=9'
import {
  hasWorkforcePermission,
  loadCurrentWorkforceAccess
} from './workforce-permissions.js?v=1'

const ATTENDANCE_STATUS_LABELS = Object.freeze({
  present: 'Present',
  absent: 'Absent',
  on_leave: 'On leave',
  excused: 'Excused'
})

const REVIEW_STATUS_LABELS = Object.freeze({
  pending: 'Pending',
  approved: 'Approved',
  corrected: 'Corrected',
  rejected: 'Rejected',
  locked: 'Locked'
})

const CORRECTION_REASON_LABELS = Object.freeze({
  forgot_clock_in: 'Forgot clock-in',
  forgot_clock_out: 'Forgot clock-out',
  system_issue: 'System issue',
  connection_issue: 'Connection issue',
  incorrect_schedule: 'Incorrect schedule',
  approved_overtime: 'Approved overtime',
  manager_confirmed: 'Manager confirmed',
  other: 'Other'
})

const elements = {
  workforceLink: document.getElementById('teamAttendanceWorkforceLink'),
  recordCount: document.getElementById('teamAttendanceRecordCount'),
  openCount: document.getElementById('teamAttendanceOpenCount'),
  missingCount: document.getElementById('teamAttendanceMissingCount'),
  overtimeCount: document.getElementById('teamAttendanceOvertimeCount'),
  scope: document.getElementById('teamAttendanceScope'),
  startDate: document.getElementById('teamAttendanceStartDate'),
  endDate: document.getElementById('teamAttendanceEndDate'),
  employeeFilter: document.getElementById('teamAttendanceEmployeeFilter'),
  teamFilter: document.getElementById('teamAttendanceTeamFilter'),
  statusFilter: document.getElementById('teamAttendanceStatusFilter'),
  correctedFilter: document.getElementById('teamAttendanceCorrectedFilter'),
  openFilter: document.getElementById('teamAttendanceOpenFilter'),
  missingFilter: document.getElementById('teamAttendanceMissingFilter'),
  overtimeFilter: document.getElementById('teamAttendanceOvertimeFilter'),
  resetButton: document.getElementById('teamAttendanceResetButton'),
  refreshButton: document.getElementById('teamAttendanceRefreshButton'),
  filterMessage: document.getElementById('teamAttendanceFilterMessage'),
  tableBody: document.getElementById('teamAttendanceTableBody'),
  tableMessage: document.getElementById('teamAttendanceTableMessage'),
  tableNote: document.getElementById('teamAttendanceTableNote'),
  actionHeader: document.getElementById('teamAttendanceActionHeader'),
  correctionModal: document.getElementById('attendanceCorrectionModal'),
  correctionForm: document.getElementById('attendanceCorrectionForm'),
  correctionId: document.getElementById('attendanceCorrectionId'),
  correctionSummary: document.getElementById('attendanceCorrectionSummary'),
  correctionStatus: document.getElementById('attendanceCorrectionStatus'),
  correctionSchedule: document.getElementById('attendanceCorrectionSchedule'),
  correctionClockIn: document.getElementById('attendanceCorrectionClockIn'),
  correctionClockOut: document.getElementById('attendanceCorrectionClockOut'),
  correctionAdminNotes: document.getElementById('attendanceCorrectionAdminNotes'),
  correctionReason: document.getElementById('attendanceCorrectionReason'),
  correctionReasonNotes: document.getElementById('attendanceCorrectionReasonNotes'),
  correctionApprovalNote: document.getElementById('attendanceCorrectionApprovalNote'),
  correctionSaveButton: document.getElementById('attendanceCorrectionSaveButton'),
  correctionMessage: document.getElementById('attendanceCorrectionMessage')
}

let access = null
let employees = []
let teams = []
let attendanceRows = []
let busy = false
let correctionBusy = false
let correctionRecord = null
let lastFocusedElement = null

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function errorMessage(error) {
  return error?.message || 'An unexpected error occurred.'
}

function setMessage(element, text, type = '') {
  if (!element) return
  element.textContent = text
  element.className = type ? `wf-message ${type}` : 'wf-message'
}

function canCorrectAttendance() {
  return Boolean(
    access?.is_admin === true &&
    hasWorkforcePermission(access, 'correct_attendance')
  )
}

function canApproveAttendance() {
  return Boolean(
    access?.is_admin === true &&
    hasWorkforcePermission(access, 'approve_attendance')
  )
}

function localDateKey(date = new Date(), timezone = access?.timezone || 'Asia/Manila') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function defaultDateRange() {
  const today = localDateKey()
  return { start: `${today.slice(0, 7)}-01`, end: today }
}

function parseDateKey(value) {
  const [year, month, day] = String(value).split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

function dateRangeDays(start, end) {
  return Math.floor((parseDateKey(end) - parseDateKey(start)) / 86400000)
}

function validateDateRange() {
  const start = elements.startDate.value
  const end = elements.endDate.value

  if (!start || !end) {
    throw new Error('Start date and end date are required.')
  }

  if (end < start) {
    throw new Error('End date cannot be earlier than start date.')
  }

  if (dateRangeDays(start, end) > 366) {
    throw new Error('Select a date range of 367 days or fewer.')
  }

  return { start, end }
}

function formatDate(value) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(parseDateKey(value))
}

function formatDateTime(value, timezone, includeDate = false) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || access?.timezone || 'Asia/Manila',
    ...(includeDate ? { month: 'short', day: 'numeric', year: 'numeric' } : {}),
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(value))
}

function formatDateTimeLocalInput(value, timezone) {
  if (!value) return ''
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || access?.timezone || 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(value))
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`
}

function formatMinutes(value) {
  if (value === null || value === undefined) return 'Pending'
  const safeMinutes = Math.max(0, Number(value) || 0)
  const hours = Math.floor(safeMinutes / 60)
  const minutes = safeMinutes % 60
  if (!hours) return `${minutes}m`
  return `${hours}h ${minutes}m`
}

function formatShift(row) {
  if (!row.schedule_id) return 'Unscheduled'
  if (!row.scheduled_start || !row.scheduled_end) return 'Shift unavailable'
  const timezone = row.schedule_timezone || row.employee_timezone || access?.timezone
  return `${formatDateTime(row.scheduled_start, timezone)} – ${formatDateTime(row.scheduled_end, timezone)}`
}

function formatCorrectionScheduleOption(schedule, row) {
  const timezone = schedule.timezone || row.employee_timezone || access?.timezone
  const status = schedule.status === 'changed'
    ? 'Changed'
    : schedule.status === 'completed'
      ? 'Completed'
      : 'Published'
  return `${formatDateTime(schedule.shift_start, timezone)} – ${formatDateTime(schedule.shift_end, timezone)} · Shift ${schedule.shift_sequence} · ${status}`
}

function statusBadgeClass(status) {
  if (status === 'present' || status === 'approved') return 'success'
  if (status === 'absent' || status === 'rejected') return 'danger'
  if (status === 'on_leave' || status === 'excused' || status === 'pending' || status === 'corrected') return 'warning'
  return 'muted'
}

function createCell(primary, secondary = '', className = '') {
  const cell = document.createElement('td')
  const stack = document.createElement('div')
  stack.className = `team-attendance-cell-stack${className ? ` ${className}` : ''}`

  const main = document.createElement('span')
  main.className = 'team-attendance-time'
  main.textContent = primary || '—'
  stack.appendChild(main)

  if (secondary) {
    const sub = document.createElement('span')
    sub.className = 'team-attendance-muted'
    sub.textContent = secondary
    stack.appendChild(sub)
  }

  cell.appendChild(stack)
  return cell
}

function createEmployeeCell(row) {
  const secondary = [row.employee_id, row.employee_email].filter(Boolean).join(' · ')
  const cell = createCell(row.employee_name || 'Unknown employee', secondary)
  cell.querySelector('.team-attendance-time').className = 'wf-person'
  return cell
}

function createMinutesCell(value, secondary = '') {
  const cell = createCell(formatMinutes(value), secondary, 'compact')
  cell.querySelector('.team-attendance-time').className = 'team-attendance-minute-value'
  return cell
}

function createBadgeCell(labels) {
  const cell = document.createElement('td')
  const stack = document.createElement('div')
  stack.className = 'team-attendance-status-stack'

  labels.forEach(({ label, modifier = 'muted' }) => {
    const badge = document.createElement('span')
    badge.className = `wf-badge ${modifier}`
    badge.textContent = label
    stack.appendChild(badge)
  })

  if (!labels.length) cell.textContent = '—'
  else cell.appendChild(stack)
  return cell
}

function createAttendanceStatusCell(row) {
  const labels = [{
    label: ATTENDANCE_STATUS_LABELS[row.attendance_status] || row.attendance_status || 'Unknown',
    modifier: statusBadgeClass(row.attendance_status)
  }]

  if (row.is_open) labels.push({ label: 'Open', modifier: 'warning' })
  if (row.is_missing_clock_out) labels.push({ label: 'Missing clock-out', modifier: 'danger' })
  return createBadgeCell(labels)
}

function createCorrectionStatusCell(row) {
  const reviewStatus = row.review_status || 'pending'
  const labels = [{
    label: REVIEW_STATUS_LABELS[reviewStatus] || reviewStatus,
    modifier: statusBadgeClass(reviewStatus)
  }]

  if (row.is_corrected) labels.push({ label: 'Corrected', modifier: 'warning' })
  return createBadgeCell(labels)
}

function createActionCell(record) {
  const cell = document.createElement('td')
  cell.className = 'wf-row-actions team-attendance-action-cell'
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'wf-row-btn'
  button.textContent = record.review_status === 'locked' ? 'Locked' : 'Correct'
  button.disabled = record.review_status === 'locked'
  button.addEventListener('click', () => openCorrection(record))
  cell.appendChild(button)
  return cell
}

function filteredRows() {
  const employeeId = elements.employeeFilter.value
  const teamId = elements.teamFilter.value
  const status = elements.statusFilter.value
  const corrected = elements.correctedFilter.value
  const openOnly = elements.openFilter.checked
  const missingOnly = elements.missingFilter.checked
  const overtimeOnly = elements.overtimeFilter.checked

  return attendanceRows.filter(row => {
    if (employeeId && row.employee_user_id !== employeeId) return false
    if (teamId && row.team_id !== teamId) return false
    if (status && row.attendance_status !== status) return false
    if (corrected === 'corrected' && !row.is_corrected) return false
    if (corrected === 'not_corrected' && row.is_corrected) return false
    if (openOnly && !row.is_open) return false
    if (missingOnly && !row.is_missing_clock_out) return false
    if (overtimeOnly && Number(row.total_overtime_minutes) <= 0) return false
    return true
  })
}

function renderSummary(rows) {
  elements.recordCount.textContent = rows.length
  elements.openCount.textContent = rows.filter(row => row.is_open).length
  elements.missingCount.textContent = rows.filter(row => row.is_missing_clock_out).length
  elements.overtimeCount.textContent = rows.filter(row => Number(row.total_overtime_minutes) > 0).length
}

function renderTable() {
  const rows = filteredRows()
  const showActions = canCorrectAttendance()
  elements.actionHeader.hidden = !showActions
  elements.tableBody.replaceChildren()

  if (!rows.length) {
    const row = document.createElement('tr')
    const cell = document.createElement('td')
    cell.colSpan = showActions ? 17 : 16
    cell.className = 'wf-empty'
    cell.textContent = 'No attendance records match the selected filters.'
    row.appendChild(cell)
    elements.tableBody.appendChild(row)
  } else {
    rows.forEach(record => {
      const row = document.createElement('tr')
      if (record.is_open) row.classList.add('is-open')
      if (record.is_missing_clock_out) row.classList.add('is-missing-clock-out')

      const scheduleSecondary = [
        record.schedule_status === 'changed' ? 'Changed schedule' : '',
        record.shift_sequence ? `Shift ${record.shift_sequence}` : ''
      ].filter(Boolean).join(' · ')

      const clockOutSecondary = record.is_missing_clock_out
        ? 'Required review'
        : record.is_open
          ? 'Session in progress'
          : ''

      const correctionSecondary = [
        CORRECTION_REASON_LABELS[record.correction_reason] || record.correction_reason,
        record.admin_notes
      ].filter(Boolean).join(' · ')

      const cells = [
        createEmployeeCell(record),
        createCell(record.team_name || 'Unassigned'),
        createCell(formatDate(record.work_date), '', 'compact'),
        createCell(formatShift(record), scheduleSecondary),
        createCell(formatDateTime(record.clock_in, record.employee_timezone)),
        createCell(formatDateTime(record.clock_out, record.employee_timezone), clockOutSecondary),
        createMinutesCell(record.regular_minutes, `Worked ${formatMinutes(record.total_worked_minutes)}`),
        createMinutesCell(record.pre_shift_overtime_minutes),
        createMinutesCell(record.post_shift_overtime_minutes),
        createMinutesCell(record.total_overtime_minutes),
        createMinutesCell(record.minutes_late),
        createMinutesCell(record.undertime_minutes),
        createAttendanceStatusCell(record),
        createCorrectionStatusCell(record),
        createCell(record.corrected_by_name || '—', correctionSecondary),
        createCell(formatDateTime(record.corrected_at, record.employee_timezone, true))
      ]

      if (showActions) cells.push(createActionCell(record))
      row.append(...cells)
      elements.tableBody.appendChild(row)
    })
  }

  renderSummary(rows)
  setMessage(
    elements.tableMessage,
    `${rows.length} of ${attendanceRows.length} attendance record${attendanceRows.length === 1 ? '' : 's'} shown.`
  )
}

function populateFilters() {
  const selectedEmployee = elements.employeeFilter.value
  const selectedTeam = elements.teamFilter.value

  elements.employeeFilter.replaceChildren(new Option('All authorized employees', ''))
  employees.forEach(employee => {
    const label = employee.employee_id
      ? `${employee.full_name} · ${employee.employee_id}`
      : employee.full_name
    elements.employeeFilter.appendChild(new Option(label, employee.user_id))
  })

  elements.teamFilter.replaceChildren(new Option('All authorized teams', ''))
  teams.forEach(team => {
    elements.teamFilter.appendChild(new Option(team.name, team.id))
  })

  if ([...elements.employeeFilter.options].some(option => option.value === selectedEmployee)) {
    elements.employeeFilter.value = selectedEmployee
  }
  if ([...elements.teamFilter.options].some(option => option.value === selectedTeam)) {
    elements.teamFilter.value = selectedTeam
  }
}

async function loadReferenceData() {
  const [profileResult, teamResult] = await Promise.all([
    supabase
      .from('profiles')
      .select('user_id, full_name, email, employee_id, team_id, timezone, employment_status')
      .order('full_name'),
    supabase
      .from('teams')
      .select('id, name, is_active')
      .order('name')
  ])

  if (profileResult.error) throw profileResult.error
  if (teamResult.error) throw teamResult.error

  employees = (profileResult.data || [])
    .filter(profile => access.is_admin === true || profile.user_id !== access.user_id)

  const permittedTeamIds = new Set(employees.map(profile => profile.team_id).filter(Boolean))
  teams = (teamResult.data || []).filter(team => permittedTeamIds.has(team.id))
  populateFilters()
}

function mergeAttendanceReferences(rows) {
  const employeeIds = new Set(employees.map(employee => employee.user_id))
  const teamIds = new Set(teams.map(team => team.id))

  rows.forEach(row => {
    if (row.employee_user_id && !employeeIds.has(row.employee_user_id)) {
      employees.push({
        user_id: row.employee_user_id,
        full_name: row.employee_name || 'Unknown employee',
        email: row.employee_email || '',
        employee_id: row.employee_id || '',
        team_id: row.team_id || null,
        timezone: row.employee_timezone || access?.timezone || 'Asia/Manila'
      })
      employeeIds.add(row.employee_user_id)
    }

    if (row.team_id && !teamIds.has(row.team_id)) {
      teams.push({ id: row.team_id, name: row.team_name || 'Unnamed team' })
      teamIds.add(row.team_id)
    }
  })

  employees.sort((left, right) => left.full_name.localeCompare(right.full_name))
  teams.sort((left, right) => left.name.localeCompare(right.name))
  populateFilters()
}

async function loadAttendance() {
  const range = validateDateRange()
  setMessage(elements.filterMessage, 'Loading authorized attendance records...')

  const { data, error } = await supabase.rpc('workforce_list_team_attendance', {
    p_start_date: range.start,
    p_end_date: range.end
  })

  if (error) throw error
  attendanceRows = data || []
  mergeAttendanceReferences(attendanceRows)
  renderTable()
  setMessage(elements.filterMessage, `Attendance loaded for ${formatDate(range.start)} through ${formatDate(range.end)}.`, 'success')
}

function setBusy(value) {
  busy = value
  elements.refreshButton.disabled = value
  elements.resetButton.disabled = value
  elements.refreshButton.textContent = value ? 'Refreshing...' : 'Refresh'
}

async function refreshAttendance() {
  if (busy) return
  setBusy(true)

  try {
    await loadAttendance()
  } catch (error) {
    setMessage(elements.filterMessage, errorMessage(error), 'error')
    setMessage(elements.tableMessage, errorMessage(error), 'error')
  } finally {
    setBusy(false)
  }
}

async function resetFilters() {
  const range = defaultDateRange()
  elements.startDate.value = range.start
  elements.endDate.value = range.end
  elements.employeeFilter.value = ''
  elements.teamFilter.value = ''
  elements.statusFilter.value = ''
  elements.correctedFilter.value = ''
  elements.openFilter.checked = false
  elements.missingFilter.checked = false
  elements.overtimeFilter.checked = false
  await refreshAttendance()
}

function setCorrectionBusy(value) {
  correctionBusy = value
  elements.correctionSaveButton.disabled = value
  elements.correctionSchedule.disabled = value
  elements.correctionStatus.disabled = value
  elements.correctionSaveButton.textContent = value ? 'Saving...' : 'Save Correction'
}

function openCorrectionModal() {
  lastFocusedElement = document.activeElement
  elements.correctionModal.hidden = false
  document.body.classList.add('modal-open')
  requestAnimationFrame(() => elements.correctionStatus.focus())
}

function closeCorrectionModal() {
  if (correctionBusy) return
  elements.correctionModal.hidden = true
  document.body.classList.remove('modal-open')
  elements.correctionForm.reset()
  correctionRecord = null
  setMessage(elements.correctionMessage, '')
  if (lastFocusedElement instanceof HTMLElement) lastFocusedElement.focus()
}

function syncCorrectionStatusFields() {
  const isPresent = elements.correctionStatus.value === 'present'
  elements.correctionClockIn.disabled = !isPresent
  elements.correctionClockOut.disabled = !isPresent
  elements.correctionClockIn.required = isPresent

  if (!isPresent) {
    elements.correctionClockIn.value = ''
    elements.correctionClockOut.value = ''
  }
}

function syncCorrectionReasonFields() {
  const requiresNotes = elements.correctionReason.value === 'other'
  elements.correctionReasonNotes.required = requiresNotes
  elements.correctionReasonNotes.placeholder = requiresNotes
    ? 'Explain the correction reason'
    : 'Optional supporting details'
}

async function loadCorrectionSchedules(record) {
  elements.correctionSchedule.disabled = true
  elements.correctionSchedule.replaceChildren(new Option('Loading eligible schedules...', ''))

  const { data, error } = await supabase.rpc('workforce_list_attendance_correction_schedules', {
    p_attendance_id: record.attendance_id
  })

  if (error) throw error

  elements.correctionSchedule.replaceChildren(new Option('Unscheduled', ''))
  for (const schedule of data || []) {
    elements.correctionSchedule.appendChild(new Option(
      formatCorrectionScheduleOption(schedule, record),
      schedule.schedule_id
    ))
  }

  elements.correctionSchedule.value = record.schedule_id || ''
  elements.correctionSchedule.disabled = false
}

async function openCorrection(record) {
  if (!canCorrectAttendance() || record.review_status === 'locked') return

  correctionRecord = record
  elements.correctionId.value = record.attendance_id
  elements.correctionSummary.textContent = `${record.employee_name} · ${formatDate(record.work_date)} · ${record.employee_timezone}`
  elements.correctionStatus.value = record.attendance_status || 'present'
  elements.correctionClockIn.value = formatDateTimeLocalInput(record.clock_in, record.employee_timezone)
  elements.correctionClockOut.value = formatDateTimeLocalInput(record.clock_out, record.employee_timezone)
  elements.correctionAdminNotes.value = record.admin_notes || ''
  elements.correctionReason.value = ''
  elements.correctionReasonNotes.value = ''
  elements.correctionApprovalNote.textContent = canApproveAttendance()
    ? 'Complete corrected records will be approved automatically because you also have attendance approval access.'
    : 'The record will be marked Corrected and will remain unapproved because you do not have attendance approval access.'
  syncCorrectionStatusFields()
  syncCorrectionReasonFields()
  setMessage(elements.correctionMessage, 'Loading eligible schedules...')
  openCorrectionModal()

  try {
    await loadCorrectionSchedules(record)
    setMessage(elements.correctionMessage, '')
  } catch (error) {
    setMessage(elements.correctionMessage, errorMessage(error), 'error')
  }
}

async function saveCorrection(event) {
  event.preventDefault()
  if (correctionBusy || !correctionRecord) return

  const reasonCode = elements.correctionReason.value
  const reasonNotes = normalizeText(elements.correctionReasonNotes.value)
  const attendanceStatus = elements.correctionStatus.value
  const clockIn = elements.correctionClockIn.value || null
  const clockOut = elements.correctionClockOut.value || null

  if (!reasonCode) {
    setMessage(elements.correctionMessage, 'Select a correction reason.', 'error')
    return
  }

  if (reasonCode === 'other' && !reasonNotes) {
    setMessage(elements.correctionMessage, 'Reason notes are required when Other is selected.', 'error')
    return
  }

  if (attendanceStatus === 'present' && !clockIn) {
    setMessage(elements.correctionMessage, 'Present attendance requires an effective clock-in.', 'error')
    return
  }

  if (clockIn && clockOut && clockOut < clockIn) {
    setMessage(elements.correctionMessage, 'Clock-out cannot be earlier than clock-in.', 'error')
    return
  }

  setCorrectionBusy(true)
  setMessage(elements.correctionMessage, 'Saving correction and recalculating attendance...')

  try {
    const { data, error } = await supabase.rpc('workforce_correct_attendance', {
      p_attendance_id: correctionRecord.attendance_id,
      p_clock_in_local: attendanceStatus === 'present' ? clockIn : null,
      p_clock_out_local: attendanceStatus === 'present' ? clockOut : null,
      p_attendance_status: attendanceStatus,
      p_schedule_id: elements.correctionSchedule.value || null,
      p_admin_notes: normalizeText(elements.correctionAdminNotes.value) || null,
      p_reason_code: reasonCode,
      p_reason_notes: reasonNotes || null
    })

    if (error) throw error

    const reviewStatus = data?.review_status || 'corrected'
    setMessage(
      elements.correctionMessage,
      reviewStatus === 'approved'
        ? 'Attendance corrected, recalculated, and approved.'
        : 'Attendance corrected and recalculated. Approval is still required.',
      'success'
    )

    await refreshAttendance()
    window.setTimeout(() => closeCorrectionModal(), 500)
  } catch (error) {
    setMessage(elements.correctionMessage, errorMessage(error), 'error')
  } finally {
    setCorrectionBusy(false)
  }
}

function bindEvents() {
  elements.refreshButton.addEventListener('click', refreshAttendance)
  elements.resetButton.addEventListener('click', resetFilters)

  for (const element of [
    elements.employeeFilter,
    elements.teamFilter,
    elements.statusFilter,
    elements.correctedFilter,
    elements.openFilter,
    elements.missingFilter,
    elements.overtimeFilter
  ]) {
    element.addEventListener('change', renderTable)
  }

  elements.correctionStatus.addEventListener('change', syncCorrectionStatusFields)
  elements.correctionReason.addEventListener('change', syncCorrectionReasonFields)
  elements.correctionForm.addEventListener('submit', saveCorrection)

  document.querySelectorAll('[data-correction-close]').forEach(button => {
    button.addEventListener('click', closeCorrectionModal)
  })

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !elements.correctionModal.hidden) {
      closeCorrectionModal()
    }
  })
}

async function initialize() {
  access = await loadCurrentWorkforceAccess(supabase)

  if (!access.authenticated) {
    window.location.replace(`./login.html?returnTo=${encodeURIComponent('./team-attendance.html')}`)
    return
  }

  if (!access.allowed || !hasWorkforcePermission(access, 'view_team_attendance')) {
    window.alert('You do not have permission to view team attendance.')
    window.location.replace('./home.html')
    return
  }

  elements.workforceLink.hidden = !(
    access.is_admin === true && hasWorkforcePermission(access, 'manage_employees')
  )

  elements.scope.textContent = access.is_admin === true
    ? 'Showing attendance for all employees permitted by your administrator access.'
    : 'Showing only employees assigned to your authorized supervisor scope.'

  elements.tableNote.textContent = canCorrectAttendance()
    ? 'Clock-in and clock-out are effective values. Use Correct to update authorized records through the audited server workflow.'
    : 'Clock-in and clock-out are effective values. Your attendance access is read-only.'

  elements.correctionApprovalNote.textContent = canApproveAttendance()
    ? 'Complete corrected records will be approved automatically.'
    : 'Corrected records will remain unapproved.'

  const range = defaultDateRange()
  elements.startDate.value = range.start
  elements.endDate.value = range.end
  bindEvents()

  await loadReferenceData()
  await refreshAttendance()
}

initialize().catch(error => {
  console.error('Team attendance initialization failed:', error)
  setMessage(elements.filterMessage, errorMessage(error), 'error')
  setMessage(elements.tableMessage, errorMessage(error), 'error')
})
