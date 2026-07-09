import { supabase } from './supabaseClient.js?v=8'

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

const UPCOMING_LIMIT = 5
const UPCOMING_LOOKAHEAD_DAYS = 90

const elements = {
  connectButton: document.getElementById('googleCalendarConnectButton'),
  disconnectButton: document.getElementById('googleCalendarDisconnectButton'),
  status: document.getElementById('googleCalendarStatus'),
  grid: document.getElementById('calendarGrid'),
  monthLabel: document.getElementById('calendarMonthLabel'),
  upcomingList: document.getElementById('upcomingEventList')
}

const state = {
  accessToken: '',
  configured: false,
  connected: false,
  calendarSummary: '',
  calendarTimezone: '',
  visibleEvents: [],
  upcomingEvents: [],
  visibleRangeKey: '',
  calendarObserver: null,
  upcomingObserver: null,
  applyingCalendar: false,
  applyingUpcoming: false,
  busy: false
}

document.addEventListener('DOMContentLoaded', initializeGoogleCalendar)

async function initializeGoogleCalendar() {
  if (!elements.connectButton || !elements.status || !elements.grid) return

  bindControls()
  showCallbackResult()

  const { data, error } = await supabase.auth.getSession()

  if (error || !data.session?.access_token) {
    setStatus('Sign in to connect Google Calendar.', 'error')
    setControls({ canConnect: false, connected: false })
    return
  }

  state.accessToken = data.session.access_token
  installObservers()
  installMonthNavigation()
  await refreshStatus()
}

function bindControls() {
  elements.connectButton.addEventListener('click', connectGoogleCalendar)
  elements.disconnectButton?.addEventListener('click', disconnectGoogleCalendar)
}

function installMonthNavigation() {
  for (const id of ['calendarPrevious', 'calendarNext']) {
    document.getElementById(id)?.addEventListener('click', () => {
      window.requestAnimationFrame(() => refreshVisibleEvents())
    })
  }
}

function installObservers() {
  state.calendarObserver = new MutationObserver(() => {
    if (!state.applyingCalendar && state.connected) {
      window.requestAnimationFrame(applyGoogleEventsToCalendar)
    }
  })
  state.calendarObserver.observe(elements.grid, {
    childList: true,
    subtree: true
  })

  if (elements.upcomingList) {
    state.upcomingObserver = new MutationObserver(() => {
      if (!state.applyingUpcoming && state.connected) {
        window.requestAnimationFrame(mergeGoogleUpcomingEvents)
      }
    })
    state.upcomingObserver.observe(elements.upcomingList, {
      childList: true,
      subtree: true
    })
  }
}

async function refreshStatus() {
  setStatus('Checking Google Calendar connection...')

  try {
    const response = await authorizedFetch('/google-calendar/status')
    const data = await response.json()

    if (!response.ok) {
      throw new Error(data.error || 'Unable to read Google Calendar status.')
    }

    state.configured = data.configured === true
    state.connected = data.connected === true
    state.calendarSummary = data.connection?.calendarSummary || 'Google Calendar'
    state.calendarTimezone = data.connection?.calendarTimezone || ''

    if (!state.configured) {
      setStatus('Google Calendar setup is not configured yet.', 'warning')
      setControls({ canConnect: false, connected: false })
      return
    }

    if (!state.connected) {
      setStatus('Google Calendar is not connected.')
      setControls({ canConnect: true, connected: false })
      clearGoogleCalendarUi()
      return
    }

    setStatus(`Connected: ${state.calendarSummary}`, 'success')
    setControls({ canConnect: true, connected: true })
    await Promise.all([
      refreshVisibleEvents(),
      refreshUpcomingEvents()
    ])
  } catch (error) {
    console.error('Google Calendar status failed:', error)
    setStatus(error.message || 'Unable to load Google Calendar.', 'error')
    setControls({ canConnect: false, connected: false })
  }
}

