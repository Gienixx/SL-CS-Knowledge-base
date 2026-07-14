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
const ATTENDANCE_PAGE_SIZE = 5

const elements = {
  workforceLink: document.getElementById('teamAttendanceWorkforceLink'),
  recordCount: document.getElementById('teamAttendanceRecordCount'),
  openCount: document.getElementById('teamAttendanceOpenCount'),
  missingCount: document.getElementById('teamAttendanceMissingCount'),
  overtimeCount: document.getElementById('teamAttendanceOvertimeCount'),
  scope: document.getElementById('teamAttendanceScope'),
  search: document.getElementById('teamAttendanceSearch'),
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

function errorMessage(error) {
  return error?.message || 'An unexpected error occurred.'
}

function setMessage(element, text, type = '') {
  element.textContent = text
  element.className = type ? `wf-message ${type}` : 'wf-message'
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

function toDateTimeLocal(value) {
  if (!value) return ''
  const date = new Date(value)
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day}T${hours}:${minutes}`
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

function createActionCell(row) {
  const cell = document.createElement('td')
  const actions = document.createElement('div')
  actions.className = 'wf-row-actions'

  const correctButton = document.createElement('button')
  correctButton.type = 'button'
  correctButton.className = 'wf-btn secondary compact'
  correctButton.textContent = 'Correct'
  correctButton.disabled = !access?.can_correct_attendance || !row.employee_user_id
  correctButton.addEventListener('click', () => openCorrectionModal(row))
  actions.appendChild(correctButton)

  if (access?.is_admin === true && hasWorkforcePermission(access, 'manage_schedules')) {
    const deleteButton = document.createElement('button')
    deleteButton.type = 'button'
    deleteButton.className = 'wf-btn danger compact'
    deleteButton.textContent = 'Delete'
    deleteButton.addEventListener('click', () => deleteAttendance(row, deleteButton))
    actions.appendChild(deleteButton)
  }

  cell.appendChild(actions)
  return cell
}

async function deleteAttendance(row, button) {
  if (!row.attendance_id || busy) return

  const employee = row.employee_name || 'this employee'
  const workDate = formatDate(row.work_date)
  const confirmed = window.confirm(
    `Delete ${employee}'s attendance record for ${workDate}? This cannot be undone.`
  )

  if (!confirmed) return

  busy = true
  button.disabled = true
  button.textContent = 'Deleting...'
  setMessage(elements.tableMessage, 'Deleting attendance record...')

  try {
    const { data, error } = await supabase
      .from('attendance')
      .delete()
      .eq('id', row.attendance_id)
      .select('id')

    if (error) throw error
    if (!data?.length) throw new Error('Attendance record was not deleted. Check your permissions and try again.')

    await loadAttendance()
    setMessage(elements.tableMessage, 'Attendance record deleted successfully.', 'success')
  } catch (error) {
    setMessage(elements.tableMessage, errorMessage(error), 'error')
    button.disabled = false
    button.textContent = 'Delete'
  } finally {
    busy = false
  }
}

