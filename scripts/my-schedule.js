import { supabase } from './supabaseClient.js?v=9'
import {
  hasWorkforcePermission,
  loadCurrentWorkforceAccess
} from './workforce-permissions.js?v=1'

const calendar = document.getElementById('myScheduleCalendar')
const tableBody = document.getElementById('myScheduleTableBody')
const pageMessage = document.getElementById('myScheduleMessage')
const rangeLabel = document.getElementById('myScheduleRangeLabel')
const viewSelect = document.getElementById('myScheduleView')
const scopeSelect = document.getElementById('myScheduleScope')
const employeeSelect = document.getElementById('myScheduleEmployee')
const statusSelect = document.getElementById('myScheduleStatus')
const scopeField = document.getElementById('scheduleScopeField')
const employeeField = document.getElementById('scheduleEmployeeField')
const previousButton = document.getElementById('previousMyScheduleRange')
const currentButton = document.getElementById('currentMyScheduleRange')
const nextButton = document.getElementById('nextMyScheduleRange')
const refreshButton = document.getElementById('refreshMyScheduleButton')
const changeNotice = document.getElementById('scheduleChangeNotice')

let access = null
let profiles = []
let schedules = []
let anchorDate = todayInTimeZone('Asia/Manila')
let canViewTeam = false
let lastFocusedElement = null

const STATUS_LABELS = Object.freeze({
  scheduled: 'Scheduled',
  published: 'Published',
  changed: 'Changed',
  cancelled: 'Cancelled',
  completed: 'Completed'
})

function setMessage(text, type = '') {
  pageMessage.textContent = text
  pageMessage.className = type ? `wf-message ${type}` : 'wf-message'
}

function setLoading(loading) {
  refreshButton.disabled = loading
  refreshButton.textContent = loading ? 'Refreshing...' : 'Refresh'
}

function errorMessage(error) {
  return error?.message || 'An unexpected error occurred.'
}

function parseDateKey(value) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

function dateKey(date) {
  return date.toISOString().slice(0, 10)
}

function addDays(value, amount) {
  const date = parseDateKey(value)
  date.setUTCDate(date.getUTCDate() + amount)
  return dateKey(date)
}

function addMonths(value, amount) {
  const date = parseDateKey(value)
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() + amount)
  return dateKey(date)
}

function startOfWeek(value) {
  const date = parseDateKey(value)
  const day = date.getUTCDay()
  date.setUTCDate(date.getUTCDate() + (day === 0 ? -6 : 1 - day))
  return dateKey(date)
}

function endOfMonth(value) {
  const date = parseDateKey(value)
  date.setUTCMonth(date.getUTCMonth() + 1, 0)
  return dateKey(date)
}