async function connectGoogleCalendar() {
  if (state.busy || !state.accessToken) return

  setBusy(true)
  setStatus('Opening Google authorization...')

  try {
    const response = await authorizedFetch('/google-calendar/connect', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ returnTo: './home.html' })
    })
    const data = await response.json()

    if (!response.ok || !data.authorizationUrl) {
      throw new Error(data.error || 'Unable to start Google authorization.')
    }

    window.location.assign(data.authorizationUrl)
  } catch (error) {
    console.error('Google Calendar connect failed:', error)
    setStatus(error.message || 'Unable to connect Google Calendar.', 'error')
    setBusy(false)
  }
}

async function disconnectGoogleCalendar() {
  if (state.busy || !state.accessToken) return

  setBusy(true)
  setStatus('Disconnecting Google Calendar...')

  try {
    const response = await authorizedFetch('/google-calendar/disconnect', {
      method: 'POST'
    })
    const data = await response.json()

    if (!response.ok) {
      throw new Error(data.error || 'Unable to disconnect Google Calendar.')
    }

    state.connected = false
    state.visibleEvents = []
    state.upcomingEvents = []
    state.visibleRangeKey = ''
    clearGoogleCalendarUi()
    setStatus('Google Calendar disconnected.', 'success')
    setControls({ canConnect: true, connected: false })
  } catch (error) {
    console.error('Google Calendar disconnect failed:', error)
    setStatus(error.message || 'Unable to disconnect Google Calendar.', 'error')
  } finally {
    setBusy(false)
  }
}

async function refreshVisibleEvents() {
  if (!state.connected || state.busy) return

  const displayMonth = resolveDisplayedMonth()
  if (!displayMonth) return

  const range = calendarGridRange(displayMonth)
  const rangeKey = `${range.start}:${range.end}`

  if (rangeKey === state.visibleRangeKey) {
    applyGoogleEventsToCalendar()
    return
  }

  try {
    const data = await fetchGoogleEvents(range.start, range.end)
    state.visibleEvents = data.events || []
    state.calendarTimezone = data.calendar?.timezone || state.calendarTimezone
    state.visibleRangeKey = rangeKey
    applyGoogleEventsToCalendar()
  } catch (error) {
    handleEventLoadError(error)
  }
}

async function refreshUpcomingEvents() {
  if (!state.connected) return

  const today = localDateKey(new Date(), state.calendarTimezone)
  const end = addDays(today, UPCOMING_LOOKAHEAD_DAYS)

  try {
    const data = await fetchGoogleEvents(today, end)
    state.upcomingEvents = (data.events || [])
      .filter(isUpcomingGoogleEvent)
      .sort(compareGoogleEvents)
    mergeGoogleUpcomingEvents()
  } catch (error) {
    handleEventLoadError(error)
  }
}

async function fetchGoogleEvents(start, end) {
  const query = new URLSearchParams({ start, end })
  const response = await authorizedFetch(
    `/google-calendar/events?${query.toString()}`
  )
  const data = await response.json()

  if (!response.ok) {
    const error = new Error(data.error || 'Unable to load Google Calendar events.')
    error.needsReconnect = data.needsReconnect === true
    throw error
  }

  return data
}

function applyGoogleEventsToCalendar() {
  if (!state.connected || state.applyingCalendar) return

  const displayMonth = resolveDisplayedMonth()
  const buttons = [...elements.grid.querySelectorAll('.calendar-day')]
  if (!displayMonth || buttons.length !== 42) return

  state.applyingCalendar = true
  state.calendarObserver?.disconnect()

  try {
    const range = calendarGridRange(displayMonth)
    const eventsByDate = mapEventsByDate(state.visibleEvents)

    buttons.forEach((button, index) => {
      removeGoogleCalendarDecoration(button)

      const date = new Date(range.startDate)
      date.setDate(range.startDate.getDate() + index)
      const dateKey = toLocalIsoDate(date)
      const events = eventsByDate.get(dateKey) || []

      if (!events.length) return

      const label = document.createElement('span')
      label.className = 'home-google-calendar-label'
      label.textContent = compactGoogleEventLabel(events)
      label.setAttribute('aria-hidden', 'true')
      button.appendChild(label)
      button.classList.add('has-google-calendar-event')

      const details = events.map(googleEventDescription).join('; ')
      const baseTitle = button.title || ''
      const baseAria = button.getAttribute('aria-label') || date.toDateString()
      button.title = [baseTitle, `Google Calendar: ${details}`]
        .filter(Boolean)
        .join('\n')
      button.setAttribute(
        'aria-label',
        `${baseAria}, Google Calendar: ${details}`
      )

      if (!button.classList.contains('has-work-schedule')) {
        const firstLink = events.find(event => event.htmlLink)?.htmlLink
        if (firstLink) {
          button.onclick = () => {
            window.open(firstLink, '_blank', 'noopener,noreferrer')
          }
        }
      }
    })
  } finally {
    state.applyingCalendar = false
    state.calendarObserver?.observe(elements.grid, {
      childList: true,
      subtree: true
    })
  }
}

