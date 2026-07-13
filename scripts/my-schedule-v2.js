import { supabase } from './supabaseClient.js?v=9'
import {
  hasWorkforcePermission,
  loadCurrentWorkforceAccess
} from './workforce-permissions.js?v=1'

const RELEASED_STATUSES = Object.freeze([
  'published',
  'changed',
  'cancelled',
  'completed'
])

const STATUS_LABELS = Object.freeze({
  scheduled: 'Scheduled',
  published: 'Published',
  changed: 'Changed',
  cancelled: 'Cancelled',
  completed: 'Completed'
})

const TABLE_PAGE_SIZE = 10

const elements = {
  calendar: document.getElementById('myScheduleCalendar'),
  tableBody: document.getElementById('myScheduleTableBody'),
  message: document.getElementById('myScheduleMessage'),
  rangeLabel: document.getElementById('myScheduleRangeLabel'),
  view: document.getElementById('myScheduleView'),
  scope: document.getElementById('myScheduleScope'),
  employee: document.getElementById('myScheduleEmployee'),
  status: document.getElementById('myScheduleStatus'),
  scopeField: document.getElementById('scheduleScopeField'),
  employeeField: document.getElementById('scheduleEmployeeField'),
  previous: document.getElementById('previousMyScheduleRange'),
  current: document.getElementById('currentMyScheduleRange'),
  next: document.getElementById('nextMyScheduleRange'),
  refresh: document.getElementById('refreshMyScheduleButton'),
  tablePagination: document.getElementById('myScheduleTablePagination'),
  tablePageInfo: document.getElementById('myScheduleTablePageInfo'),
  tablePrevious: document.getElementById('previousMyScheduleTablePage'),
  tableNext: document.getElementById('nextMyScheduleTablePage'),
  changeNotice: document.getElementById('scheduleChangeNotice'),
  subtitle: document.getElementById('schedulePageSubtitle'),
  modal: document.getElementById('myScheduleModal')
}

let access = null
let profiles = []
let schedules = []
let personalProfileIds = []
let anchorDate = todayInTimeZone('America/New_York')
let canManageSchedules = false
let canViewTeam = false
let lastFocusedElement = null
let tablePage = 1

