import { supabase } from './supabaseClient.js?v=11'
import {
  hasWorkforcePermission,
  loadCurrentWorkforceAccess,
  redactAttendanceCorrectionForViewer
} from './workforce-permissions.js?v=2'
import { formatScheduleOptionLabel } from '../shared/schedule-labels.js?v=1'

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
const ATTENDANCE_PAGE_SIZE = 5
const WORKFORCE_TIMEZONE = 'America/New_York'
const OPEN_SESSION_LIMIT_MINUTES = 20 * 60

const elements = {
  workforceLink: document.getElementById('teamAttendanceWorkforceLink'),
  recordCount: document.getElementById('teamAttendanceRecordCount'),
  openCount: document.getElementById('teamAttendanceOpenCount'),
  missingCount: document.getElementById('teamAttendanceMissingCount'),
  overtimeCount: document.getElementById('teamAttendanceOvertimeCount'),
  billedHours: document.getElementById('teamAttendanceBilledHours'),
  scope: document.getElementById('teamAttendanceScope'),
  search: document.getElementById('teamAttendanceSearch'),
  startDate: document.getElementById('teamAttendanceStartDate'),
  endDate: document.getElementById('teamAttendanceEndDate'),
  employeeFilter: document.getElementById('teamAttendanceEmployeeFilter'),
  teamFilter: document.getElementById('teamAttendanceTeamFilter'),
  statusFilter: document.getElementById('teamAttendanceStatusFilter'),
  correctedFilter: document.getElementById('teamAttendanceCorrectedFilter'),
  unscheduledFilter: document.getElementById('teamAttendanceUnscheduledFilter'),
  openFilter: document.getElementById('teamAttendanceOpenFilter'),
  missingFilter: document.getElementById('teamAttendanceMissingFilter'),
  overtimeFilter: document.getElementById('teamAttendanceOvertimeFilter'),
  voidedHistory: document.getElementById('teamAttendanceVoidedHistory'),
  resetButton: document.getElementById('teamAttendanceResetButton'),
  refreshButton: document.getElementById('teamAttendanceRefreshButton'),
  addButton: document.getElementById('teamAttendanceAddButton'),
  filterMessage: document.getElementById('teamAttendanceFilterMessage'),
  tableBody: document.getElementById('teamAttendanceTableBody'),
  tableMessage: document.getElementById('teamAttendanceTableMessage'),
  pagination: document.getElementById('teamAttendancePagination'),
  pageInfo: document.getElementById('teamAttendancePageInfo'),
  previousPage: document.getElementById('teamAttendancePreviousPage'),
  nextPage: document.getElementById('teamAttendanceNextPage')
}

let access = null
let employees = []
let teams = []
let attendanceRows = []
let busy = false
let attendancePage = 1
let attendanceQuickFilter = 'all'
let pendingDelete = null
let voidedRows = []
let showVoidedHistory = false
let pendingRestore = null

function errorMessage(error) {
  const message = error?.message || ''
  if (/attendance_structured_totals_check/i.test(message)) {
    return 'The correction could not be applied because the recalculated attendance totals were inconsistent. Review the billed timestamps and assigned shift, then try again.'
  }
  return message || 'An unexpected error occurred.'
}

function setMessage(element, text, type = '') {
  element.textContent = text
  element.className = type ? `wf-message ${type}` : 'wf-message'
}

function correctionScheduleDates(workDate) {
  if (!workDate) return []
  const [year, month, day] = workDate.split('-').map(Number)
  const previousDate = new Date(Date.UTC(year, month - 1, day - 1))
    .toISOString()
    .slice(0, 10)
  return [workDate, previousDate]
}

function formatCorrectionScheduleLabel(schedule) {
  const date = schedule?.shift_date
    ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(
        new Date(`${schedule.shift_date}T12:00:00Z`)
      )
    : 'Date unavailable'
  const type = schedule?.is_leave
    ? 'Leave'
    : schedule?.is_absent
      ? 'Absence'
      : schedule?.is_rest_day
        ? 'Rest Day'
        : schedule?.is_holiday
          ? 'Holiday'
          : schedule?.shift_start && schedule?.shift_end
            ? 'Work Schedule'
            : 'Open Schedule'
  const sequence = `Sequence ${schedule?.shift_sequence || 1}`
  const timezone = schedule?.timezone || WORKFORCE_TIMEZONE
  const timed = schedule?.shift_start && schedule?.shift_end
  const time = timed
    ? ` · ${new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(new Date(schedule.shift_start))} – ${new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(new Date(schedule.shift_end))}`
    : ''
  return `${date} · ${type} · ${sequence}${time}`
}

function isCorrectionOpenSchedule(schedule) {
  return Boolean(schedule)
    && !schedule.is_rest_day
    && !schedule.is_holiday
    && schedule.shift_start == null
    && schedule.shift_end == null
}

function isEligibleCorrectionSchedule(schedule, workDate) {
  if (!schedule || schedule.is_leave || schedule.is_absent) return false
  if (!['published', 'changed'].includes(schedule.status)) return false
  if (schedule.is_rest_day || schedule.is_holiday) return true
  if (schedule.shift_start && schedule.shift_end) return true
  return isCorrectionOpenSchedule(schedule) && schedule.shift_date === workDate
}

async function persistOverDurationFlagsBeforeTeamListing() {
  if (access?.is_admin === true) {
    const { error } = await supabase.rpc('workforce_flag_open_attendance_over_duration')
    if (error) {
      console.error('Unable to persist open-session over-duration flags:', error)
    }
    return
  }
  if (access?.is_agent !== true) return

  const { error } = await supabase.rpc('workforce_flag_current_open_attendance_over_duration')
  if (error && error.code !== 'P0002') {
    console.error('Unable to persist the over-duration attendance flag:', error)
  }
}

function localDateKey(date = new Date(), timezone = WORKFORCE_TIMEZONE) {
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
  const [year, month, day] = today.split('-').map(Number)
  const periodStart = day <= 15 ? '01' : '16'
  const periodEnd = day <= 15
    ? '15'
    : String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')
  const monthKey = today.slice(0, 7)

  return {
    start: `${monthKey}-${periodStart}`,
    end: `${monthKey}-${periodEnd}`
  }
}

function defaultAgentDateRange() {
  const today = localDateKey()
  const yesterday = new Date(parseDateKey(today).getTime() - 86400000)
    .toISOString()
    .slice(0, 10)
  return { start: yesterday, end: today }
}

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function isValidDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = parseDateKey(value)
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
}

function parseDateKey(value) {
  const [year, month, day] = String(value).split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

function dateRangeDays(start, end) {
  return Math.floor((parseDateKey(end) - parseDateKey(start)) / 86400000)
}

function payrollAttendanceLinkFilters() {
  const params = new URLSearchParams(window.location.search)
  const employee = params.get('employee') || ''
  const start = params.get('start') || ''
  const end = params.get('end') || ''

  if (
    params.get('source') !== 'payroll-missing' ||
    !isValidUuid(employee) ||
    !isValidDateKey(start) ||
    !isValidDateKey(end) ||
    end < start ||
    dateRangeDays(start, end) > 366
  ) {
    return null
  }

  return { employee, start, end }
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
    timeZone: WORKFORCE_TIMEZONE,
    ...(includeDate ? { month: 'short', day: 'numeric', year: 'numeric' } : {}),
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(value))
}

