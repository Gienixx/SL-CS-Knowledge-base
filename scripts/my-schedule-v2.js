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

const LEAVE_TYPE_LABELS = Object.freeze({
  incentive_vl: 'Incentive VL',
  birthday_vl: 'Birthday VL',
  leave_without_pay: 'Leave Without Pay'
})

const ABSENCE_TYPE_LABELS = Object.freeze({
  with_notification: 'ABSENT with Notif',
  without_notification: 'Absent without Notif'
})

function specialScheduleLabel(schedule) {
  if (schedule.is_leave) return LEAVE_TYPE_LABELS[schedule.leave_type] || 'Leave'
  if (schedule.is_absent) return ABSENCE_TYPE_LABELS[schedule.absence_type] || 'Absent'
  return ''
}

const TABLE_PAGE_SIZE = 10
const SCHEDULE_EMPLOYEE_ORDER_STORAGE_KEY =
  'socialloop-my-schedule-employee-order-v1'

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
  dragHint: document.getElementById('scheduleDragHint'),
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

let draggedScheduleElement = null
let draggedScheduleDate = ''
let suppressScheduleClick = false

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
  if (schedule.is_leave || schedule.is_absent) return specialScheduleLabel(schedule)
  if (schedule.is_rest_day) return 'Rest day'
  if (!schedule.shift_start || !schedule.shift_end) return 'Open schedule'

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
  const isOpenSchedule = !schedule.is_leave && !schedule.is_absent && !schedule.is_rest_day && !schedule.is_holiday && !schedule.shift_start && !schedule.shift_end
  const parts = [schedule.is_absent ? 'Absent' : schedule.is_leave ? 'Leave' : schedule.is_rest_day ? 'Rest day' : isOpenSchedule ? 'Open schedule' : 'Shift']
  if (schedule.is_leave || schedule.is_absent) parts.push(specialScheduleLabel(schedule))
  if (schedule.is_holiday) parts.push(schedule.holiday_name || 'Holiday')
  return parts.join(' · ')
}

function renderSummary(rows) {
  document.getElementById('myScheduleCount').textContent = rows.length
  document.getElementById('myPublishedCount').textContent = rows.filter(item => item.status === 'published').length
  document.getElementById('myChangedCount').textContent = rows.filter(item => item.status === 'changed').length
  document.getElementById('myRestDayCount').textContent = rows.filter(item => item.is_rest_day).length
  document.getElementById('myLeaveCount').textContent = rows.filter(item => item.is_leave).length
  document.getElementById('myAbsentCount').textContent = rows.filter(item => item.is_absent).length
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

function readScheduleEmployeeOrder() {
  try {
    const stored = window.localStorage.getItem(
      SCHEDULE_EMPLOYEE_ORDER_STORAGE_KEY
    )

    if (!stored) return []

    const parsed = JSON.parse(stored)

    if (!Array.isArray(parsed)) return []

    return [
      ...new Set(
        parsed.filter(
          userId =>
            typeof userId === 'string' &&
            userId.trim()
        )
      )
    ]
  } catch {
    return []
  }
}

function writeScheduleEmployeeOrder(userIds) {
  const cleanOrder = [
    ...new Set(
      userIds.filter(
        userId =>
          typeof userId === 'string' &&
          userId.trim()
      )
    )
  ]

  window.localStorage.setItem(
    SCHEDULE_EMPLOYEE_ORDER_STORAGE_KEY,
    JSON.stringify(cleanOrder)
  )
}

function saveEmployeeOrderFromList(list) {
  const visibleOrder = [
    ...list.querySelectorAll(
      '.schedule-entry[data-user-id]'
    )
  ]
    .map(entry => entry.dataset.userId)
    .filter(Boolean)

  const uniqueVisibleOrder = [
    ...new Set(visibleOrder)
  ]

  if (!uniqueVisibleOrder.length) {
    return readScheduleEmployeeOrder()
  }

  const existingOrder =
    readScheduleEmployeeOrder()

  const visibleUserIds = new Set(
    uniqueVisibleOrder
  )

  /*
   * Preserve employees that are not present on the date being
   * rearranged. Insert the reordered visible employees where
   * the first matching employee previously appeared.
   */
  const firstExistingPosition =
    existingOrder.findIndex(
      userId => visibleUserIds.has(userId)
    )

  const retainedOrder =
    existingOrder.filter(
      userId => !visibleUserIds.has(userId)
    )

  const insertionPosition =
    firstExistingPosition === -1
      ? retainedOrder.length
      : Math.min(
          firstExistingPosition,
          retainedOrder.length
        )

  const mergedOrder = [
    ...retainedOrder.slice(
      0,
      insertionPosition
    ),
    ...uniqueVisibleOrder,
    ...retainedOrder.slice(
      insertionPosition
    )
  ]

  writeScheduleEmployeeOrder(mergedOrder)

  return mergedOrder
}

function preferredEmployeeOrderMap() {
  return new Map(
    readScheduleEmployeeOrder().map(
      (userId, index) => [userId, index]
    )
  )
}

function compareScheduleEntries(
  left,
  right,
  orderMap = preferredEmployeeOrderMap()
) {
  const leftPosition = orderMap.has(left.user_id)
    ? orderMap.get(left.user_id)
    : Number.MAX_SAFE_INTEGER

  const rightPosition = orderMap.has(right.user_id)
    ? orderMap.get(right.user_id)
    : Number.MAX_SAFE_INTEGER

  if (leftPosition !== rightPosition) {
    return leftPosition - rightPosition
  }

  /*
   * Keep multiple schedules belonging to the same employee
   * in their normal sequence.
   */
  const sequenceDifference =
    (Number(left.shift_sequence) || 0) -
    (Number(right.shift_sequence) || 0)

  if (sequenceDifference) {
    return sequenceDifference
  }

  const startDifference = String(
    left.shift_start || ''
  ).localeCompare(
    String(right.shift_start || '')
  )

  if (startDifference) {
    return startDifference
  }

  return employeeName(left.user_id)
    .localeCompare(employeeName(right.user_id))
}

function orderedDaySchedules(rows) {
  const orderMap =
    preferredEmployeeOrderMap()

  return rows
    .slice()
    .sort(
      (left, right) =>
        compareScheduleEntries(
          left,
          right,
          orderMap
        )
    )
}

function enableScheduleEntryDragging(button, schedule) {
  if (!canManageSchedules) return

  button.draggable = true
  button.classList.add('is-draggable')
  button.dataset.scheduleId = schedule.id
  button.dataset.userId = schedule.user_id || ''
  button.dataset.shiftDate = schedule.shift_date
  button.title =
    'Drag to set this employee’s position across all dates'

  button.addEventListener('dragstart', event => {
    draggedScheduleElement = button
    draggedScheduleDate = schedule.shift_date
    suppressScheduleClick = true

    button.classList.add('is-dragging')
    button.setAttribute('aria-grabbed', 'true')

    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData(
        'text/plain',
        schedule.id
      )
    }
  })

  button.addEventListener('dragend', () => {
    button.classList.remove('is-dragging')
    button.setAttribute('aria-grabbed', 'false')

    document
      .querySelectorAll(
        '.schedule-entry-list.is-drag-over'
      )
      .forEach(list => {
        list.classList.remove('is-drag-over')
      })

    draggedScheduleElement = null
    draggedScheduleDate = ''

    window.setTimeout(() => {
      suppressScheduleClick = false
    }, 0)
  })
}