function normalizeText(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function localPart(email) {
  return normalizeText(email).split('@')[0]
}

function firstName(value) {
  return normalizeText(value).split(/\s+/)[0]
}

function setMessage(text, type = '') {
  elements.message.textContent = text
  elements.message.className = type ? `wf-message ${type}` : 'wf-message'
}

function setLoading(loading) {
  elements.refresh.disabled = loading
  elements.refresh.textContent = loading ? 'Refreshing...' : 'Refresh'
}

function errorMessage(error) {
  return error?.message || 'An unexpected error occurred.'
}

function parseDateKey(value) {
  const [year, month, day] = String(value).split('-').map(Number)
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
  if (elements.view.value === 'month') {
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

function formatDateTime(value, timeZone = 'America/New_York') {
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
    timeZone: schedule.timezone || 'America/New_York',
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
  return profile?.full_name || (personalProfileIds.includes(userId) ? access.full_name : 'Unknown employee')
}

function currentScope() {
  return canViewTeam && elements.scope.value === 'team' ? 'team' : 'self'
}

function resolvePersonalProfileIds() {
  const ids = new Set()
  const accessEmail = normalizeText(access.email)
  const accessName = normalizeText(access.full_name)
  const accessLocalPart = localPart(accessEmail)

  for (const profile of profiles) {
    const profileEmail = normalizeText(profile.email)
    const profileName = normalizeText(profile.full_name)
    const profileLocalPart = localPart(profileEmail)

    const exactUser = profile.user_id === access.user_id
    const exactEmail = Boolean(accessEmail && profileEmail === accessEmail)
    const exactName = Boolean(accessName && profileName === accessName)
    const matchingLocalPart = Boolean(
      accessLocalPart &&
      profileLocalPart &&
      profileLocalPart === accessLocalPart
    )
    const matchingWorkforceName = Boolean(
      canManageSchedules &&
      accessLocalPart.length >= 3 &&
      firstName(profileName) === accessLocalPart
    )

    if (
      exactUser ||
      exactEmail ||
      exactName ||
      matchingLocalPart ||
      matchingWorkforceName
    ) {
      ids.add(profile.user_id)
    }
  }

  ids.add(access.user_id)
  personalProfileIds = [...ids].filter(Boolean)
}

function visibleSchedules() {
  const selectedStatus = elements.status.value
  const selectedEmployee = currentScope() === 'team'
    ? elements.employee.value
    : ''

  return schedules.filter(schedule => {
    const matchesStatus = !selectedStatus || schedule.status === selectedStatus
    const matchesEmployee = !selectedEmployee || schedule.user_id === selectedEmployee
    return matchesStatus && matchesEmployee
  })
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

function scheduleType(schedule) {
  const parts = [schedule.is_rest_day ? 'Rest day' : 'Shift']
  if (schedule.is_holiday) parts.push(schedule.holiday_name || 'Holiday')
  return parts.join(' · ')
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
    elements.changeNotice.hidden = true
    return
  }

  document.getElementById('scheduleChangeNoticeTitle').textContent =
    `${changed.length} changed schedule ${changed.length === 1 ? 'entry' : 'entries'}`
  document.getElementById('scheduleChangeNoticeText').textContent =
    `${changed.length} ${changed.length === 1 ? 'entry has' : 'entries have'} been updated after publication. Open the highlighted entries to review the latest details.`
  elements.changeNotice.hidden = false
}

function createCalendarEntry(schedule) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'schedule-entry'
  if (schedule.status === 'changed') button.classList.add('changed')
  if (schedule.status === 'scheduled') button.classList.add('scheduled')
  if (schedule.status === 'cancelled') button.classList.add('cancelled')
  if (schedule.status === 'completed') button.classList.add('completed')
  if (schedule.is_rest_day) button.classList.add('rest-day')
  button.setAttribute(
    'aria-label',
    `${employeeName(schedule.user_id)}, ${formatDate(schedule.shift_date)}, ${formatShift(schedule)}, ${STATUS_LABELS[schedule.status] || schedule.status}`
  )

  const content = document.createElement('span')
  content.className = 'schedule-entry-content'

  const time = document.createElement('span')
  time.className = 'schedule-entry-time'
  time.textContent = formatShift(schedule)

  const person = document.createElement('span')
  person.className = 'schedule-entry-person'
  person.textContent = currentScope() === 'team'
    ? employeeName(schedule.user_id)
    : scheduleType(schedule)

  content.append(time, person)
  button.appendChild(content)
  button.addEventListener('click', () => openScheduleDetails(schedule.id))
  return button
}

function renderCalendar(rows) {
  elements.calendar.replaceChildren()
  const range = selectedRange()
  const schedulesByDate = new Map()

  for (const schedule of rows) {
    const list = schedulesByDate.get(schedule.shift_date) || []
    list.push(schedule)
    schedulesByDate.set(schedule.shift_date, list)
  }

  if (elements.view.value === 'month') {
    const leadingDay = parseDateKey(range.start).getUTCDay()
    const leadingBlankCount = leadingDay === 0 ? 6 : leadingDay - 1
    for (let index = 0; index < leadingBlankCount; index += 1) {
      const blank = document.createElement('div')
      blank.className = 'schedule-day outside-month'
      blank.setAttribute('aria-hidden', 'true')
      elements.calendar.appendChild(blank)
    }
  }

  const today = todayInTimeZone(access?.timezone || 'America/New_York')
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
    count.textContent = daySchedules.length
      ? `${daySchedules.length} ${daySchedules.length === 1 ? 'entry' : 'entries'}`
      : ''
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
    elements.calendar.appendChild(day)
    cursor = addDays(cursor, 1)
  }
}

function renderTable(rows) {
  elements.tableBody.replaceChildren()

  if (!rows.length) {
    elements.tablePagination.hidden = true
    const row = document.createElement('tr')
    const cell = document.createElement('td')
    cell.colSpan = 7
    cell.className = 'wf-empty'
    cell.textContent = 'No schedule entries match the selected range and filters.'
    row.appendChild(cell)
    elements.tableBody.appendChild(row)
    return
  }

  const pageCount = Math.ceil(rows.length / TABLE_PAGE_SIZE)
  tablePage = Math.min(Math.max(tablePage, 1), pageCount)
  const pageStart = (tablePage - 1) * TABLE_PAGE_SIZE
  const pageRows = rows.slice(pageStart, pageStart + TABLE_PAGE_SIZE)

  elements.tablePagination.hidden = rows.length <= TABLE_PAGE_SIZE
  elements.tablePageInfo.textContent = `Page ${tablePage} of ${pageCount}`
  elements.tablePrevious.disabled = tablePage === 1
  elements.tableNext.disabled = tablePage === pageCount

  pageRows.forEach(schedule => {
    const row = document.createElement('tr')
    const typeCell = document.createElement('td')
    const statusCell = document.createElement('td')
    const detailsCell = document.createElement('td')
    detailsCell.className = 'wf-row-actions'

    typeCell.appendChild(badge(scheduleType(schedule), schedule.is_rest_day ? 'muted' : ''))
    statusCell.appendChild(badge(
      STATUS_LABELS[schedule.status] || schedule.status,
      statusModifier(schedule.status)
    ))

    const detailsButton = document.createElement('button')
    detailsButton.type = 'button'
    detailsButton.className = 'schedule-details-button'
    detailsButton.textContent = 'View'
    detailsButton.addEventListener('click', () => openScheduleDetails(schedule.id))
    detailsCell.appendChild(detailsButton)

    row.append(
      textCell(formatDate(schedule.shift_date)),
      textCell(employeeName(schedule.user_id)),
      textCell(formatShift(schedule), schedule.timezone),
      typeCell,
      statusCell,
      textCell(formatDateTime(schedule.updated_at, schedule.timezone)),
      detailsCell
    )
    elements.tableBody.appendChild(row)
  })
}

function render() {
  const rows = visibleSchedules()
    .slice()
    .sort((a, b) => a.shift_date.localeCompare(b.shift_date) || a.shift_sequence - b.shift_sequence)

  elements.rangeLabel.textContent = formatRange(selectedRange())
  renderSummary(rows)
  renderChangeNotice(rows)
  renderCalendar(rows)
  renderTable(rows)
  setMessage(`${rows.length} schedule ${rows.length === 1 ? 'entry' : 'entries'} shown.`)
}

function populateEmployeeFilter() {
  const current = elements.employee.value
  elements.employee.replaceChildren(new Option('All permitted employees', ''))

  profiles
    .filter(profile => profile.is_agent === true && ['active', 'on_leave'].includes(profile.employment_status))
    .sort((left, right) => left.full_name.localeCompare(right.full_name))
    .forEach(profile => {
      const label = profile.employee_id
        ? `${profile.full_name} — ${profile.employee_id}`
        : profile.full_name
      elements.employee.appendChild(new Option(label, profile.user_id))
    })

  if ([...elements.employee.options].some(option => option.value === current)) {
    elements.employee.value = current
  }
}

async function loadReferenceData() {
  const { data, error } = await supabase
    .from('profiles')
    .select('user_id, full_name, email, employee_id, team_id, employment_status, is_agent')
    .order('full_name')

  if (error) throw error
  profiles = data || []
  resolvePersonalProfileIds()
  populateEmployeeFilter()
}

async function loadSchedules() {
  const range = selectedRange()
  // Build the base query and then constrain user ids depending on scope
  const rangeStart = range.start
  const rangeEnd = range.end

  if (!profiles.length && currentScope() === 'team') {
    schedules = []
    render()
    return
  }

  if (!personalProfileIds.length && currentScope() !== 'team') {
    schedules = []
    render()
    return
  }

  let query = supabase
    .from('work_schedules')
    .select('id, user_id, team_id, shift_date, shift_sequence, shift_start, shift_end, timezone, status, is_rest_day, is_holiday, holiday_name, notes, updated_at')

  // constrain by user id depending on scope
  if (currentScope() === 'team') {
    query = query.in('user_id', profiles.map(profile => profile.user_id))
  } else {
    query = query.in('user_id', personalProfileIds)
  }

  query = query.gte('shift_date', rangeStart).lte('shift_date', rangeEnd)

  if (!canManageSchedules) {
    query = query.in('status', RELEASED_STATUSES)
  }

  const { data, error } = await query
    .order('shift_date')
    .order('shift_sequence')

  if (error) throw error
  schedules = data || []
  render()
}

function setAnchor(direction) {
  if (elements.view.value === 'month') anchorDate = addMonths(anchorDate, direction)
  else anchorDate = addDays(anchorDate, direction * 7)
}

async function refresh() {
  tablePage = 1
  setLoading(true)
  setMessage('Loading schedule entries...')

  try {
    await loadSchedules()
  } catch (error) {
    setMessage(errorMessage(error), 'error')
  } finally {
    setLoading(false)
  }
}

function openScheduleDetails(scheduleId) {
  const schedule = schedules.find(item => item.id === scheduleId)
  if (!schedule) return

  document.getElementById('myScheduleModalTitle').textContent = formatShift(schedule)
  document.getElementById('detailEmployee').textContent = employeeName(schedule.user_id)
  document.getElementById('detailDate').textContent = formatDate(schedule.shift_date)
  document.getElementById('detailShift').textContent = formatShift(schedule)
  document.getElementById('detailTimezone').textContent = schedule.timezone || 'America/New_York'
  document.getElementById('detailType').textContent = scheduleType(schedule)
  document.getElementById('detailStatus').textContent = STATUS_LABELS[schedule.status] || schedule.status
  document.getElementById('detailUpdated').textContent = formatDateTime(schedule.updated_at, schedule.timezone)
  document.getElementById('detailNotes').textContent = schedule.notes || 'No notes provided.'
  document.getElementById('detailChangedNote').hidden = schedule.status !== 'changed'

  lastFocusedElement = document.activeElement
  elements.modal.hidden = false
  document.body.classList.add('modal-open')
  requestAnimationFrame(() => elements.modal.querySelector('[data-my-schedule-close]')?.focus())
}

function closeScheduleDetails() {
  elements.modal.hidden = true
  document.body.classList.remove('modal-open')
  if (lastFocusedElement instanceof HTMLElement) lastFocusedElement.focus()
}

function updateScopeUi() {
  const teamMode = currentScope() === 'team'
  const defaultIsSelf = currentScope() === 'self'
  elements.employeeField.hidden = !teamMode
  elements.subtitle.textContent = teamMode
    ? 'View permitted team schedules, rest days, holidays, and schedule changes.'
    : 'View assigned shifts, rest days, holidays, and schedule changes.'
}

function bindEvents() {
  elements.previous.addEventListener('click', async () => {
    setAnchor(-1)
    await refresh()
  })

  elements.current.addEventListener('click', async () => {
    anchorDate = todayInTimeZone(access?.timezone || 'America/New_York')
    await refresh()
  })

  elements.next.addEventListener('click', async () => {
    setAnchor(1)
    await refresh()
  })

  elements.refresh.addEventListener('click', refresh)
  elements.view.addEventListener('change', refresh)
  elements.status.addEventListener('change', () => {
    tablePage = 1
    render()
  })
  elements.employee.addEventListener('change', () => {
    tablePage = 1
    render()
  })
  elements.tablePrevious.addEventListener('click', () => {
    if (tablePage <= 1) return
    tablePage -= 1
    render()
  })
  elements.tableNext.addEventListener('click', () => {
    tablePage += 1
    render()
  })
  elements.scope.addEventListener('change', async () => {
    updateScopeUi()
    await refresh()
  })

  document.querySelectorAll('[data-my-schedule-close]').forEach(button => {
    button.addEventListener('click', closeScheduleDetails)
  })

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !elements.modal.hidden) closeScheduleDetails()
  })
}