function mergeGoogleUpcomingEvents() {
  if (!elements.upcomingList || state.applyingUpcoming) return

  state.applyingUpcoming = true
  state.upcomingObserver?.disconnect()

  try {
    elements.upcomingList
      .querySelectorAll('.home-google-event-card')
      .forEach(card => card.remove())

    const existingCards = elements.upcomingList.querySelectorAll('.event-card').length
    const availableSlots = Math.max(0, UPCOMING_LIMIT - existingCards)
    const googleEvents = state.upcomingEvents.slice(0, availableSlots)

    if (googleEvents.length) {
      elements.upcomingList
        .querySelector('.home-schedule-empty')
        ?.remove()

      googleEvents.forEach(event => {
        elements.upcomingList.appendChild(createGoogleUpcomingCard(event))
      })
    }
  } finally {
    state.applyingUpcoming = false
    state.upcomingObserver?.observe(elements.upcomingList, {
      childList: true,
      subtree: true
    })
  }
}

function createGoogleUpcomingCard(event) {
  const card = document.createElement('a')
  card.className = 'event-card home-google-event-card'
  card.href = event.htmlLink || '#'
  card.target = event.htmlLink ? '_blank' : '_self'
  card.rel = 'noopener noreferrer'

  const startDateKey = googleEventStartDate(event)
  const date = parseDateKey(startDateKey)
  const dateBox = document.createElement('div')
  dateBox.className = 'event-date-box google'

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
  heading.textContent = event.title || 'Google Calendar event'
  const meta = document.createElement('span')
  meta.textContent = googleUpcomingMeta(event)
  copy.append(heading, meta)

  const type = document.createElement('span')
  type.className = 'event-type google-calendar'
  type.textContent = 'Google'

  card.append(dateBox, copy, type)
  return card
}

function mapEventsByDate(events) {
  const result = new Map()

  for (const event of events) {
    const dateKeys = googleEventDateKeys(event)

    for (const dateKey of dateKeys) {
      const list = result.get(dateKey) || []
      list.push(event)
      result.set(dateKey, list)
    }
  }

  for (const list of result.values()) {
    list.sort(compareGoogleEvents)
  }

  return result
}

function googleEventDateKeys(event) {
  if (event.allDay) {
    const start = event.start
    const exclusiveEnd = event.end || addDays(start, 1)
    const dates = []
    let cursor = start

    while (cursor < exclusiveEnd && dates.length < 366) {
      dates.push(cursor)
      cursor = addDays(cursor, 1)
    }

    return dates
  }

  return event.start
    ? [localDateKey(new Date(event.start), state.calendarTimezone)]
    : []
}

function googleEventStartDate(event) {
  if (event.allDay) return event.start
  return localDateKey(new Date(event.start), state.calendarTimezone)
}

function compactGoogleEventLabel(events) {
  if (events.length > 1) return `${events.length} Google events`

  const event = events[0]
  if (event.allDay) return event.title
  return `${formatGoogleTime(event.start)} ${event.title}`
}

function googleEventDescription(event) {
  if (event.allDay) return `${event.title}, all day`
  return `${event.title}, ${formatGoogleTime(event.start)}`
}

function googleUpcomingMeta(event) {
  const details = []

  if (event.allDay) details.push('All day')
  else details.push(formatGoogleTime(event.start))

  if (event.location) details.push(event.location)
  return details.join(' · ')
}

