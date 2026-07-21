import { supabase } from './supabaseClient.js?v=10'
import {
  hasWorkforcePermission,
  loadCurrentWorkforceAccess
} from './workforce-permissions.js?v=1'

const RELEASED_SCHEDULE_STATUSES = Object.freeze([
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

const MONTH_INDEX = Object.freeze({
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11
})

const UPCOMING_SCHEDULE_LIMIT = 5
const UPCOMING_LOOKAHEAD_DAYS = 90

const state = {
  access: null,
  profileIds: [],
  schedules: [],
  upcomingSchedules: [],
  rangeKey: '',
  loading: false,
  refreshQueued: false,
  canManageSchedules: false
}

document.addEventListener('DOMContentLoaded', initializeHomeWorkforceCalendar)

async function initializeHomeWorkforceCalendar() {
  const grid = document.getElementById('calendarGrid')
  const label = document.getElementById('calendarMonthLabel')

  if (!grid || !label) return

  try {
    state.access = await loadCurrentWorkforceAccess(supabase)

    if (!state.access.allowed || state.access.is_agent !== true) {
      return
    }

    state.canManageSchedules = Boolean(
      state.access.is_admin === true &&
      hasWorkforcePermission(state.access, 'manage_schedules')
    )

    state.profileIds = [...new Set([
      ...(Array.isArray(state.access.linked_profile_ids)
        ? state.access.linked_profile_ids
        : []),
      state.access.user_id
    ].filter(Boolean))]

    if (!state.profileIds.length) return

    installCalendarNavigationRefresh()
    await Promise.all([
      refreshVisibleScheduleMonth(),
      refreshUpcomingSchedules()
    ])
  } catch (error) {
    console.error('Home workforce calendar failed:', error)
  }
}

function installCalendarNavigationRefresh() {
  for (const id of ['calendarPrevious', 'calendarNext']) {
    document.getElementById(id)?.addEventListener('click', () => {
      window.requestAnimationFrame(() => refreshVisibleScheduleMonth())
    })
  }
}

function buildScheduleQuery(startDate, endDate) {
  let query = supabase
    .from('work_schedules')
    .select('id, user_id, shift_date, shift_sequence, shift_start, shift_end, timezone, status, is_rest_day, is_holiday, holiday_name, notes')
    .in('user_id', state.profileIds)
    .gte('shift_date', startDate)
    .lte('shift_date', endDate)

  if (!state.canManageSchedules) {
    query = query.in('status', RELEASED_SCHEDULE_STATUSES)
  }

  return query
}

async function refreshVisibleScheduleMonth() {
  if (state.loading) {
    state.refreshQueued = true
    return
  }

  const displayMonth = resolveDisplayedMonth()
  if (!displayMonth) return

  const range = calendarGridRange(displayMonth)
  const rangeKey = `${range.start}:${range.end}`

  state.loading = true
  state.refreshQueued = false

  try {
    if (state.rangeKey !== rangeKey) {
      const { data, error } = await buildScheduleQuery(range.start, range.end)
        .order('shift_date')
        .order('shift_sequence')

      if (error) throw error

      state.schedules = data || []
      state.rangeKey = rangeKey
    }

    applySchedulesToCalendar(displayMonth)
  } catch (error) {
    console.error('Home schedule calendar refresh failed:', error)
  } finally {
    state.loading = false

    if (state.refreshQueued) {
      state.refreshQueued = false
      window.requestAnimationFrame(() => refreshVisibleScheduleMonth())
    }
  }
}

async function refreshUpcomingSchedules() {
  const now = new Date()
  const today = dateKeyInTimeZone(now, state.access?.timezone || 'America/New_York')
  const endDate = addDays(today, UPCOMING_LOOKAHEAD_DAYS)

  try {
    const { data, error } = await buildScheduleQuery(today, endDate)
      .order('shift_date')
      .order('shift_sequence')
      .limit(30)

    if (error) throw error

    state.upcomingSchedules = (data || [])
      .filter(schedule => isUpcomingSchedule(schedule, now, today))
      .sort(compareUpcomingSchedules)
      .slice(0, UPCOMING_SCHEDULE_LIMIT)

    renderUpcomingSchedules()
  } catch (error) {
    console.error('Home upcoming schedule refresh failed:', error)
  }
}

function isUpcomingSchedule(schedule, now, today) {
  if (schedule.status === 'cancelled') {
    return false
  }

  if (schedule.shift_date > today) return true
  if (schedule.shift_date < today) return false
  if (schedule.status === 'completed') return true

  if (schedule.is_rest_day || schedule.is_holiday) return true
  if (!schedule.shift_end) return true

  return new Date(schedule.shift_end).getTime() > now.getTime()
}

function compareUpcomingSchedules(left, right) {
  const dateComparison = left.shift_date.localeCompare(right.shift_date)
  if (dateComparison !== 0) return dateComparison

  const leftTime = left.shift_start
    ? new Date(left.shift_start).getTime()
    : Number.POSITIVE_INFINITY
  const rightTime = right.shift_start
    ? new Date(right.shift_start).getTime()
    : Number.POSITIVE_INFINITY

  if (leftTime !== rightTime) return leftTime - rightTime
  return Number(left.shift_sequence || 0) - Number(right.shift_sequence || 0)
}

function renderUpcomingSchedules() {
  const list = document.getElementById('upcomingEventList')
  if (!list) return

  const recurringEvents = [...list.querySelectorAll('.home-static-event-card')]
  list.replaceChildren()

  if (!state.upcomingSchedules.length && !recurringEvents.length) {
    const empty = document.createElement('div')
    empty.className = 'home-schedule-empty'
    empty.innerHTML = '<strong>None</strong>'
    list.appendChild(empty)
    return
  }

  state.upcomingSchedules.forEach(schedule => {
    list.appendChild(createUpcomingScheduleCard(schedule))
  })

  recurringEvents.forEach(event => list.appendChild(event))
}

function createUpcomingScheduleCard(schedule) {
  const card = document.createElement('a')
  card.className = 'event-card home-schedule-event-card'
  card.href = './my-schedule.html'
  card.setAttribute('aria-label', `${formatScheduleDate(schedule.shift_date)}: ${scheduleDescription(schedule)}`)

  if (schedule.status === 'changed') card.classList.add('changed')
  if (schedule.status === 'scheduled') card.classList.add('scheduled')
  if (schedule.status === 'completed') card.classList.add('completed')

  const dateBox = document.createElement('div')
  dateBox.className = 'event-date-box'

  const date = parseDateKey(schedule.shift_date)
  const month = document.createElement('span')
  month.textContent = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short'
  }).format(date)

  const day = document.createElement('strong')
  day.textContent = String(date.getUTCDate())
  dateBox.append(month, day)

  const copy = document.createElement('div')
  copy.className = 'event-copy'

  const heading = document.createElement('strong')
  heading.textContent = upcomingScheduleTitle(schedule)
  copy.appendChild(heading)

  const metaText = upcomingScheduleMeta(schedule)
  if (metaText) {
    const meta = document.createElement('span')
    meta.className = 'home-schedule-event-meta'
    meta.textContent = metaText
    copy.appendChild(meta)
  }

  if (schedule.notes) {
    const notes = document.createElement('span')
    notes.className = 'home-schedule-event-note'
    notes.textContent = schedule.notes
    copy.appendChild(notes)
  }

  const type = document.createElement('span')
  const typeValue = scheduleType(schedule)
  type.className = `event-type ${typeValue.className}`
  type.textContent = typeValue.label

  card.append(dateBox, copy, type)
  return card
}