function filteredRows() {
  const search = elements.search.value.trim().toLowerCase()
  const employeeId = elements.employeeFilter.value
  const teamId = elements.teamFilter.value
  const status = elements.statusFilter.value
  const corrected = elements.correctedFilter.value
  const openOnly = elements.openFilter.checked
  const missingOnly = elements.missingFilter.checked
  const overtimeOnly = elements.overtimeFilter.checked

  return attendanceRows.filter(row => {
    if (search && ![row.employee_name, row.employee_id, row.employee_email]
      .some(value => String(value || '').toLowerCase().includes(search))) return false
    if (attendanceQuickFilter === 'open' && !row.is_open) return false
    if (attendanceQuickFilter === 'missing' && !row.is_missing_clock_out) return false
    if (attendanceQuickFilter === 'overtime' && Number(row.total_overtime_minutes) <= 0) return false
    if (attendanceQuickFilter === 'review' && row.review_status !== 'pending' && !row.is_missing_clock_out) return false
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

function initials(value) {
  return String(value || '?').trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase()
}

function minutesOfDay(value, timezone) {
  if (!value) return null
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || access?.timezone || 'Asia/Manila',
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

function addBadge(parent, label, modifier) {
  const badge = document.createElement('span')
  badge.className = `wf-badge ${modifier}`
  badge.textContent = label
  parent.appendChild(badge)
}

function presentationStatus(record) {
  if (record.is_open) return { label: 'In progress', modifier: 'in-progress' }
  if (record.is_missing_clock_out) return { label: 'Missing clock-out', modifier: 'needs-review' }
  if (record.review_status === 'pending') return { label: 'Needs review', modifier: 'needs-review' }
  if (Number(record.total_worked_minutes) >= 720 && Number(record.regular_minutes) === 0 && record.schedule_id) {
    return { label: 'Flagged', modifier: 'needs-review' }
  }
  if (Number(record.total_overtime_minutes) > 0) return { label: 'Overtime', modifier: 'overtime' }
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
  badges.appendChild(actionMenu)
  top.append(person, badges)

  const middle = document.createElement('div')
  middle.className = 'team-attendance-record-mid'
  addMeta(middle, formatDate(record.work_date), formatShift(record))
  addMeta(middle, formatDateTime(record.clock_in, record.employee_timezone), 'Clock-in')
  addMeta(middle, record.is_open ? 'In progress' : formatDateTime(record.clock_out, record.employee_timezone), 'Clock-out')

  const stats = document.createElement('div')
  stats.className = 'team-attendance-stats'
  addStat(stats, record.regular_minutes, 'Regular')
  addStat(stats, record.total_overtime_minutes, 'Overtime')
  addStat(stats, record.minutes_late, 'Late')

  const footer = document.createElement('div')
  footer.className = 'team-attendance-record-footer'
  const correction = document.createElement('div')
  correction.className = 'team-attendance-correction'
  const reviewStatus = REVIEW_STATUS_LABELS[record.review_status || 'pending'] || record.review_status
  correction.textContent = record.is_corrected
    ? `${reviewStatus} by ${record.corrected_by_name || 'administrator'}${record.corrected_at ? ` · ${formatDateTime(record.corrected_at, record.employee_timezone, true)}` : ''}${record.correction_reason ? ` · ${record.correction_reason}` : ''}`
    : `Correction status: ${reviewStatus}`
  footer.appendChild(correction)
  card.append(top, middle, createTimeline(record), stats)
  if (record.is_corrected || record.correction_reason || record.admin_notes) card.appendChild(footer)
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
    pageRows.forEach(record => elements.tableBody.appendChild(createAttendanceCard(record)))
  }

  renderSummary(rows)
  elements.pagination.hidden = rows.length <= ATTENDANCE_PAGE_SIZE
  elements.pageInfo.textContent = `Page ${attendancePage} of ${pageCount}`
  elements.previousPage.disabled = attendancePage === 1
  elements.nextPage.disabled = attendancePage === pageCount
  setMessage(
    elements.tableMessage,
    rows.length
      ? `Showing ${pageStart + 1}–${pageStart + pageRows.length} of ${rows.length} filtered attendance records · ${attendanceRows.length} total loaded.`
      : `0 of ${attendanceRows.length} attendance records shown.`
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
    .select('id, shift_start, shift_end, timezone, status, is_rest_day, is_holiday, holiday_name')
    .eq('user_id', employeeId)
    .eq('shift_date', workDate)
    .in('status', ['published', 'changed'])
    .order('shift_start')

  if (error) throw error

  for (const schedule of data || []) {
    const specialDay = schedule.is_rest_day
      ? 'Rest day'
      : schedule.is_holiday
        ? schedule.holiday_name || 'Holiday'
        : ''
    const times = schedule.shift_start && schedule.shift_end
      ? `${formatDateTime(schedule.shift_start, schedule.timezone)} – ${formatDateTime(schedule.shift_end, schedule.timezone)}`
      : 'No shift times'
    select.appendChild(new Option([times, specialDay, schedule.status].filter(Boolean).join(' · '), schedule.id))
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

  if (new Date(clockOut) < new Date(clockIn)) {
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
      p_clock_in: new Date(clockIn).toISOString(),
      p_clock_out: new Date(clockOut).toISOString(),
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
  elements.search.value = ''
  attendanceQuickFilter = 'all'
  document.querySelectorAll('[data-attendance-quick-filter]').forEach(button => {
    button.classList.toggle('active', button.dataset.attendanceQuickFilter === 'all')
  })
  attendancePage = 1
  await refreshAttendance()
}

function bindEvents() {
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
      handleCorrectionSubmit(correctionMessage)
    })
  }

  document.querySelectorAll('[data-close]').forEach(button => {
    button.addEventListener('click', () => {
      if (button.dataset.close === 'teamAttendanceAddModal') closeAddModal()
      else closeCorrectionModal()
    })
  })
}

async function loadCorrectionSchedules(row) {
  const select = document.getElementById('teamAttendanceCorrectionSchedule')
  if (!select) return

  select.disabled = true
  select.replaceChildren(new Option('Loading shifts…', ''))

  const { data, error } = await supabase
    .from('work_schedules')
    .select('id, shift_start, shift_end, timezone, status, is_rest_day, is_holiday, holiday_name')
    .eq('user_id', row.employee_user_id)
    .eq('shift_date', row.work_date)
    .in('status', ['published', 'changed'])
    .order('shift_start')

  if (error) throw error

  select.replaceChildren(new Option(row.schedule_id ? 'Keep current assigned shift' : 'Unscheduled (RDOT)', ''))
  for (const schedule of data || []) {
    const specialDay = schedule.is_rest_day
      ? 'Rest day'
      : schedule.is_holiday
        ? schedule.holiday_name || 'Holiday'
        : ''
    const times = schedule.shift_start && schedule.shift_end
      ? `${formatDateTime(schedule.shift_start, schedule.timezone)} – ${formatDateTime(schedule.shift_end, schedule.timezone)}`
      : 'No shift times'
    select.appendChild(new Option([times, specialDay, schedule.status].filter(Boolean).join(' · '), schedule.id))
  }

  if (row.schedule_id && ![...select.options].some(option => option.value === row.schedule_id)) {
    select.appendChild(new Option(`Current shift · ${formatShift(row)}`, row.schedule_id))
  }
  select.value = row.schedule_id || ''
  select.disabled = false
}

async function openCorrectionModal(row) {
  const modal = document.getElementById('teamAttendanceCorrectionModal')
  if (!modal) return

  const employeeInput = document.getElementById('teamAttendanceCorrectionEmployee')
  const workDateInput = document.getElementById('teamAttendanceCorrectionWorkDate')
  const currentClockInInput = document.getElementById('teamAttendanceCorrectionCurrentClockIn')
  const currentClockOutInput = document.getElementById('teamAttendanceCorrectionCurrentClockOut')
  const newClockInInput = document.getElementById('teamAttendanceNewClockIn')
  const newClockOutInput = document.getElementById('teamAttendanceNewClockOut')
  const newStatusInput = document.getElementById('teamAttendanceNewStatus')
  const reasonCodeInput = document.getElementById('teamAttendanceReasonCode')
  const reasonNotesInput = document.getElementById('teamAttendanceReasonNotes')
  const adminNotesInput = document.getElementById('teamAttendanceAdminNotes')

  modal.dataset.attendanceId = row.attendance_id || ''
  employeeInput.value = row.employee_name || 'Unknown employee'
  workDateInput.value = formatDate(row.work_date)
  currentClockInInput.value = formatDateTime(row.clock_in, row.employee_timezone, true)
  currentClockOutInput.value = formatDateTime(row.clock_out, row.employee_timezone, true)
  newClockInInput.value = toDateTimeLocal(row.clock_in)
  newClockOutInput.value = toDateTimeLocal(row.clock_out)
  newStatusInput.value = row.attendance_status || 'present'
  reasonCodeInput.value = ''
  reasonNotesInput.value = ''
  adminNotesInput.value = row.admin_notes || ''
  setMessage(document.getElementById('teamAttendanceCorrectionMessage'), '')

  modal.hidden = false
  document.body.classList.add('modal-open')
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

async function handleCorrectionSubmit(messageElement) {
  const modal = document.getElementById('teamAttendanceCorrectionModal')
  if (!modal) return

  const attendanceId = modal.dataset.attendanceId
  const scheduleId = document.getElementById('teamAttendanceCorrectionSchedule').value
  const newClockIn = document.getElementById('teamAttendanceNewClockIn').value
  const newClockOut = document.getElementById('teamAttendanceNewClockOut').value
  const newStatus = document.getElementById('teamAttendanceNewStatus').value
  const reasonCode = document.getElementById('teamAttendanceReasonCode').value
  const reasonNotes = document.getElementById('teamAttendanceReasonNotes').value
  const adminNotes = document.getElementById('teamAttendanceAdminNotes').value

  if (!attendanceId) {
    setMessage(messageElement, 'Attendance record is missing.', 'error')
    return
  }

  if (!reasonCode) {
    setMessage(messageElement, 'Select a correction reason.', 'error')
    return
  }

  if (reasonCode === 'other' && !reasonNotes.trim()) {
    setMessage(messageElement, 'Notes are required when the reason is Other.', 'error')
    return
  }

  setMessage(messageElement, 'Submitting correction…')

  const parseInput = value => value ? new Date(value).toISOString() : null

  const { data, error } = await supabase.rpc('workforce_correct_attendance', {
    p_attendance_id: attendanceId,
    p_new_clock_in: parseInput(newClockIn),
    p_new_clock_out: parseInput(newClockOut),
    p_new_status: newStatus,
    p_schedule_id: scheduleId || null,
    p_admin_notes: adminNotes || null,
    p_reason_code: reasonCode,
    p_reason_notes: reasonNotes || null
  })

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
  elements.addButton.hidden = !(
    access.is_admin === true && hasWorkforcePermission(access, 'manage_schedules')
  )

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