function toDateTimeLocal(value) {
  if (!value) return ''
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: WORKFORCE_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(value))
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}`
}

function timezoneOffsetMilliseconds(timestamp) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: WORKFORCE_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(timestamp))
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]))
  const wallClockAsUtc = Date.UTC(
    Number(fields.year), Number(fields.month) - 1, Number(fields.day),
    Number(fields.hour), Number(fields.minute), Number(fields.second)
  )
  return wallClockAsUtc - timestamp
}

function dateTimeLocalToIso(value) {
  if (!value) return null
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/)
  if (!match) throw new Error('Enter a valid date and time.')
  const [, year, month, day, hour, minute] = match.map(Number)
  const wallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute)
  let timestamp = wallClockAsUtc - timezoneOffsetMilliseconds(wallClockAsUtc)
  timestamp = wallClockAsUtc - timezoneOffsetMilliseconds(timestamp)
  return new Date(timestamp).toISOString()
}

function shiftIsoByWorkforceDays(timestamp, days) {
  const localValue = toDateTimeLocal(timestamp)
  if (!localValue) return null
  const [dateValue, timeValue] = localValue.split('T')
  const shiftedDate = parseDateKey(dateValue)
  shiftedDate.setUTCDate(shiftedDate.getUTCDate() + days)
  return dateTimeLocalToIso(`${shiftedDate.toISOString().slice(0, 10)}T${timeValue}`)
}

function intervalOverlapMinutes(clockInIso, clockOutIso, schedule) {
  if (!clockInIso || !clockOutIso || !schedule?.shift_start || !schedule?.shift_end) return 0
  const clockIn = new Date(clockInIso).getTime()
  const clockOut = new Date(clockOutIso).getTime()
  const scheduleStart = new Date(schedule.shift_start).getTime()
  const scheduleEnd = new Date(schedule.shift_end).getTime()
  const overlapStart = Math.max(clockIn, scheduleStart)
  const overlapEnd = Math.min(clockOut, scheduleEnd)
  return Math.max(0, Math.floor((overlapEnd - overlapStart) / 60000))
}

function correctionScheduleAnalysis({ clockInIso, clockOutIso, schedule }) {
  if (!clockInIso || !clockOutIso || !schedule?.shift_start || !schedule?.shift_end) {
    return { applicable: false, overlapMinutes: null, requiresConfirmation: false }
  }

  const overlapMinutes = intervalOverlapMinutes(clockInIso, clockOutIso, schedule)
  if (overlapMinutes > 0) {
    return { applicable: true, overlapMinutes, requiresConfirmation: false }
  }

  const shiftedCandidates = [-1, 1].map(days => {
    const shiftedClockIn = shiftIsoByWorkforceDays(clockInIso, days)
    const shiftedClockOut = shiftIsoByWorkforceDays(clockOutIso, days)
    return {
      days,
      overlapMinutes: intervalOverlapMinutes(shiftedClockIn, shiftedClockOut, schedule)
    }
  })
  const likelyMismatch = shiftedCandidates
    .filter(candidate => candidate.overlapMinutes >= 60)
    .sort((left, right) => right.overlapMinutes - left.overlapMinutes)[0] || null

  return {
    applicable: true,
    overlapMinutes: 0,
    requiresConfirmation: true,
    likelyMismatch: Boolean(likelyMismatch),
    likelyMismatchDays: likelyMismatch?.days || null,
    likelyMismatchOverlapMinutes: likelyMismatch?.overlapMinutes || 0
  }
}

function correctionClassificationPreview({ clockInIso, clockOutIso, schedule }) {
  if (!clockInIso || !clockOutIso || !schedule?.shift_start || !schedule?.shift_end) return null
  const clockIn = new Date(clockInIso).getTime()
  const clockOut = new Date(clockOutIso).getTime()
  const scheduleStart = new Date(schedule.shift_start).getTime()
  const scheduleEnd = new Date(schedule.shift_end).getTime()
  const totalMinutes = Math.max(0, Math.floor((clockOut - clockIn) / 60000))
  const preShiftMinutes = clockIn < scheduleStart
    ? Math.max(0, Math.floor((Math.min(clockOut, scheduleStart) - clockIn) / 60000))
    : 0
  const postShiftMinutes = clockOut > scheduleEnd
    ? Math.max(0, Math.floor((clockOut - Math.max(clockIn, scheduleEnd)) / 60000))
    : 0
  return {
    regularMinutes: Math.max(0, totalMinutes - preShiftMinutes - postShiftMinutes),
    preShiftMinutes,
    postShiftMinutes,
    totalMinutes
  }
}

function formatMinutes(value) {
  if (value === null || value === undefined) return 'Pending'
  const safeMinutes = Math.max(0, Number(value) || 0)
  const hours = Math.floor(safeMinutes / 60)
  const minutes = safeMinutes % 60
  if (!hours) return `${minutes}m`
  return `${hours}h ${minutes}m`
}

function formatOptionalMinutes(value) {
  if (value === null || value === undefined) return '—'
  return formatMinutes(value)
}

function hasBilledOverride(record) {
  if (record?.is_corrected === true) return true
  return Boolean(record?.billed_clock_in && record?.billed_clock_out
    && (record.billed_clock_in !== (record.original_clock_in || record.clock_in)
      || record.billed_clock_out !== (record.original_clock_out || record.clock_out)))
}

function effectiveAttendanceClocks(record) {
  const originalClockIn = record?.original_clock_in || record?.clock_in || null
  const originalClockOut = record?.original_clock_out || record?.clock_out || null
  if (!hasBilledOverride(record)) {
    return { renderedClockIn: originalClockIn, renderedClockOut: originalClockOut, billedClockIn: originalClockIn, billedClockOut: originalClockOut }
  }
  return {
    renderedClockIn: originalClockIn,
    renderedClockOut: originalClockOut,
    billedClockIn: record?.billed_clock_in || null,
    billedClockOut: record?.billed_clock_out || null
  }
}

function durationMinutes(clockIn, clockOut) {
  if (!clockIn || !clockOut) return 0
  return Math.max(0, Math.round((new Date(clockOut).getTime() - new Date(clockIn).getTime()) / 60000))
}

function hasExceededOpenSessionLimit(clockIn, now = new Date()) {
  return durationMinutes(clockIn, now.toISOString()) > OPEN_SESSION_LIMIT_MINUTES
}

function classifyOpenSession(record, now = new Date()) {
  const clockIn = record?.original_clock_in || record?.clock_in || null
  const clockOut = record?.original_clock_out || record?.clock_out || null
  if (!clockIn || clockOut) {
    return {
      is_open: false,
      is_missing_clock_out: false,
      is_over_duration: record?.manager_review_reason === 'open_session_over_20_hours'
    }
  }

  return {
    // The soft maximum never changes the actual open-session state. The
    // server-backed reason is authoritative after the list RPC; the elapsed
    // fallback keeps the live card responsive between refreshes.
    is_open: true,
    is_missing_clock_out: Boolean(record.is_missing_clock_out),
    is_over_duration: record.manager_review_reason === 'open_session_over_20_hours' ||
      hasExceededOpenSessionLimit(clockIn, now)
  }
}

function attendanceHours(record) {
  const clocks = effectiveAttendanceClocks(record)
  return {
    renderedMinutes: durationMinutes(clocks.renderedClockIn, clocks.renderedClockOut),
    billedMinutes: durationMinutes(clocks.billedClockIn, clocks.billedClockOut)
  }
}

function prepaidStatusLabel(value, appliedMinutes = 0) {
  const labels = {
    open: 'Open',
    partially_settled: 'Partially settled',
    settled: 'Settled',
    void: 'Void'
  }

  if (labels[value]) return labels[value]
  if (Number(appliedMinutes) > 0) return 'Applied to prior balance'
  return 'Not prepaid'
}

function formatShift(row) {
  if (!row.schedule_id) return 'Unscheduled'
  if (!row.scheduled_start || !row.scheduled_end) return 'Shift unavailable'
  const timezone = row.schedule_timezone || row.employee_timezone || access?.timezone
  return `${formatDateTime(row.scheduled_start, timezone)} – ${formatDateTime(row.scheduled_end, timezone)}`
}

function statusBadgeClass(status) {
  if (status === 'present' || status === 'approved' || status === 'locked') return 'success'
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
  if (row.is_over_duration) labels.push({ label: 'Over 20h · Review', modifier: 'danger' })
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

function createActionCell(row) {
  const cell = document.createElement('td')
  const actions = document.createElement('div')
  actions.className = 'wf-row-actions'

  const correctButton = document.createElement('button')
  correctButton.type = 'button'
  correctButton.className = 'wf-btn secondary compact'
  correctButton.textContent = row.schedule_id ? 'Edit' : 'Assign Schedule'
  correctButton.disabled = !access?.can_correct_attendance || !row.employee_user_id || row.review_status === 'locked'
  correctButton.addEventListener('click', () => openCorrectionModal(row))
  actions.appendChild(correctButton)

  if (access?.can_approve_attendance && ['pending', 'corrected'].includes(row.review_status)) {
    const approveButton = document.createElement('button')
    approveButton.type = 'button'
    approveButton.className = 'wf-btn primary compact'
    approveButton.textContent = 'Approve'
    approveButton.disabled = row.is_open || row.is_missing_clock_out || !row.employee_user_id
    approveButton.addEventListener('click', () => reviewAttendance(row, 'approved', approveButton))
    actions.appendChild(approveButton)
  }

  if (access?.can_approve_attendance && row.review_status === 'approved') {
    const lockButton = document.createElement('button')
    lockButton.type = 'button'
    lockButton.className = 'wf-btn danger compact'
    lockButton.textContent = 'Lock'
    lockButton.addEventListener('click', () => reviewAttendance(row, 'locked', lockButton))
    actions.appendChild(lockButton)
  }

  if (access?.is_admin === true && hasWorkforcePermission(access, 'manage_schedules') && row.review_status !== 'locked') {
    const deleteButton = document.createElement('button')
    deleteButton.type = 'button'
    deleteButton.className = 'wf-btn danger compact'
    deleteButton.textContent = 'Delete'
    deleteButton.addEventListener('click', () => openDeleteModal(row, deleteButton))
    actions.appendChild(deleteButton)
  }

  cell.appendChild(actions)
  return cell
}

async function reviewAttendance(row, reviewStatus, button) {
  if (!row.attendance_id || busy) return

  const searchValue = elements.search.value
  const isLock = reviewStatus === 'locked'
  const action = isLock ? 'Lock' : 'Approve'
  const warning = isLock
    ? ' This is final: locked attendance cannot be corrected or deleted.'
    : ''
  const confirmed = window.confirm(
    `${action} ${row.employee_name || 'this employee'}'s attendance for ${formatDate(row.work_date)}?${warning}`
  )
  if (!confirmed) return

  busy = true
  button.disabled = true
  button.textContent = isLock ? 'Locking...' : 'Approving...'
  setMessage(elements.tableMessage, `${action} attendance...`)

  try {
    const { error } = await supabase.rpc('workforce_review_attendance', {
      p_attendance_id: row.attendance_id,
      p_review_status: reviewStatus,
      p_review_notes: null
    })
    if (error) throw error

    await loadAttendance()
    elements.search.value = searchValue
    elements.search.disabled = false
    elements.search.readOnly = false
    elements.search.focus({ preventScroll: true })
    const searchCaret = elements.search.value.length
    elements.search.setSelectionRange(searchCaret, searchCaret)
    setMessage(elements.tableMessage, `Attendance ${reviewStatus} successfully.`, 'success')
  } catch (error) {
    setMessage(elements.tableMessage, errorMessage(error), 'error')
  } finally {
    busy = false
    button.disabled = false
    button.textContent = action
  }
}