function upcomingScheduleTitle(schedule) {
  if (schedule.is_rest_day) {
    return schedule.is_holiday && schedule.holiday_name
      ? `Rest day · ${schedule.holiday_name}`
      : 'Rest day'
  }

  if (schedule.is_holiday && !schedule.shift_start) {
    return schedule.holiday_name || 'Holiday'
  }

  if (!schedule.shift_start || !schedule.shift_end) {
    return 'Shift time unavailable'
  }

  return formatShiftRange(schedule)
}

function upcomingScheduleMeta(schedule) {
  const details = []

  if (schedule.status === 'completed') {
    details.push('✓ Completed')
  } else if (schedule.status === 'changed' || schedule.status === 'scheduled') {
    details.push(STATUS_LABELS[schedule.status])
  }

  if (schedule.is_holiday && schedule.shift_start) {
    details.push(schedule.holiday_name || 'Holiday')
  }

  if (schedule.timezone && !schedule.is_rest_day) {
    details.push(schedule.timezone)
  }

  return details.filter(Boolean).join(' · ')
}

function scheduleType(schedule) {
  if (schedule.is_rest_day) {
    return { label: 'Rest day', className: 'rest-day' }
  }
  if (schedule.is_holiday) {
    return { label: 'Holiday', className: 'holiday' }
  }
  return { label: 'Shift', className: 'shift' }
}

function resolveDisplayedMonth() {
  const label = document.getElementById('calendarMonthLabel')
  const text = label?.textContent?.trim().toLowerCase()
  const match = text?.match(/^([a-z]+)\s+(\d{4})$/)

  if (!match) return null

  const month = MONTH_INDEX[match[1]]
  const year = Number(match[2])

  if (!Number.isInteger(month) || !Number.isInteger(year)) return null
  return new Date(year, month, 1)
}

function calendarGridRange(displayMonth) {
  const firstDay = new Date(
    displayMonth.getFullYear(),
    displayMonth.getMonth(),
    1
  )
  const start = new Date(
    firstDay.getFullYear(),
    firstDay.getMonth(),
    1 - firstDay.getDay()
  )
  const end = new Date(start)
  end.setDate(start.getDate() + 41)

  return {
    start: toLocalIsoDate(start),
    end: toLocalIsoDate(end),
    startDate: start
  }
}