function formatGoogleTime(value) {
  if (!value) return ''
  return new Intl.DateTimeFormat('en-US', {
    timeZone: state.calendarTimezone || undefined,
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(value))
}

function isUpcomingGoogleEvent(event) {
  const now = Date.now()

  if (event.allDay) {
    const today = localDateKey(new Date(), state.calendarTimezone)
    return (event.end || addDays(event.start, 1)) > today
  }

  return new Date(event.end || event.start).getTime() > now
}

function compareGoogleEvents(left, right) {
  const leftValue = left.allDay
    ? `${left.start}T00:00:00Z`
    : left.start
  const rightValue = right.allDay
    ? `${right.start}T00:00:00Z`
    : right.start
  return new Date(leftValue).getTime() - new Date(rightValue).getTime()
}

function removeGoogleCalendarDecoration(button) {
  button.querySelectorAll('.home-google-calendar-label').forEach(item => item.remove())
  button.classList.remove('has-google-calendar-event')

  if (button.title.includes('\nGoogle Calendar:')) {
    button.title = button.title.split('\nGoogle Calendar:')[0]
  }

  const ariaLabel = button.getAttribute('aria-label') || ''
  if (ariaLabel.includes(', Google Calendar:')) {
    button.setAttribute(
      'aria-label',
      ariaLabel.split(', Google Calendar:')[0]
    )
  }
}

function clearGoogleCalendarUi() {
  const buttons = [...elements.grid.querySelectorAll('.calendar-day')]
  state.applyingCalendar = true
  state.calendarObserver?.disconnect()

  try {
    buttons.forEach(removeGoogleCalendarDecoration)
  } finally {
    state.applyingCalendar = false
    state.calendarObserver?.observe(elements.grid, {
      childList: true,
      subtree: true
    })
  }

  if (elements.upcomingList) {
    elements.upcomingList
      .querySelectorAll('.home-google-event-card')
      .forEach(card => card.remove())
  }
}

function handleEventLoadError(error) {
  console.error('Google Calendar event load failed:', error)

  if (error.needsReconnect) {
    setStatus('Google Calendar authorization expired. Reconnect your account.', 'error')
    setControls({ canConnect: true, connected: false })
    state.connected = false
    clearGoogleCalendarUi()
    return
  }

  setStatus(error.message || 'Google Calendar events could not be loaded.', 'error')
}

function showCallbackResult() {
  const url = new URL(window.location.href)
  const result = url.searchParams.get('google_calendar')

  if (result === 'connected') {
    setStatus('Google Calendar connected successfully.', 'success')
  } else if (result === 'error') {
    setStatus('Google Calendar could not be connected.', 'error')
  }

  if (result) {
    url.searchParams.delete('google_calendar')
    url.searchParams.delete('google_calendar_error')
    window.history.replaceState({}, document.title, url.toString())
  }
}

function setControls({ canConnect, connected }) {
  elements.connectButton.hidden = connected
  elements.connectButton.disabled = !canConnect || state.busy

  if (elements.disconnectButton) {
    elements.disconnectButton.hidden = !connected
    elements.disconnectButton.disabled = state.busy
  }
}

function setBusy(value) {
  state.busy = value
  elements.connectButton.disabled = value || !state.configured

  if (elements.disconnectButton) {
    elements.disconnectButton.disabled = value
  }
}

function setStatus(message, type = '') {
  elements.status.textContent = message
  elements.status.className = type
    ? `google-calendar-status ${type}`
    : 'google-calendar-status'
}

async function authorizedFetch(path, options = {}) {
  return fetch(path, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${state.accessToken}`
    }
  })
}

function resolveDisplayedMonth() {
  const text = elements.monthLabel?.textContent?.trim().toLowerCase()
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
  const startDate = new Date(
    firstDay.getFullYear(),
    firstDay.getMonth(),
    1 - firstDay.getDay()
  )
  const endDate = new Date(startDate)
  endDate.setDate(startDate.getDate() + 41)

  return {
    start: toLocalIsoDate(startDate),
    end: toLocalIsoDate(endDate),
    startDate
  }
}

function localDateKey(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || undefined,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function parseDateKey(value) {
  const [year, month, day] = String(value).split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
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