function formatCorrectionDateTime(value, timezone) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('en-US', {
    timeZone: WORKFORCE_TIMEZONE,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(value))
}

function openDeleteModal(row, button) {
  if (!row.attendance_id || busy) return
  pendingDelete = { row, button }
  const modal = document.getElementById('teamAttendanceDeleteModal')
  document.getElementById('teamAttendanceDeleteSummary').textContent = `${row.employee_name || 'This employee'} · ${formatDate(row.work_date)}`
  document.getElementById('teamAttendanceDeleteReason').value = ''
  setMessage(document.getElementById('teamAttendanceDeleteMessage'), '')
  modal.hidden = false
  document.body.classList.add('modal-open')
  document.getElementById('teamAttendanceDeleteReason').focus()
}

function closeDeleteModal() {
  const modal = document.getElementById('teamAttendanceDeleteModal')
  if (!modal) return
  modal.hidden = true
  pendingDelete = null
  document.body.classList.remove('modal-open')
}

async function deleteAttendance() {
  const pending = pendingDelete
  const reasonElement = document.getElementById('teamAttendanceDeleteReason')
  const messageElement = document.getElementById('teamAttendanceDeleteMessage')
  if (!pending || !reasonElement || busy) return
  const reason = reasonElement.value.trim()
  if (reason.length < 3) {
    setMessage(messageElement, 'Enter a deletion reason of at least 3 characters.', 'error')
    reasonElement.focus()
    return
  }

  busy = true
  const submit = document.getElementById('teamAttendanceDeleteSubmit')
  submit.disabled = true
  submit.textContent = 'Deleting...'
  pending.button.disabled = true
  setMessage(elements.tableMessage, 'Deleting attendance record...')
  setMessage(messageElement, 'Deleting attendance record...')

  try {
    const { data, error } = await supabase.rpc('workforce_delete_attendance', {
      p_attendance_id: pending.row.attendance_id,
      p_reason: reason
    })

    if (error) throw error
    if (!data) throw new Error('Attendance record was not deleted. Check your permissions and try again.')

    const verification = await supabase.rpc('workforce_verify_attendance_void', {
      p_attendance_id: pending.row.attendance_id
    })
    if (verification.error) throw verification.error
    if (!verification.data?.[0]?.voided_at) {
      throw new Error('Attendance record was not deleted. Please try again or contact admin.')
    }

    closeDeleteModal()
    await loadAttendance()
    setMessage(elements.tableMessage, 'Attendance record deleted.', 'success')
  } catch (error) {
    setMessage(elements.tableMessage, errorMessage(error), 'error')
    setMessage(messageElement, errorMessage(error), 'error')
    pending.button.disabled = false
  } finally {
    busy = false
    submit.disabled = false
    submit.textContent = 'Confirm delete'
  }
}

function openRestoreModal(row, button) {
  if (!row?.attendance_id || busy) return
  pendingRestore = { row, button }
  const modal = document.getElementById('teamAttendanceRestoreModal')
  document.getElementById('teamAttendanceRestoreSummary').textContent = `${row.employee_name || 'This employee'} · ${formatDate(row.work_date)} · ${row.void_reason || 'No void reason recorded'}`
  document.getElementById('teamAttendanceRestoreReason').value = ''
  setMessage(document.getElementById('teamAttendanceRestoreMessage'), '')
  modal.hidden = false
  document.body.classList.add('modal-open')
  document.getElementById('teamAttendanceRestoreReason').focus()
}

function closeRestoreModal() {
  const modal = document.getElementById('teamAttendanceRestoreModal')
  if (!modal) return
  modal.hidden = true
  pendingRestore = null
  document.body.classList.remove('modal-open')
}

async function restoreAttendance() {
  const pending = pendingRestore
  const reasonElement = document.getElementById('teamAttendanceRestoreReason')
  const messageElement = document.getElementById('teamAttendanceRestoreMessage')
  if (!pending || !reasonElement || busy) return
  const reason = reasonElement.value.trim()
  if (reason.length < 3) {
    setMessage(messageElement, 'Enter a restore reason of at least 3 characters.', 'error')
    reasonElement.focus()
    return
  }

  busy = true
  const submit = document.getElementById('teamAttendanceRestoreSubmit')
  submit.disabled = true
  submit.textContent = 'Restoring...'
  if (pending.button) pending.button.disabled = true
  setMessage(elements.tableMessage, 'Restoring attendance record...')
  setMessage(messageElement, 'Restoring attendance record...')

  try {
    const { data, error } = await supabase.rpc('workforce_restore_attendance', {
      p_attendance_id: pending.row.attendance_id,
      p_reason: reason
    })
    if (error) throw error
    if (!data) throw new Error('Attendance record was not restored. Check your permissions and try again.')

    closeRestoreModal()
    await loadAttendance()
    setMessage(elements.tableMessage, 'Attendance record restored.', 'success')
  } catch (error) {
    setMessage(elements.tableMessage, errorMessage(error), 'error')
    setMessage(messageElement, errorMessage(error), 'error')
    if (pending.button) pending.button.disabled = false
  } finally {
    busy = false
    submit.disabled = false
    submit.textContent = 'Restore attendance'
  }
}