async function initialize() {
  access = await loadCurrentWorkforceAccess(supabase)

  if (!access.authenticated) {
    window.location.replace(`./login.html?returnTo=${encodeURIComponent('./my-schedule.html')}`)
    return
  }

  // Determine whether the current user can manage schedules early so callers
  // can allow non-agent admins who have management permission to access.
  canManageSchedules = access.is_admin === true && hasWorkforcePermission(access, 'manage_schedules')
  // Default permission pairing: managers may view team schedules by default
  canViewTeam = canManageSchedules

  if (!access.allowed || (access.is_agent !== true && !canManageSchedules)) {
    window.alert('Schedule access is available only to active agent profiles.')
    window.location.replace('./home.html')
    return
  }

  // Default UI state; actual `canViewTeam` is computed after loading profiles
  elements.scopeField.hidden = true
  elements.scope.value = 'self'
  elements.employeeField.hidden = true

  const workforceLink = document.getElementById('scheduleWorkforceLink')
  workforceLink.hidden = !canManageSchedules

  bindEvents()
  updateScopeUi()
  await loadReferenceData()
  // If linked identities were resolved, allow switching to team view when
  // applicable. This check verifies that the resolution happened.
  if (personalProfileIds.length > 1) {
    // linked workforce identities were checked
  }

  // Recompute team visibility now that profiles and linked identities exist
  canViewTeam = canManageSchedules && profiles.some(profile => !personalProfileIds.includes(profile.user_id))
  elements.scopeField.hidden = !canViewTeam
  elements.scope.value = canViewTeam ? 'team' : 'self'
  elements.employeeField.hidden = true
  await refresh()
}

initialize().catch(error => {
  console.error('Schedule initialization failed:', error)
  setMessage(errorMessage(error), 'error')
})