function todayInTimeZone(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date())
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${map.year}-${map.month}-${map.day}`
}

function selectedRange() {
  if (viewSelect.value === 'month') {
    const start = `${anchorDate.slice(0, 7)}-01`
    return { start, end: endOfMonth(start) }
  }

  const start = startOfWeek(anchorDate)
  return { start, end: addDays(start, 6) }
}

function formatRange({ start, end }) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
  return `${formatter.format(parseDateKey(start))} – ${formatter.format(parseDateKey(end))}`
}

function formatDate(value, includeWeekday = true) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    ...(includeWeekday ? { weekday: 'short' } : {}),
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(parseDateKey(value))
}

function formatDateTime(value, timeZone = 'Asia/Manila') {
  if (!value) return '—'
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(value))
}

function formatShift(schedule) {
  if (schedule.is_rest_day) return 'Rest day'
  if (!schedule.shift_start || !schedule.shift_end) return 'Time not available'

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: schedule.timezone || 'Asia/Manila',
    hour: 'numeric',
    minute: '2-digit'
  })
  return `${formatter.format(new Date(schedule.shift_start))} – ${formatter.format(new Date(schedule.shift_end))}`
}

function profileById(userId) {
  return profiles.find(profile => profile.user_id === userId)
}

function employeeName(userId) {
  const profile = profileById(userId)
  return profile?.full_name || (userId === access?.user_id ? access.full_name : 'Unknown employee')
}

function statusModifier(status) {
  if (status === 'published' || status === 'completed') return 'success'
  if (status === 'changed' || status === 'scheduled') return 'warning'
  if (status === 'cancelled') return 'danger'
  return 'muted'
}

function badge(text, modifier = '') {
  const span = document.createElement('span')
  span.className = modifier ? `wf-badge ${modifier}` : 'wf-badge'
  span.textContent = text
  return span
}

function textCell(primary, secondary = '') {
  const cell = document.createElement('td')
  const main = document.createElement('span')
  main.className = 'wf-person'
  main.textContent = primary || '—'
  cell.appendChild(main)

  if (secondary) {
    const sub = document.createElement('span')
    sub.className = 'wf-subtext'
    sub.textContent = secondary
    cell.appendChild(sub)
  }

  return cell
}

function currentScope() {
  return canViewTeam && scopeSelect.value === 'team' ? 'team' : 'self'
}

function visibleSchedules() {
  const selectedStatus = statusSelect.value
  const selectedEmployee = currentScope() === 'team' ? employeeSelect.value : access.user_id

  return schedules.filter(schedule => {
    const matchesStatus = !selectedStatus || schedule.status === selectedStatus
    const matchesEmployee = !selectedEmployee || schedule.user_id === selectedEmployee
    return matchesStatus && matchesEmployee
  })
}

function renderSummary(rows) {
  document.getElementById('myScheduleCount').textContent = rows.length
  document.getElementById('myPublishedCount').textContent = rows.filter(item => item.status === 'published').length
  document.getElementById('myChangedCount').textContent = rows.filter(item => item.status === 'changed').length
  document.getElementById('myRestDayCount').textContent = rows.filter(item => item.is_rest_day).length
}

function renderChangeNotice(rows) {
  const changed = rows.filter(schedule => schedule.status === 'changed')
  if (!changed.length) {
    changeNotice.hidden = true
    return
  }

  const noun = changed.length === 1 ? 'entry has' : 'entries have'
  document.getElementById('scheduleChangeNoticeTitle').textContent = `${changed.length} changed schedule ${changed.length === 1 ? 'entry' : 'entries'}`
  document.getElementById('scheduleChangeNoticeText').textContent = `${changed.length} ${noun} been updated after publication. Open the highlighted entries to review the latest details.`
  changeNotice.hidden = false
}

function scheduleType(schedule) {
  const parts = []
  parts.push(schedule.is_rest_day ? 'Rest day' : 'Shift')
  if (schedule.is_holiday) parts.push(schedule.holiday_name || 'Holiday')
  return parts.join(' · ')
}

function createCalendarEntry(schedule) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'schedule-entry'
  if (schedule.status === 'changed') button.classList.add('changed')
  if (schedule.status === 'cancelled') button.classList.add('cancelled')
  if (schedule.is_rest_day) button.classList.add('rest-day')
  button.setAttribute('aria-label', `${employeeName(schedule.user_id)}, ${formatDate(schedule.shift_date)}, ${formatShift(schedule)}, ${STATUS_LABELS[schedule.status] || schedule.status}`)

  const time = document.createElement('span')
  time.className = 'schedule-entry-time'
  time.textContent = formatShift(schedule)

  const person = document.createElement('span')
  person.className = 'schedule-entry-person'
  person.textContent = currentScope() === 'team' ? employeeName(schedule.user_id) : scheduleType(schedule)

  const status = document.createElement('span')
  status.className = 'schedule-entry-status'
  status.textContent = STATUS_LABELS[schedule.status] || schedule.status

  button.append(time, person, status)
  button.addEventListener('click', () => openScheduleDetails(schedule.id))
  return button
}

function renderCalendar(rows) {
  calendar.replaceChildren()
  const range = selectedRange()
  const schedulesByDate = new Map()

  for (const schedule of rows) {
    const list = schedulesByDate.get(schedule.shift_date) || []
    list.push(schedule)
    schedulesByDate.set(schedule.shift_date, list)
  }

  if (viewSelect.value === 'month') {
    const leadingDay = parseDateKey(range.start).getUTCDay()
    const leadingBlankCount = leadingDay === 0 ? 6 : leadingDay - 1
    for (let index = 0; index < leadingBlankCount; index += 1) {
      const blank = document.createElement('div')
      blank.className = 'schedule-day outside-month'
      blank.setAttribute('aria-hidden', 'true')
      calendar.appendChild(blank)
    }
  }

  const today = todayInTimeZone(access?.timezone || 'Asia/Manila')
  let cursor = range.start

  while (cursor <= range.end) {
    const day = document.createElement('article')
    day.className = 'schedule-day'
    if (cursor === today) day.classList.add('today')

    const header = document.createElement('div')
    header.className = 'schedule-day-header'

    const number = document.createElement('span')
    number.className = 'schedule-day-number'
    number.textContent = String(parseDateKey(cursor).getUTCDate())

    const daySchedules = (schedulesByDate.get(cursor) || [])
      .slice()
      .sort((a, b) => a.shift_sequence - b.shift_sequence)

    const count = document.createElement('span')
    count.className = 'schedule-day-count'
    count.textContent = daySchedules.length ? `${daySchedules.length} ${daySchedules.length === 1 ? 'entry' : 'entries'}` : ''
    header.append(number, count)

    const list = document.createElement('div')
    list.className = 'schedule-entry-list'

    if (daySchedules.length) {
      daySchedules.forEach(schedule => list.appendChild(createCalendarEntry(schedule)))
    } else {
      const empty = document.createElement('span')
      empty.className = 'schedule-empty-day'
      empty.textContent = 'No schedule'
      list.appendChild(empty)
    }

    day.append(header, list)
    calendar.appendChild(day)
    cursor = addDays(cursor, 1)
  }
}

function renderTable(rows) {
  tableBody.replaceChildren()

  if (!rows.length) {
    const row = document.createElement('tr')
    const cell = document.createElement('td')
    cell.colSpan = 7
    cell.className = 'wf-empty'
    cell.textContent = 'No schedule entries match the selected range and filters.'
    row.appendChild(cell)
    tableBody.appendChild(row)
    return
  }

  rows
    .slice()
    .sort((a, b) => a.shift_date.localeCompare(b.shift_date) || a.shift_sequence - b.shift_sequence)
    .forEach(schedule => {
      const row = document.createElement('tr')
      const typeCell = document.createElement('td')
      const statusCell = document.createElement('td')
      const actionCell = document.createElement('td')

      typeCell.appendChild(badge(schedule.is_rest_day ? 'Rest day' : 'Shift', schedule.is_rest_day ? 'muted' : ''))
      if (schedule.is_holiday) typeCell.appendChild(badge(schedule.holiday_name || 'Holiday', 'warning'))
      statusCell.appendChild(badge(STATUS_LABELS[schedule.status] || schedule.status, statusModifier(schedule.status)))

      const detailsButton = document.createElement('button')
      detailsButton.type = 'button'
      detailsButton.className = 'schedule-details-button'
      detailsButton.textContent = 'View'
      detailsButton.addEventListener('click', () => openScheduleDetails(schedule.id))
      actionCell.appendChild(detailsButton)

      row.append(
        textCell(formatDate(schedule.shift_date), `Sequence ${schedule.shift_sequence}`),
        textCell(employeeName(schedule.user_id), profileById(schedule.user_id)?.employee_id || ''),
        textCell(formatShift(schedule), schedule.timezone || 'Asia/Manila'),
        typeCell,
        statusCell,
        textCell(formatDateTime(schedule.updated_at, schedule.timezone)),
        actionCell
      )
      tableBody.appendChild(row)
    })
}

function renderAll() {
  const rows = visibleSchedules()
  renderSummary(rows)
  renderChangeNotice(rows)
  renderCalendar(rows)
  renderTable(rows)
}

function populateEmployeeOptions() {
  const previous = employeeSelect.value
  employeeSelect.replaceChildren(new Option('All permitted employees', ''))
  profiles
    .slice()
    .sort((a, b) => a.full_name.localeCompare(b.full_name))
    .forEach(profile => employeeSelect.appendChild(new Option(
      `${profile.full_name} — ${profile.employee_id}`,
      profile.user_id
    )))

  if ([...employeeSelect.options].some(option => option.value === previous)) {
    employeeSelect.value = previous
  }
}

function updateScopeControls() {
  const teamScope = currentScope() === 'team'
  scopeField.hidden = !canViewTeam
  employeeField.hidden = !teamScope

  const scheduledOption = statusSelect.querySelector('option[value="scheduled"]')
  if (scheduledOption) scheduledOption.disabled = !teamScope
  if (!teamScope && statusSelect.value === 'scheduled') statusSelect.value = ''

  document.getElementById('schedulePageSubtitle').textContent = teamScope
    ? 'View schedules for employees within your authorized supervisory scope.'
    : 'View your assigned shifts, rest days, holidays, and schedule changes.'
}

async function loadProfiles() {
  const { data, error } = await supabase
    .from('profiles')
    .select('user_id, full_name, employee_id, employment_status, is_agent, team_id, supervisor_id, timezone')
    .order('full_name')

  if (error) throw error
  profiles = data || []
  canViewTeam = hasWorkforcePermission(access, 'manage_schedules') &&
    profiles.some(profile => profile.user_id !== access.user_id)

  if (!canViewTeam) scopeSelect.value = 'self'
  populateEmployeeOptions()
  updateScopeControls()
}

async function loadSchedules() {
  const range = selectedRange()
  rangeLabel.textContent = formatRange(range)
  setLoading(true)
  setMessage('Loading schedule entries...')

  try {
    let query = supabase
      .from('work_schedules')
      .select('id, user_id, team_id, shift_date, shift_sequence, shift_start, shift_end, timezone, status, is_rest_day, is_holiday, holiday_name, notes, updated_at')
      .gte('shift_date', range.start)
      .lte('shift_date', range.end)
      .order('shift_date')
      .order('shift_sequence')

    if (currentScope() === 'self') {
      query = query
        .eq('user_id', access.user_id)
        .in('status', ['published', 'changed', 'cancelled', 'completed'])
    }

    const { data, error } = await query
    if (error) throw error

    schedules = data || []
    renderAll()
    setMessage(`${schedules.length} schedule entr${schedules.length === 1 ? 'y' : 'ies'} loaded.`)
  } catch (error) {
    schedules = []
    renderAll()
    setMessage(errorMessage(error), 'error')
  } finally {
    setLoading(false)
  }
}

function openScheduleDetails(scheduleId) {
  const schedule = schedules.find(item => item.id === scheduleId)
  if (!schedule) return

  document.getElementById('detailEmployee').textContent = employeeName(schedule.user_id)
  document.getElementById('detailDate').textContent = formatDate(schedule.shift_date)
  document.getElementById('detailShift').textContent = formatShift(schedule)
  document.getElementById('detailTimezone').textContent = schedule.timezone || 'Asia/Manila'
  document.getElementById('detailType').textContent = scheduleType(schedule)
  document.getElementById('detailStatus').textContent = STATUS_LABELS[schedule.status] || schedule.status
  document.getElementById('detailUpdated').textContent = formatDateTime(schedule.updated_at, schedule.timezone)
  document.getElementById('detailNotes').textContent = schedule.notes || 'No notes provided.'
  document.getElementById('detailChangedNote').hidden = schedule.status !== 'changed'

  const modal = document.getElementById('myScheduleModal')
  lastFocusedElement = document.activeElement
  modal.hidden = false
  document.body.classList.add('modal-open')
  requestAnimationFrame(() => modal.querySelector('.wf-close')?.focus())
}

function closeScheduleDetails() {
  document.getElementById('myScheduleModal').hidden = true
  document.body.classList.remove('modal-open')
  if (lastFocusedElement instanceof HTMLElement) lastFocusedElement.focus()
}

async function initialize() {
  access = await loadCurrentWorkforceAccess(supabase)

  if (!access.authenticated) {
    window.location.replace(`./login.html?returnTo=${encodeURIComponent('./my-schedule.html')}`)
    return
  }

  if (!access.allowed) {
    window.alert('An active workforce profile is required to view schedules.')
    window.location.replace('./dashboard.html')
    return
  }

  const canManageSchedules = hasWorkforcePermission(access, 'manage_schedules')
  if (access.is_agent !== true && !canManageSchedules) {
    window.alert('Schedule access is available only to agents and authorized schedule managers.')
    window.location.replace('./dashboard.html')
    return
  }

  const workforceLink = document.getElementById('scheduleWorkforceLink')
  workforceLink.hidden = !(access.is_admin === true && hasWorkforcePermission(access, 'manage_employees'))

  document.querySelectorAll('[data-my-schedule-close]').forEach(button => {
    button.addEventListener('click', closeScheduleDetails)
  })
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeScheduleDetails()
  })

  previousButton.addEventListener('click', async () => {
    anchorDate = viewSelect.value === 'month' ? addMonths(anchorDate, -1) : addDays(anchorDate, -7)
    await loadSchedules()
  })
  currentButton.addEventListener('click', async () => {
    anchorDate = todayInTimeZone(access.timezone || 'Asia/Manila')
    await loadSchedules()
  })
  nextButton.addEventListener('click', async () => {
    anchorDate = viewSelect.value === 'month' ? addMonths(anchorDate, 1) : addDays(anchorDate, 7)
    await loadSchedules()
  })
  refreshButton.addEventListener('click', loadSchedules)
  viewSelect.addEventListener('change', loadSchedules)
  scopeSelect.addEventListener('change', async () => {
    updateScopeControls()
    await loadSchedules()
  })
  employeeSelect.addEventListener('change', renderAll)
  statusSelect.addEventListener('change', renderAll)

  await loadProfiles()
  await loadSchedules()
}

initialize().catch(error => {
  console.error('My Schedule initialization failed:', error)
  setMessage(errorMessage(error), 'error')
})