function filteredRows() {
  const search = elements.search.value.trim().toLowerCase()
  const employeeId = elements.employeeFilter.value
  const teamId = elements.teamFilter.value
  const status = elements.statusFilter.value
  const corrected = elements.correctedFilter.value
  const scheduleFilter = elements.unscheduledFilter?.value || ''
  const openOnly = elements.openFilter.checked
  const missingOnly = elements.missingFilter.checked
  const overtimeOnly = elements.overtimeFilter.checked

  if (showVoidedHistory) {
    return voidedRows.filter(row => {
      if (search && ![row.employee_name, row.employee_id, row.employee_email]
        .some(value => String(value || '').toLowerCase().includes(search))) return false
      if (employeeId && row.employee_user_id !== employeeId) return false
      if (status && row.attendance_status !== status) return false
      return true
    })
  }

  return attendanceRows.filter(row => {
    if (row.review_status === 'voided') return false
    if (search && ![row.employee_name, row.employee_id, row.employee_email]
      .some(value => String(value || '').toLowerCase().includes(search))) return false
    if (attendanceQuickFilter === 'open' && !row.is_open) return false
    if (attendanceQuickFilter === 'missing' && !row.is_missing_clock_out) return false
    if (attendanceQuickFilter === 'overtime' && Number(row.total_overtime_minutes) <= 0) return false
    if (attendanceQuickFilter === 'review' && row.review_status !== 'pending' && !row.is_missing_clock_out && !row.is_over_duration) return false
    if (employeeId && row.employee_user_id !== employeeId) return false
    if (teamId && row.team_id !== teamId) return false
    if (status && row.attendance_status !== status) return false
    if (corrected === 'corrected' && !row.is_corrected) return false
    if (corrected === 'not_corrected' && row.is_corrected) return false
    if (scheduleFilter === 'unscheduled' && row.schedule_id) return false
    if (scheduleFilter === 'scheduled' && !row.schedule_id) return false
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
  elements.billedHours.textContent = formatMinutes(rows.reduce(
    (total, row) => total + attendanceHours(row).billedMinutes,
    0
  ))
}

function initials(value) {
  return String(value || '?').trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase()
}

function minutesOfDay(value, timezone) {
  if (!value) return null
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: WORKFORCE_TIMEZONE,
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(value))
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return Number(values.hour) * 60 + Number(values.minute)
}

function addMeta(parent, primary, secondary) {
  const item = document.createElement('div')
  item.className = 'team-attendance-meta'
  const strong = document.createElement('strong')
  strong.textContent = primary || '—'
  const span = document.createElement('span')
  span.textContent = secondary
  item.append(strong, span)
  parent.appendChild(item)
}

function addStat(parent, value, label) {
  const item = document.createElement('div')
  item.className = 'team-attendance-stat'
  const strong = document.createElement('strong')
  strong.textContent = formatMinutes(value)
  const span = document.createElement('span')
  span.textContent = label
  item.append(strong, span)
  parent.appendChild(item)
}

function addPrepaidValue(parent, value, label, modifier = '') {
  const item = document.createElement('div')
  item.className = `team-attendance-prepaid-value${modifier ? ` ${modifier}` : ''}`
  const strong = document.createElement('strong')
  strong.textContent = value
  const span = document.createElement('span')
  span.textContent = label
  item.append(strong, span)
  parent.appendChild(item)
}

function addBadge(parent, label, modifier) {
  const badge = document.createElement('span')
  badge.className = `wf-badge ${modifier}`
  badge.textContent = label
  parent.appendChild(badge)
}

function presentationStatus(record) {
  if (record.is_over_duration) return { label: 'Over 20h · Review', modifier: 'needs-review' }
  if (record.is_open) return { label: 'In progress', modifier: 'in-progress' }
  if (record.is_missing_clock_out) return { label: 'Missing clock-out', modifier: 'needs-review' }
  if (record.review_status === 'pending') return { label: 'Needs review', modifier: 'needs-review' }
  const workedMinutes = Number(record.total_worked_minutes) || 0
  const regularMinutes = Number(record.regular_minutes) || 0
  const overtimeMinutes = Number(record.total_overtime_minutes) || 0
  const hasUnclassifiedWorkedMinutes = workedMinutes > regularMinutes + overtimeMinutes

  if (workedMinutes >= 720 && regularMinutes === 0 && record.schedule_id && hasUnclassifiedWorkedMinutes) {
    return { label: 'Flagged', modifier: 'needs-review' }
  }
  if (overtimeMinutes > 0) return { label: 'Overtime', modifier: 'overtime' }
  return { label: 'Completed', modifier: 'completed' }
}

function createTimeline(record) {
  const timeline = document.createElement('div')
  timeline.className = 'team-attendance-timeline'
  const track = document.createElement('div')
  track.className = 'team-attendance-track'
  const timezone = record.schedule_timezone || record.employee_timezone
  const shiftStart = minutesOfDay(record.scheduled_start, timezone)
  const shiftEnd = minutesOfDay(record.scheduled_end, timezone)
  const workStart = minutesOfDay(record.clock_in, timezone)
  const workEnd = minutesOfDay(record.clock_out || (record.is_open ? new Date() : null), timezone)

  const addSegment = (className, start, end) => {
    if (start === null || end === null) return
    const adjustedEnd = end < start ? 1440 : end
    const segment = document.createElement('span')
    segment.className = className
    segment.style.left = `${Math.max(0, start) / 14.4}%`
    segment.style.width = `${Math.max(0.4, (Math.min(1440, adjustedEnd) - start) / 14.4)}%`
    track.appendChild(segment)
  }
  addSegment('team-attendance-shift-segment', shiftStart, shiftEnd)
  addSegment('team-attendance-work-segment', workStart, workEnd)
  timeline.appendChild(track)

  const labels = document.createElement('div')
  labels.className = 'team-attendance-timeline-labels'
  for (const label of ['12 AM', '6 AM', '12 PM', '6 PM', '12 AM']) {
    const span = document.createElement('span')
    span.textContent = label
    labels.appendChild(span)
  }
  timeline.appendChild(labels)
  return timeline
}

function createAttendanceCard(record) {
  const isAdminView = access?.is_admin === true
  const card = document.createElement('article')
  card.className = 'team-attendance-record'
  if (record.is_open) card.classList.add('is-open')
  if (record.is_missing_clock_out) card.classList.add('is-missing-clock-out')

  const top = document.createElement('div')
  top.className = 'team-attendance-record-top'
  const person = document.createElement('div')
  person.className = 'team-attendance-person'
  const avatar = document.createElement('span')
  avatar.className = 'team-attendance-avatar'
  avatar.textContent = initials(record.employee_name)
  const identity = document.createElement('div')
  const name = document.createElement('div')
  name.className = 'team-attendance-person-name'
  name.textContent = record.employee_name || 'Unknown employee'
  const sub = document.createElement('div')
  sub.className = 'team-attendance-person-sub'
  sub.textContent = record.team_name || 'Unassigned team'
  identity.append(name, sub)
  person.append(avatar, identity)
  const badges = document.createElement('div')
  badges.className = 'team-attendance-badges'
  const displayStatus = presentationStatus(record)
  card.classList.add(`status-${displayStatus.modifier}`)
  addBadge(badges, displayStatus.label, displayStatus.modifier)
  const actionMenu = document.createElement('details')
  actionMenu.className = 'team-attendance-record-actions'
  const actionSummary = document.createElement('summary')
  actionSummary.textContent = '•••'
  actionSummary.setAttribute('aria-label', `Actions for ${record.employee_name || 'attendance record'}`)
  actionSummary.title = [
    `Pre-shift OT: ${formatMinutes(record.pre_shift_overtime_minutes)}`,
    `Post-shift OT: ${formatMinutes(record.post_shift_overtime_minutes)}`,
    `Worked: ${formatMinutes(record.total_worked_minutes)}`,
    `Undertime: ${formatMinutes(record.undertime_minutes)}`
  ].join(' · ')
  actionMenu.append(actionSummary, createActionCell(record).firstElementChild)
  if (isAdminView) badges.appendChild(actionMenu)
  top.append(person, badges)

  const middle = document.createElement('div')
  middle.className = 'team-attendance-record-mid'
  addMeta(middle, formatDate(record.work_date), formatShift(record))
  const clocks = effectiveAttendanceClocks(record)
  const hours = attendanceHours(record)
  addMeta(middle, formatDateTime(clocks.renderedClockIn, record.employee_timezone), 'Original Clock-in')
  addMeta(middle, record.is_open ? 'In progress' : formatDateTime(clocks.renderedClockOut, record.employee_timezone), 'Original Clock-out')
  addMeta(middle, hasBilledOverride(record) && clocks.billedClockIn ? formatDateTime(clocks.billedClockIn, record.employee_timezone) : '—', 'Billed Clock-in')
  addMeta(middle, hasBilledOverride(record) && clocks.billedClockOut ? (record.is_open ? 'In progress' : formatDateTime(clocks.billedClockOut, record.employee_timezone)) : '—', 'Billed Clock-out')

  const stats = document.createElement('div')
  stats.className = 'team-attendance-stats'
  addStat(stats, record.regular_minutes, 'Regular')
  addStat(stats, record.total_overtime_minutes, 'Overtime')
  addStat(stats, record.minutes_late, 'Late')
  addStat(stats, hours.renderedMinutes, 'Total Rendered Hours')
  addStat(stats, hours.billedMinutes, 'Total Billed Hours')

  const summary = document.createElement('div')
  summary.className = 'team-attendance-summary'
  summary.appendChild(stats)
  const prepaid = document.createElement('details')
  prepaid.className = 'team-attendance-prepaid'
  const prepaidTitle = document.createElement('summary')
  prepaidTitle.className = 'team-attendance-prepaid-title'
  prepaidTitle.setAttribute('aria-label', 'Prepaid reconciliation')
  prepaidTitle.setAttribute('aria-expanded', 'false')
  const prepaidCaret = document.createElement('span')
  prepaidCaret.className = 'team-attendance-prepaid-caret'
  prepaidCaret.setAttribute('aria-hidden', 'true')
  const prepaidLabel = document.createElement('span')
  prepaidLabel.textContent = 'Prepaid'
  const prepaidBadge = document.createElement('span')
  prepaidBadge.className = 'team-attendance-prepaid-status'
  prepaidBadge.textContent = prepaidStatusLabel(record.prepaid_status, record.applied_prepaid_minutes)
  prepaidTitle.append(prepaidCaret, prepaidLabel, prepaidBadge)
  prepaid.addEventListener('toggle', () => {
    prepaidTitle.setAttribute('aria-expanded', String(prepaid.open))
  })
  const prepaidValues = document.createElement('div')
  prepaidValues.className = 'team-attendance-prepaid-values'
  addPrepaidValue(
    prepaidValues,
    formatDateTime(record.prepaid_clock_in, record.employee_timezone),
    'Prepaid login'
  )
  addPrepaidValue(
    prepaidValues,
    formatDateTime(record.prepaid_clock_out, record.employee_timezone),
    'Prepaid logout'
  )
  addPrepaidValue(prepaidValues, formatOptionalMinutes(record.prepaid_minutes), 'Prepaid time')
  addPrepaidValue(prepaidValues, formatOptionalMinutes(record.actual_eligible_minutes), 'Actual eligible')
  addPrepaidValue(
    prepaidValues,
    formatOptionalMinutes(record.applied_prepaid_minutes),
    'Applied to prepaid',
    Number(record.applied_prepaid_minutes) > 0 ? 'is-applied' : ''
  )
  addPrepaidValue(
    prepaidValues,
    formatOptionalMinutes(record.remaining_prepaid_minutes),
    'Remaining prepaid',
    Number(record.remaining_prepaid_minutes) > 0 ? 'has-balance' : ''
  )
  addPrepaidValue(
    prepaidValues,
    prepaidStatusLabel(record.prepaid_status, record.applied_prepaid_minutes),
    'Prepaid status',
    record.prepaid_status ? `status-${record.prepaid_status}` : ''
  )
  prepaid.append(prepaidTitle, prepaidValues)
  summary.appendChild(prepaid)

  const footer = document.createElement('div')
  footer.className = 'team-attendance-record-footer'
  const correction = document.createElement('div')
  correction.className = 'team-attendance-correction'
  const reviewStatus = REVIEW_STATUS_LABELS[record.review_status || 'pending'] || record.review_status
  correction.textContent = record.is_corrected
    ? `${reviewStatus} by ${record.corrected_by_name || 'administrator'}${record.corrected_at ? ` · ${formatDateTime(record.corrected_at, record.employee_timezone, true)}` : ''}${record.correction_reason ? ` · ${record.correction_reason}` : ''}`
    : `Correction status: ${reviewStatus}`
  footer.appendChild(correction)
  card.append(top, middle, createTimeline(record))
  if (isAdminView) {
    card.append(summary)
    if (record.is_corrected || record.correction_reason || record.admin_notes) {
      card.appendChild(footer)
    }
  }
  return card
}

function createVoidedAttendanceCard(record) {
  const card = document.createElement('article')
  card.className = 'team-attendance-record status-needs-review team-attendance-voided-record'

  const top = document.createElement('div')
  top.className = 'team-attendance-record-top'
  const person = document.createElement('div')
  person.className = 'team-attendance-person'
  const avatar = document.createElement('span')
  avatar.className = 'team-attendance-avatar'
  avatar.textContent = initials(record.employee_name)
  const identity = document.createElement('div')
  const name = document.createElement('div')
  name.className = 'team-attendance-person-name'
  name.textContent = record.employee_name || 'Unknown employee'
  const sub = document.createElement('div')
  sub.className = 'team-attendance-person-sub'
  sub.textContent = 'Voided history'
  identity.append(name, sub)
  person.append(avatar, identity)

  const badges = document.createElement('div')
  badges.className = 'team-attendance-badges'
  addBadge(badges, 'Voided', 'danger')
  const actions = document.createElement('div')
  actions.className = 'wf-row-actions'
  const restoreButton = document.createElement('button')
  restoreButton.type = 'button'
  restoreButton.className = 'wf-btn secondary compact'
  restoreButton.textContent = 'Restore attendance'
  restoreButton.disabled = access?.is_admin !== true || !(
    access?.can_correct_attendance || hasWorkforcePermission(access, 'manage_schedules')
  )
  restoreButton.addEventListener('click', () => openRestoreModal(record, restoreButton))
  actions.appendChild(restoreButton)
  badges.appendChild(actions)
  top.append(person, badges)

  const middle = document.createElement('div')
  middle.className = 'team-attendance-record-mid'
  addMeta(middle, formatDate(record.work_date), formatShift(record))
  addMeta(middle, formatDateTime(record.original_clock_in || record.clock_in, record.employee_timezone), 'Original Clock-in')
  addMeta(middle, formatDateTime(record.original_clock_out || record.clock_out, record.employee_timezone), 'Original Clock-out')
  addMeta(middle, formatDateTime(record.voided_at, record.employee_timezone, true), 'Voided')

  const footer = document.createElement('div')
  footer.className = 'team-attendance-record-footer'
  const reason = document.createElement('div')
  reason.className = 'team-attendance-correction'
  reason.textContent = `Void reason: ${record.void_reason || 'Not recorded'}${record.voided_by_name ? ` · By ${record.voided_by_name}` : ''}`
  footer.appendChild(reason)
  card.append(top, middle, footer)
  return card
}

function renderTable() {
  const rows = filteredRows()
  elements.tableBody.replaceChildren()
  const pageCount = Math.max(1, Math.ceil(rows.length / ATTENDANCE_PAGE_SIZE))
  attendancePage = Math.min(Math.max(attendancePage, 1), pageCount)
  const pageStart = (attendancePage - 1) * ATTENDANCE_PAGE_SIZE
  const pageRows = rows.slice(pageStart, pageStart + ATTENDANCE_PAGE_SIZE)

  if (!rows.length) {
    const empty = document.createElement('div')
    empty.className = 'wf-empty'
    empty.textContent = 'No attendance records match the selected filters.'
    elements.tableBody.appendChild(empty)
  } else {
    pageRows.forEach(record => elements.tableBody.appendChild(
      showVoidedHistory ? createVoidedAttendanceCard(record) : createAttendanceCard(record)
    ))
  }

  renderSummary(rows)
  elements.pagination.hidden = rows.length <= ATTENDANCE_PAGE_SIZE
  elements.pageInfo.textContent = `Page ${attendancePage} of ${pageCount}`
  elements.previousPage.disabled = attendancePage === 1
  elements.nextPage.disabled = attendancePage === pageCount
  const loadedCount = showVoidedHistory ? voidedRows.length : attendanceRows.length
  const viewLabel = showVoidedHistory ? 'voided ' : ''
  setMessage(
    elements.tableMessage,
    rows.length
      ? `Showing ${pageStart + 1}–${pageStart + pageRows.length} of ${rows.length} filtered ${viewLabel}attendance records · ${loadedCount} total loaded.`
      : `0 of ${loadedCount} ${viewLabel}attendance records shown.`
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

function populateAddEmployees() {
  const select = document.getElementById('teamAttendanceAddEmployee')
  if (!select) return

  const selected = select.value
  select.replaceChildren(new Option('Select an employee', ''))
  employees.forEach(employee => {
    const label = employee.employee_id
      ? `${employee.full_name} · ${employee.employee_id}`
      : employee.full_name
    select.appendChild(new Option(label, employee.user_id))
  })
  if ([...select.options].some(option => option.value === selected)) select.value = selected
}

async function loadReferenceData() {
  if (access?.is_admin !== true) {
    employees = []
    teams = []
    populateFilters()
    return
  }

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
        timezone: WORKFORCE_TIMEZONE
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
  populateAddEmployees()
}

async function loadAddSchedules() {
  const employeeId = document.getElementById('teamAttendanceAddEmployee')?.value
  const workDate = document.getElementById('teamAttendanceAddWorkDate')?.value
  const select = document.getElementById('teamAttendanceAddSchedule')
  if (!select) return

  select.replaceChildren(new Option('No assigned shift (RDOT)', ''))
  if (!employeeId || !workDate) return

  const { data, error } = await supabase
    .from('work_schedules')
    .select('id, shift_date, shift_sequence, shift_start, shift_end, timezone, status, is_rest_day, is_holiday, is_leave, is_absent, holiday_name, leave_type')
    .eq('user_id', employeeId)
    .eq('shift_date', workDate)
    .eq('is_leave', false)
    .eq('is_absent', false)
    .in('status', ['published', 'changed'])
    .order('shift_start')

  if (error) throw error

  for (const schedule of data || []) {
    const specialDay = schedule.is_rest_day
      ? 'Rest day'
      : schedule.is_holiday
        ? schedule.holiday_name || 'Holiday'
        : ''
    select.appendChild(new Option([formatScheduleOptionLabel(schedule, WORKFORCE_TIMEZONE), specialDay, schedule.status].filter(Boolean).join(' · '), schedule.id))
  }

  if (select.options.length === 2) select.selectedIndex = 1
}

async function openAddModal() {
  const modal = document.getElementById('teamAttendanceAddModal')
  const form = document.getElementById('teamAttendanceAddForm')
  if (!modal || !form) return

  form.reset()
  populateAddEmployees()
  document.getElementById('teamAttendanceAddWorkDate').value = localDateKey()
  setMessage(document.getElementById('teamAttendanceAddMessage'), '')
  await loadAddSchedules()
  modal.hidden = false
  document.body.classList.add('modal-open')
  document.getElementById('teamAttendanceAddEmployee').focus()
}

function closeAddModal() {
  const modal = document.getElementById('teamAttendanceAddModal')
  if (!modal) return
  modal.hidden = true
  document.body.classList.remove('modal-open')
}

async function handleAddSubmit(messageElement) {
  const employeeId = document.getElementById('teamAttendanceAddEmployee').value
  const workDate = document.getElementById('teamAttendanceAddWorkDate').value
  const scheduleId = document.getElementById('teamAttendanceAddSchedule').value
  const clockIn = document.getElementById('teamAttendanceAddClockIn').value
  const clockOut = document.getElementById('teamAttendanceAddClockOut').value
  const status = document.getElementById('teamAttendanceAddStatus').value
  const reason = document.getElementById('teamAttendanceAddReason').value.trim()
  const notes = document.getElementById('teamAttendanceAddNotes').value.trim()
  const submit = document.getElementById('teamAttendanceAddSubmit')

  if (!employeeId || !workDate || !clockIn || !clockOut || reason.length < 3) {
    setMessage(messageElement, 'Employee, work date, clock times, and a reason are required.', 'error')
    return
  }

  if (dateTimeLocalToIso(clockOut) < dateTimeLocalToIso(clockIn)) {
    setMessage(messageElement, 'Clock-out cannot be earlier than clock-in.', 'error')
    return
  }

  submit.disabled = true
  submit.textContent = 'Adding...'
  setMessage(messageElement, 'Adding attendance record...')

  try {
    const { error } = await supabase.rpc('workforce_create_manual_attendance', {
      p_user_id: employeeId,
      p_work_date: workDate,
      p_clock_in: dateTimeLocalToIso(clockIn),
      p_clock_out: dateTimeLocalToIso(clockOut),
      p_schedule_id: scheduleId || null,
      p_attendance_status: status,
      p_reason: reason,
      p_admin_notes: notes || null
    })

    if (error) throw error
    await loadAttendance()
    closeAddModal()
    setMessage(elements.tableMessage, 'Attendance record added successfully.', 'success')
  } catch (error) {
    setMessage(messageElement, errorMessage(error), 'error')
  } finally {
    submit.disabled = false
    submit.textContent = 'Add attendance'
  }
}

async function loadAttendance() {
  const range = access?.is_admin === true
    ? validateDateRange()
    : defaultAgentDateRange()

  if (access?.is_admin !== true) {
    elements.startDate.value = range.start
    elements.endDate.value = range.end
  }
  setMessage(elements.filterMessage, 'Loading authorized attendance records...')

  await persistOverDurationFlagsBeforeTeamListing()

  const attendanceRequest = supabase.rpc('workforce_list_team_attendance', {
    p_start_date: range.start,
    p_end_date: range.end
  })
  const prepaidRequest = access?.is_admin === true
    ? supabase.rpc('workforce_list_team_attendance_prepaid', {
      p_start_date: range.start,
      p_end_date: range.end
    })
    : Promise.resolve({ data: [], error: null })
  const voidedRequest = access?.is_admin === true && showVoidedHistory
    ? supabase.rpc('workforce_list_voided_team_attendance', {
      p_start_date: range.start,
      p_end_date: range.end
    })
    : Promise.resolve({ data: [], error: null })

  const [attendanceResult, prepaidResult, voidedResult] = await Promise.all([
    attendanceRequest,
    prepaidRequest,
    voidedRequest
  ])

  if (attendanceResult.error) throw attendanceResult.error
  if (prepaidResult.error) throw prepaidResult.error
  if (voidedResult.error) throw voidedResult.error

  voidedRows = (voidedResult.data || []).map(row => ({
    ...row,
    is_voided: true,
    employee_timezone: row.employee_timezone || WORKFORCE_TIMEZONE
  }))

  const prepaidByAttendance = new Map(
    (prepaidResult.data || []).map(row => [row.attendance_id, row])
  )
  const classificationNow = new Date()
  attendanceRows = (attendanceResult.data || []).map(row => (
    redactAttendanceCorrectionForViewer(access, {
      prepaid_clock_in: null,
      prepaid_clock_out: null,
      prepaid_minutes: null,
      actual_eligible_minutes: null,
      applied_prepaid_minutes: 0,
      remaining_prepaid_minutes: null,
      prepaid_status: null,
      ...row,
      ...(prepaidByAttendance.get(row.attendance_id) || {})
    })
  )).map(row => ({
    ...row,
    ...classifyOpenSession(row, classificationNow)
  }))
  if (access?.is_admin !== true) {
    attendanceRows = attendanceRows.filter(row => row.clock_in && !row.clock_out)
  }
  mergeAttendanceReferences(attendanceRows)
  renderTable()
  setMessage(
    elements.filterMessage,
    access?.is_admin === true
      ? `Attendance loaded for ${formatDate(range.start)} through ${formatDate(range.end)}.`
      : `Showing agents currently clocked in for ${formatDate(range.start)}, including early clock-ins assigned to today's schedule.`,
    'success'
  )
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
  elements.unscheduledFilter.value = ''
  elements.openFilter.checked = false
  elements.missingFilter.checked = false
  elements.overtimeFilter.checked = false
  elements.voidedHistory.checked = false
  showVoidedHistory = false
  elements.search.value = ''
  attendanceQuickFilter = 'all'
  document.querySelectorAll('[data-attendance-quick-filter]').forEach(button => {
    button.classList.toggle('active', button.dataset.attendanceQuickFilter === 'all')
  })
  attendancePage = 1
  await refreshAttendance()
}

function bindEvents() {
  document.addEventListener('click', event => {
    const clickedMenu = event.target.closest('.team-attendance-record-actions')
    document.querySelectorAll('.team-attendance-record-actions[open]').forEach(menu => {
      if (!clickedMenu || menu !== clickedMenu) menu.open = false
    })
  })

  elements.refreshButton.addEventListener('click', refreshAttendance)
  elements.resetButton.addEventListener('click', resetFilters)
  elements.addButton?.addEventListener('click', () => {
    openAddModal().catch(error => setMessage(elements.tableMessage, errorMessage(error), 'error'))
  })
  elements.search.addEventListener('input', () => {
    attendancePage = 1
    renderTable()
  })
  document.querySelectorAll('[data-attendance-quick-filter]').forEach(button => {
    button.addEventListener('click', () => {
      attendanceQuickFilter = button.dataset.attendanceQuickFilter
      document.querySelectorAll('[data-attendance-quick-filter]').forEach(candidate => {
        candidate.classList.toggle('active', candidate === button)
      })
      attendancePage = 1
      renderTable()
    })
  })

  for (const element of [
    elements.employeeFilter,
    elements.teamFilter,
    elements.statusFilter,
    elements.correctedFilter,
    elements.unscheduledFilter,
    elements.openFilter,
    elements.missingFilter,
    elements.overtimeFilter
  ]) {
    element.addEventListener('change', () => {
      attendancePage = 1
      renderTable()
    })
  }

  elements.previousPage.addEventListener('click', () => {
    if (attendancePage <= 1) return
    attendancePage -= 1
    renderTable()
    elements.tableBody.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
  elements.nextPage.addEventListener('click', () => {
    const pageCount = Math.ceil(filteredRows().length / ATTENDANCE_PAGE_SIZE)
    if (attendancePage >= pageCount) return
    attendancePage += 1
    renderTable()
    elements.tableBody.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })

  const correctionForm = document.getElementById('teamAttendanceCorrectionForm')
  const correctionModal = document.getElementById('teamAttendanceCorrectionModal')
  const correctionMessage = document.getElementById('teamAttendanceCorrectionMessage')
  const addForm = document.getElementById('teamAttendanceAddForm')
  const addMessage = document.getElementById('teamAttendanceAddMessage')
  const deleteForm = document.getElementById('teamAttendanceDeleteForm')
  const deleteMessage = document.getElementById('teamAttendanceDeleteMessage')
  const restoreForm = document.getElementById('teamAttendanceRestoreForm')

  addForm?.addEventListener('submit', event => {
    event.preventDefault()
    handleAddSubmit(addMessage)
  })
  document.getElementById('teamAttendanceAddEmployee')?.addEventListener('change', () => {
    loadAddSchedules().catch(error => setMessage(addMessage, errorMessage(error), 'error'))
  })
  document.getElementById('teamAttendanceAddWorkDate')?.addEventListener('change', () => {
    loadAddSchedules().catch(error => setMessage(addMessage, errorMessage(error), 'error'))
  })

  if (correctionForm) {
    correctionForm.addEventListener('submit', event => {
      event.preventDefault()
      void handleCorrectionSubmit(correctionMessage)
    })
  }

  elements.voidedHistory?.addEventListener('change', () => {
    showVoidedHistory = elements.voidedHistory.checked
    attendancePage = 1
    refreshAttendance().catch(error => {
      setMessage(elements.filterMessage, errorMessage(error), 'error')
      setMessage(elements.tableMessage, errorMessage(error), 'error')
    })
  })
  ;['teamAttendanceNewClockIn', 'teamAttendanceNewClockOut'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', updateCorrectionPreview)
  })
  deleteForm?.addEventListener('submit', event => {
    event.preventDefault()
    deleteAttendance()
  })
  restoreForm?.addEventListener('submit', event => {
    event.preventDefault()
    restoreAttendance()
  })
  document.querySelectorAll('[data-close]').forEach(button => {
    button.addEventListener('click', () => {
      if (button.dataset.close === 'teamAttendanceAddModal') closeAddModal()
      else if (button.dataset.close === 'teamAttendanceDeleteModal') closeDeleteModal()
      else if (button.dataset.close === 'teamAttendanceRestoreModal') closeRestoreModal()
      else closeCorrectionModal()
    })
  })
}

async function loadCorrectionSchedules(row) {
  const modal = document.getElementById('teamAttendanceCorrectionModal')
  const select = document.getElementById('teamAttendanceCorrectionSchedule')
  const status = document.getElementById('teamAttendanceCorrectionScheduleStatus')
  if (!select) return

  select.disabled = true
  select.replaceChildren(new Option('Loading shifts…', ''))

  const { data, error } = await supabase
    .from('work_schedules')
    .select('id, shift_date, shift_sequence, shift_start, shift_end, timezone, status, is_rest_day, is_holiday, is_leave, is_absent, holiday_name, leave_type')
    .eq('user_id', row.employee_user_id)
    .in('shift_date', correctionScheduleDates(row.work_date))
    .eq('is_leave', false)
    .eq('is_absent', false)
    .in('status', ['published', 'changed'])
    .order('shift_start')

  if (error) throw error

  modal._correctionSchedules = [...(data || [])]

  const currentSchedule = row.schedule_id
    ? modal._correctionSchedules.find(schedule => schedule.id === row.schedule_id) || {
      ...row,
      shift_date: row.work_date,
      shift_sequence: row.schedule_sequence,
      shift_start: row.schedule_start,
      shift_end: row.schedule_end,
      timezone: row.timezone
    }
    : null
  if (currentSchedule && !modal._correctionSchedules.some(schedule => schedule.id === currentSchedule.id)) {
    modal._correctionSchedules.push(currentSchedule)
  }

  select.replaceChildren(new Option(row.schedule_id ? 'Keep current assigned shift' : 'Unscheduled (RDOT)', row.schedule_id || ''))
  const eligibleSchedules = (data || []).filter(schedule => (
    schedule.id !== row.schedule_id
      && isEligibleCorrectionSchedule(schedule, row.work_date)
  ))
  for (const schedule of eligibleSchedules) {
    const specialDay = schedule.is_rest_day
      ? 'Rest day'
      : schedule.is_holiday
        ? schedule.holiday_name || 'Holiday'
        : ''
    const option = new Option(formatCorrectionScheduleLabel(schedule), schedule.id)
    option.dataset.status = [specialDay, schedule.status].filter(Boolean).join(' · ')
    select.appendChild(option)
  }

  select.value = row.schedule_id || ''
  const updateStatus = () => {
    const option = select.selectedOptions[0]
    status.textContent = option?.dataset.status || (select.value ? 'Published' : 'Unscheduled')
    updateCorrectionPreview()
  }
  select.onchange = updateStatus
  updateStatus()
  select.disabled = false
}

function selectedCorrectionSchedule() {
  const modal = document.getElementById('teamAttendanceCorrectionModal')
  const scheduleId = document.getElementById('teamAttendanceCorrectionSchedule')?.value
  return modal?._correctionSchedules?.find(schedule => schedule.id === scheduleId) || null
}

function updateCorrectionPreview() {
  const modal = document.getElementById('teamAttendanceCorrectionModal')
  const preview = document.getElementById('teamAttendanceCorrectionPreview')
  const warning = document.getElementById('teamAttendanceCorrectionScheduleWarning')
  const confirmation = document.getElementById('teamAttendanceCorrectionZeroOverlapConfirmation')
  const confirmationInput = document.getElementById('teamAttendanceCorrectionZeroOverlapConfirm')
  if (!modal || !preview || !warning || !confirmation || !confirmationInput) return

  let clockInIso = null
  let clockOutIso = null
  try {
    clockInIso = dateTimeLocalToIso(document.getElementById('teamAttendanceNewClockIn')?.value)
    clockOutIso = dateTimeLocalToIso(document.getElementById('teamAttendanceNewClockOut')?.value)
  } catch {
    preview.hidden = true
    warning.hidden = true
    confirmation.hidden = true
    confirmationInput.checked = false
    return
  }

  const schedule = selectedCorrectionSchedule()
  const analysis = correctionScheduleAnalysis({ clockInIso, clockOutIso, schedule })
  const classification = correctionClassificationPreview({ clockInIso, clockOutIso, schedule })
  preview.hidden = !classification
  if (classification) {
    preview.textContent = `Preview (${WORKFORCE_TIMEZONE}): Regular ${formatMinutes(classification.regularMinutes)} · Pre-shift OT ${formatMinutes(classification.preShiftMinutes)} · Post-shift OT ${formatMinutes(classification.postShiftMinutes)}`
  }

  warning.hidden = !analysis.applicable || analysis.overlapMinutes > 0
  confirmation.hidden = warning.hidden
  confirmationInput.checked = false
  if (!warning.hidden) {
    const scheduleLabel = formatCorrectionScheduleLabel(schedule)
    warning.textContent = analysis.likelyMismatch
      ? `Possible work-date mismatch: these corrected times do not overlap the assigned ${scheduleLabel} shift, but shifting them ${analysis.likelyMismatchDays > 0 ? 'one day later' : 'one day earlier'} would overlap it by ${formatMinutes(analysis.likelyMismatchOverlapMinutes)}.`
      : `These corrected times do not overlap the assigned ${scheduleLabel} shift.`
  }
}

async function openCorrectionModal(row) {
  const modal = document.getElementById('teamAttendanceCorrectionModal')
  if (!modal) return

  const employeeInput = document.getElementById('teamAttendanceCorrectionEmployee')
  const workDateInput = document.getElementById('teamAttendanceCorrectionWorkDate')
  const currentClockInInput = document.getElementById('teamAttendanceCorrectionCurrentClockIn')
  const currentClockOutInput = document.getElementById('teamAttendanceCorrectionCurrentClockOut')
  const currentStatusInput = document.getElementById('teamAttendanceCorrectionCurrentStatus')
  const newClockInInput = document.getElementById('teamAttendanceNewClockIn')
  const newClockOutInput = document.getElementById('teamAttendanceNewClockOut')
  const newStatusInput = document.getElementById('teamAttendanceNewStatus')
  const reasonCodeInput = document.getElementById('teamAttendanceReasonCode')
  const reasonNotesInput = document.getElementById('teamAttendanceReasonNotes')
  const adminNotesInput = document.getElementById('teamAttendanceAdminNotes')

  modal.dataset.attendanceId = row.attendance_id || ''
  modal.dataset.scheduleId = row.schedule_id || ''
  modal.dataset.billedClockIn = row.billed_clock_in || row.clock_in || ''
  modal.dataset.billedClockOut = row.billed_clock_out || row.clock_out || ''
  employeeInput.textContent = row.employee_name || 'Unknown employee'
  document.getElementById('teamAttendanceCorrectionEmployeeDetails').textContent = [row.employee_id, row.team_name].filter(Boolean).join(' · ') || '—'
  workDateInput.textContent = formatDate(row.work_date)
  currentClockInInput.textContent = formatCorrectionDateTime(row.original_clock_in || row.clock_in, row.employee_timezone)
  currentClockOutInput.textContent = formatCorrectionDateTime(row.original_clock_out || row.clock_out, row.employee_timezone)
  currentStatusInput.textContent = row.is_open ? 'Open session' : ATTENDANCE_STATUS_LABELS[row.attendance_status] || row.attendance_status || '—'
  newClockInInput.value = toDateTimeLocal(row.billed_clock_in || row.clock_in)
  newClockOutInput.value = toDateTimeLocal(row.billed_clock_out || row.clock_out)
  newStatusInput.value = row.attendance_status || 'present'
  reasonCodeInput.value = ''
  reasonNotesInput.value = ''
  adminNotesInput.value = row.admin_notes || ''
  setMessage(document.getElementById('teamAttendanceCorrectionMessage'), '')

  modal._correctionSchedules = []
  modal.hidden = false
  document.body.classList.add('modal-open')
  updateCorrectionPreview()
  try {
    await loadCorrectionSchedules(row)
  } catch (error) {
    setMessage(document.getElementById('teamAttendanceCorrectionMessage'), `Unable to load assigned shifts: ${errorMessage(error)}`, 'error')
  }
  newClockInInput.focus()
}

function closeCorrectionModal() {
  const modal = document.getElementById('teamAttendanceCorrectionModal')
  if (!modal) return
  modal.hidden = true
  document.body.classList.remove('modal-open')
}

function correctionValidationMessage({
  attendanceId,
  newClockIn,
  newClockOut,
  reasonCode,
  reasonNotes,
  billedTimeChanged,
  scheduleChanged
}) {
  if (!attendanceId) return 'Attendance record is missing.'
  if (!reasonCode) return 'Select a correction reason.'

  if (billedTimeChanged && (!newClockIn || !newClockOut)) {
    return 'Enter both billed clock-in and billed clock-out.'
  }

  let clockInIso = null
  let clockOutIso = null
  try {
    clockInIso = dateTimeLocalToIso(newClockIn)
    clockOutIso = dateTimeLocalToIso(newClockOut)
  } catch (error) {
    return errorMessage(error)
  }

  if (clockInIso && clockOutIso && clockOutIso < clockInIso) {
    return 'Billed clock-out cannot be earlier than billed clock-in.'
  }

  if ((billedTimeChanged || scheduleChanged) && !reasonNotes.trim()) {
    return 'Remarks are required when billed time or schedule changes.'
  }

  if (reasonCode === 'other' && !reasonNotes.trim()) {
    return 'Notes are required when the reason is Other.'
  }

  return ''
}

async function handleCorrectionSubmit(messageElement) {
  const modal = document.getElementById('teamAttendanceCorrectionModal')
  if (!modal) return

  const attendanceId = modal.dataset.attendanceId
  const scheduleId = document.getElementById('teamAttendanceCorrectionSchedule').value
  const currentScheduleId = modal.dataset.scheduleId || ''
  const newClockIn = document.getElementById('teamAttendanceNewClockIn').value
  const newClockOut = document.getElementById('teamAttendanceNewClockOut').value
  const newStatus = document.getElementById('teamAttendanceNewStatus').value
  const reasonCode = document.getElementById('teamAttendanceReasonCode').value
  const reasonNotes = document.getElementById('teamAttendanceReasonNotes').value
  const adminNotes = document.getElementById('teamAttendanceAdminNotes').value

  const currentBilledClockIn = toDateTimeLocal(modal.dataset.billedClockIn)
  const currentBilledClockOut = toDateTimeLocal(modal.dataset.billedClockOut)
  const billedTimeChanged = newClockIn !== currentBilledClockIn || newClockOut !== currentBilledClockOut
  const scheduleChanged = currentScheduleId !== scheduleId && Boolean(scheduleId)

  const validationMessage = correctionValidationMessage({
    attendanceId,
    newClockIn,
    newClockOut,
    reasonCode,
    reasonNotes,
    billedTimeChanged,
    scheduleChanged
  })
  if (validationMessage) {
    setMessage(messageElement, validationMessage, 'error')
    return
  }

  const correctionAnalysis = correctionScheduleAnalysis({
    clockInIso: dateTimeLocalToIso(newClockIn),
    clockOutIso: dateTimeLocalToIso(newClockOut),
    schedule: selectedCorrectionSchedule()
  })
  if (correctionAnalysis.requiresConfirmation && !document.getElementById('teamAttendanceCorrectionZeroOverlapConfirm').checked) {
    setMessage(messageElement, 'Confirm that the corrected timestamps are intentionally outside the assigned shift before submitting.', 'error')
    return
  }

  setMessage(messageElement, 'Submitting correction…')

  const scheduleOnlyChange = scheduleChanged && !billedTimeChanged
  const rpcName = scheduleOnlyChange
    ? 'workforce_assign_attendance_schedule'
    : 'workforce_correct_attendance'
  let rpcParams
  try {
    rpcParams = rpcName === 'workforce_assign_attendance_schedule'
      ? { p_attendance_id: attendanceId, p_schedule_id: scheduleId, p_reason_code: reasonCode, p_reason_notes: reasonNotes || null }
      : {
          p_attendance_id: attendanceId,
          p_new_clock_in: dateTimeLocalToIso(newClockIn),
          p_new_clock_out: dateTimeLocalToIso(newClockOut),
          p_new_status: newStatus,
          p_schedule_id: scheduleId || null,
          p_admin_notes: adminNotes || null,
          p_reason_code: reasonCode,
          p_reason_notes: reasonNotes || null
        }
  } catch (error) {
    setMessage(messageElement, errorMessage(error), 'error')
    return
  }

  const { error } = await supabase.rpc(rpcName, rpcParams)

  if (error) {
    setMessage(messageElement, errorMessage(error), 'error')
    return
  }

  setMessage(messageElement, 'Correction saved successfully.', 'success')
  await refreshAttendance()
  window.setTimeout(closeCorrectionModal, 700)
}

async function initialize() {
  access = await loadCurrentWorkforceAccess(supabase)

  if (!access.authenticated) {
    window.location.replace(`./login.html?returnTo=${encodeURIComponent('./team-attendance.html')}`)
    return
  }

  const hasAdminAttendanceAccess = access.is_admin === true &&
    hasWorkforcePermission(access, 'view_team_attendance')
  const hasAgentLiveAccess = access.is_admin !== true && access.is_agent === true

  if (!access.allowed || (!hasAdminAttendanceAccess && !hasAgentLiveAccess)) {
    window.alert('You do not have permission to view team attendance.')
    window.location.replace('./home.html')
    return
  }

  elements.workforceLink.hidden = !(
    access.is_admin === true && hasWorkforcePermission(access, 'manage_employees')
  )
  elements.scope.textContent = access.is_admin === true
    ? 'Showing attendance for all employees permitted by your administrator access.'
    : `Showing agents currently clocked in today, including prior-night clock-ins assigned to today's schedule.`
  elements.addButton.hidden = !(
    access.is_admin === true && hasWorkforcePermission(access, 'manage_schedules')
  )

  const linkedFilters = access.is_admin === true
    ? payrollAttendanceLinkFilters()
    : null
  const range = linkedFilters || (
    access.is_admin === true
      ? defaultDateRange()
      : defaultAgentDateRange()
  )
  elements.startDate.value = range.start
  elements.endDate.value = range.end

  if (access.is_admin !== true) {
    const advancedFilters = document.querySelector('.team-attendance-advanced-filters')
    const quickFilters = document.querySelector('.team-attendance-chips')
    if (advancedFilters) advancedFilters.hidden = true
    if (quickFilters) quickFilters.hidden = true
    if (elements.voidedHistory) elements.voidedHistory.closest('label')?.setAttribute('hidden', '')
  }
  bindEvents()

  await loadReferenceData()
  if (
    linkedFilters &&
    [...elements.employeeFilter.options].some(
      option => option.value === linkedFilters.employee
    )
  ) {
    elements.employeeFilter.value = linkedFilters.employee
    const advancedFilters = document.querySelector(
      '.team-attendance-advanced-filters'
    )
    if (advancedFilters) advancedFilters.open = true
  }
  await refreshAttendance()

  if (linkedFilters) {
    const employee = employees.find(
      candidate => candidate.user_id === linkedFilters.employee
    )
    setMessage(
      elements.filterMessage,
      `Payroll exception: attendance is missing for ${employee?.full_name || 'this employee'} on ${formatDate(linkedFilters.start)}. The page is filtered to the affected employee and work date.`
    )
  }
}

initialize().catch(error => {
  console.error('Team attendance initialization failed:', error)
  setMessage(elements.filterMessage, errorMessage(error), 'error')
  setMessage(elements.tableMessage, errorMessage(error), 'error')
})