function enableScheduleListDragging(list, shiftDate) {
  if (!canManageSchedules) return

  list.classList.add('is-sortable')
  list.dataset.shiftDate = shiftDate

  list.addEventListener('dragover', event => {
    if (
      !draggedScheduleElement ||
      draggedScheduleDate !== shiftDate
    ) {
      return
    }

    event.preventDefault()
    list.classList.add('is-drag-over')

    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move'
    }

    const eventTarget =
      event.target instanceof Element
        ? event.target
        : null

    const targetEntry = eventTarget?.closest(
      '.schedule-entry'
    )

    if (
      !targetEntry ||
      targetEntry === draggedScheduleElement ||
      targetEntry.parentElement !== list
    ) {
      return
    }

    const targetBounds =
      targetEntry.getBoundingClientRect()

    const insertAfter =
      event.clientY >
      targetBounds.top + targetBounds.height / 2

    list.insertBefore(
      draggedScheduleElement,
      insertAfter
        ? targetEntry.nextSibling
        : targetEntry
    )
  })

  list.addEventListener('dragleave', event => {
    if (!list.contains(event.relatedTarget)) {
      list.classList.remove('is-drag-over')
    }
  })

  list.addEventListener('drop', event => {
  if (
    !draggedScheduleElement ||
    draggedScheduleDate !== shiftDate
  ) {
    return
  }

  event.preventDefault()
  list.classList.remove('is-drag-over')

  try {
    saveEmployeeOrderFromList(list)

    /*
     * Re-render the full calendar so the same employee
     * arrangement immediately appears on every date.
     */
    window.requestAnimationFrame(() => {
      render()

      setMessage(
        'Preferred employee order saved and applied to all visible dates.',
        'success'
      )
    })
  } catch (error) {
    setMessage(errorMessage(error), 'error')
  }
})
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
  if (schedule.is_leave) button.classList.add('leave')
  if (schedule.is_absent) button.classList.add('absent')
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

  enableScheduleEntryDragging(button, schedule)

  button.addEventListener('click', event => {
    if (suppressScheduleClick) {
      event.preventDefault()
      return
    }

    openScheduleDetails(schedule.id)
  })

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

    const daySchedules = orderedDaySchedules(
      schedulesByDate.get(cursor) || []
    )

    const count = document.createElement('span')
    count.className = 'schedule-day-count'
    count.textContent = daySchedules.length
      ? `${daySchedules.length} ${daySchedules.length === 1 ? 'entry' : 'entries'}`
      : ''
    header.append(number, count)

    const list = document.createElement('div')
    list.className = 'schedule-entry-list'

    enableScheduleListDragging(list, cursor)

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

    typeCell.appendChild(badge(scheduleType(schedule), schedule.is_rest_day || schedule.is_leave || schedule.is_absent ? 'muted' : ''))
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
  const employeeOrder =
  preferredEmployeeOrderMap()

const rows = visibleSchedules()
  .slice()
  .sort((left, right) => {
    const dateDifference =
      left.shift_date.localeCompare(
        right.shift_date
      )

    if (dateDifference) {
      return dateDifference
    }

    return compareScheduleEntries(
      left,
      right,
      employeeOrder
    )
  })

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
    .select('id, user_id, team_id, shift_date, shift_sequence, shift_start, shift_end, timezone, status, is_rest_day, is_holiday, is_leave, is_absent, leave_type, absence_type, holiday_name, notes, updated_at')

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
  canManageSchedules =
    access.is_admin === true &&
    hasWorkforcePermission(
      access,
      'manage_schedules'
    )

  canViewTeam = canManageSchedules

  if (elements.dragHint) {
    elements.dragHint.hidden = !canManageSchedules
  }

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