function applySchedulesToCalendar(displayMonth) {
  const grid = document.getElementById('calendarGrid')
  if (!grid) return

  const buttons = [...grid.querySelectorAll('.calendar-day')]
  if (buttons.length !== 42) return

  const range = calendarGridRange(displayMonth)
  const schedulesByDate = new Map()

  for (const schedule of state.schedules) {
    const list = schedulesByDate.get(schedule.shift_date) || []
    list.push(schedule)
    schedulesByDate.set(schedule.shift_date, list)
  }

  buttons.forEach((button, index) => {
    const date = new Date(range.startDate)
    date.setDate(range.startDate.getDate() + index)
    const dateKey = toLocalIsoDate(date)
    const schedules = (schedulesByDate.get(dateKey) || [])
      .slice()
      .sort((left, right) => left.shift_sequence - right.shift_sequence)

    renderCalendarDay(button, date, schedules)
  })
}

function renderCalendarDay(button, date, schedules) {
  const dateNumber = document.createElement('span')
  dateNumber.className = 'home-calendar-date-number'
  dateNumber.textContent = String(date.getDate())

  button.replaceChildren(dateNumber)
  button.classList.remove(
    'has-work-schedule',
    'work-shift',
    'work-rest-day',
    'work-holiday',
    'work-cancelled',
    'work-changed'
  )
  button.removeAttribute('data-work-schedule-count')

  const baseLabel = date.toDateString()
  const existingEventTypes = ['meeting', 'training', 'deadline']
    .filter(type => button.classList.contains(type))

  if (!schedules.length) {
    button.setAttribute(
      'aria-label',
      `${baseLabel}${existingEventTypes.length ? `, ${existingEventTypes.join(', ')}` : ''}`
    )
    button.removeAttribute('title')
    button.onclick = null
    return
  }

  const scheduleLabel = compactScheduleLabel(schedules)
  const details = schedules.map(scheduleDescription).join('; ')
  const marker = document.createElement('span')
  marker.className = 'home-work-schedule-label'
  marker.textContent = scheduleLabel
  marker.setAttribute('aria-hidden', 'true')

  button.appendChild(marker)
  button.classList.add('has-work-schedule')
  button.dataset.workScheduleCount = String(schedules.length)
  applyScheduleClasses(button, schedules)
  button.title = details
  button.setAttribute(
    'aria-label',
    `${baseLabel}, My Schedule: ${details}${existingEventTypes.length ? `, ${existingEventTypes.join(', ')}` : ''}`
  )
  button.onclick = () => {
    window.location.href = './my-schedule.html'
  }
}

function applyScheduleClasses(button, schedules) {
  if (schedules.some(schedule => schedule.status === 'cancelled')) {
    button.classList.add('work-cancelled')
  }
  if (schedules.some(schedule => schedule.status === 'changed')) {
    button.classList.add('work-changed')
  }
  if (schedules.some(schedule => schedule.is_rest_day)) {
    button.classList.add('work-rest-day')
    return
  }
  if (schedules.some(schedule => schedule.is_holiday)) {
    button.classList.add('work-holiday')
    return
  }
  button.classList.add('work-shift')
}

function compactScheduleLabel(schedules) {
  if (schedules.length > 1) {
    return `${schedules.length} entries`
  }

  const schedule = schedules[0]

  if (schedule.status === 'cancelled') return 'Cancelled'
  if (schedule.is_rest_day) return 'Rest day'
  if (schedule.is_holiday) return 'Holiday'
  if (!schedule.shift_start) return 'Shift'

  return new Intl.DateTimeFormat('en-US', {
    timeZone: schedule.timezone || state.access?.timezone || 'America/New_York',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(schedule.shift_start))
}

function scheduleDescription(schedule) {
  const status = schedule.status === 'changed'
    ? 'changed'
    : schedule.status === 'cancelled'
      ? 'cancelled'
      : schedule.status

  if (schedule.is_rest_day) {
    return schedule.is_holiday && schedule.holiday_name
      ? `Rest day and ${schedule.holiday_name}, ${status}`
      : `Rest day, ${status}`
  }

  if (schedule.is_holiday && !schedule.shift_start) {
    return `${schedule.holiday_name || 'Holiday'}, ${status}`
  }

  if (!schedule.shift_start || !schedule.shift_end) {
    return `Shift time unavailable, ${status}`
  }

  const holiday = schedule.is_holiday
    ? `, ${schedule.holiday_name || 'holiday'}`
    : ''

  return `${formatShiftRange(schedule)}${holiday}, ${status}`
}

function formatShiftRange(schedule) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: schedule.timezone || state.access?.timezone || 'America/New_York',
    hour: 'numeric',
    minute: '2-digit'
  })

  return `${formatter.format(new Date(schedule.shift_start))} – ${formatter.format(new Date(schedule.shift_end))}`
}

function formatScheduleDate(value) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  }).format(parseDateKey(value))
}

function parseDateKey(value) {
  const [year, month, day] = String(value).split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

function dateKeyInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function addDays(value, amount) {
  const date = parseDateKey(value)
  date.setUTCDate(date.getUTCDate() + amount)
  return date.toISOString().slice(0, 10)
}

function toLocalIsoDate(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
