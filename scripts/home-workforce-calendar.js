import { supabase } from './supabaseClient.js?v=9'
import { loadCurrentWorkforceAccess } from './workforce-permissions.js?v=1'

const VISIBLE_SCHEDULE_STATUSES = Object.freeze([
  'published',
  'changed',
  'cancelled',
  'completed'
])

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

const state = {
  access: null,
  profileIds: [],
  schedules: [],
  rangeKey: '',
  loading: false,
  refreshQueued: false
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

    state.profileIds = [...new Set([
      ...(Array.isArray(state.access.linked_profile_ids)
        ? state.access.linked_profile_ids
        : []),
      state.access.user_id
    ].filter(Boolean))]

    if (!state.profileIds.length) return

    installCalendarNavigationRefresh()
    await refreshVisibleScheduleMonth()
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
      const { data, error } = await supabase
        .from('work_schedules')
        .select('id, user_id, shift_date, shift_sequence, shift_start, shift_end, timezone, status, is_rest_day, is_holiday, holiday_name')
        .in('user_id', state.profileIds)
        .gte('shift_date', range.start)
        .lte('shift_date', range.end)
        .in('status', VISIBLE_SCHEDULE_STATUSES)
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

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: schedule.timezone || state.access?.timezone || 'America/New_York',
    hour: 'numeric',
    minute: '2-digit'
  })

  const shift = `${formatter.format(new Date(schedule.shift_start))}–${formatter.format(new Date(schedule.shift_end))}`
  const holiday = schedule.is_holiday
    ? `, ${schedule.holiday_name || 'holiday'}`
    : ''

  return `${shift}${holiday}, ${status}`
}

function toLocalIsoDate(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
