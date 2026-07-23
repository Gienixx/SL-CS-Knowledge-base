import { supabase } from './supabaseClient.js?v=10'
import {
  requiresFirstLoginPasswordChange
} from './first-login-policy.js?v=4'
import {
  recurringTeamEventsForMonth,
  upcomingRecurringTeamEvents
} from './home-recurring-events.js?v=1'
import {
  setUpcomingEventDate,
  sortUpcomingEventCards
} from './home-upcoming-events.js?v=1'
import {
  loadCurrentWorkforceAccess,
  hasWorkforcePermission
} from './workforce-permissions.js'
import { renderAnnouncementHtml } from './announcement-rich-text.js?v=1'

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const HOME_HISTORY_LIMIT = 14

const today = new Date()
const calendarState = {
  date: new Date(today.getFullYear(), today.getMonth(), 1)
}

function isMissingAuthSession(error) {
  return error?.name === 'AuthSessionMissingError'
}
document.addEventListener('DOMContentLoaded', initializeHome)

async function initializeHome() {
  renderCurrentDate()
  renderAnnouncements()
  renderUpcomingEvents()
  renderCalendar()
  installPageEvents()

  try {
    const {
      data: { user },
      error: userError
    } = await supabase.auth.getUser()

    if (isMissingAuthSession(userError)) {
      window.location.replace('./login.html')
      return
    }

    if (userError) {
      throw userError
    }

    if (!user) {
      window.location.replace('./login.html')
      return
    }

    let currentUser = user

    if (requiresFirstLoginPasswordChange(currentUser)) {
      const {
        data: { session },
        error: refreshError
      } = await supabase.auth.refreshSession()

      if (!refreshError && session?.user) {
        currentUser = session.user
      }

      if (requiresFirstLoginPasswordChange(currentUser)) {
        window.location.replace('./change-password.html?firstLogin=1')
        return
      }
    }

    const email = currentUser.email?.trim().toLowerCase()

    if (!email) {
      await supabase.auth.signOut()
      window.location.replace('./login.html')
      return
    }

    const access = await loadCurrentWorkforceAccess(supabase, {
      allowLegacyFallback: false
    })

    if (!access.allowed) {
      await supabase.auth.signOut()
      window.location.replace('./login.html')
      return
    }

    configureUserInterface(currentUser, access)
    try {
      await loadHomeMetrics()
    } catch (error) {
      console.error('Unable to load Home metrics:', error)
      setMetricStateUnavailable()
    }
    await loadPublishedAnnouncements()
  } catch (error) {
    if (isMissingAuthSession(error)) {
      window.location.replace('./login.html')
      return
    }

    console.error('Home page initialization failed:', error)
    setMetricStateUnavailable()
  }
}

function configureUserInterface(user, access) {
  const email = user.email || 'Support Team'
  const emailName = email.split('@')[0] || 'Team'
  const friendlyName = toFriendlyName(emailName)
  const initials = friendlyName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part.charAt(0).toUpperCase())
    .join('') || 'CS'

  setText('homeFirstName', friendlyName.split(/\s+/)[0] || 'Team')
  setText('homeUserName', friendlyName)
  setText(
    'homeUserRole',
    access.is_admin === true
      ? 'Administrator'
      : hasWorkforcePermission(access, 'edit_articles')
        ? 'Editor'
        : 'Team member'
  )
  setText('homeUserAvatar', initials)

  const articleButton = document.getElementById('homeArticleManagementBtn')
  const announcementButton = document.getElementById('homeAnnouncementManagementBtn')
  const changePasswordButton = document.getElementById('homeChangePasswordBtn')

  if (articleButton) {
    articleButton.hidden = !hasWorkforcePermission(access, 'edit_articles')
  }

  if (announcementButton) {
    announcementButton.hidden = !(
      access.is_admin === true ||
      hasWorkforcePermission(access, 'manage_announcements')
    )
  }

  if (changePasswordButton) {
    changePasswordButton.hidden = access.is_admin === true
  }
}

async function loadHomeMetrics() {
  const { data, error } = await supabase
    .from('daily_ticket_metrics')
    .select(
      'report_date, new_tickets, solved_tickets, unsolved_tickets, one_touch_resolution, reopened_rate'
    )
    .order('report_date', { ascending: false })
    .limit(HOME_HISTORY_LIMIT)

  if (error) {
    throw error
  }

  if (!Array.isArray(data) || data.length === 0) {
    setText('homeLatestDate', 'No imported data')
    setText('homeBacklogDelta', 'Import ticket data to compare solved and received volume.')
    setText('homeChartPeriod', 'No data')
    renderTicketChart([])
    return
  }

  const latestRow = data[0]
  const chronologicalRows = [...data].reverse()

  setText('homeLatestDate', `Updated through ${formatReportDate(latestRow.report_date)}`)
  setText('homeNewTickets', formatCount(latestRow.new_tickets))
  setText('homeSolvedTickets', formatCount(latestRow.solved_tickets))
  setText('homeUnsolvedTickets', formatCount(latestRow.unsolved_tickets))
  setText('homeOneTouch', formatPercentage(latestRow.one_touch_resolution))
  renderBacklogDelta(latestRow)
  setText(
    'homeChartPeriod',
    `${chronologicalRows.length} day${chronologicalRows.length === 1 ? '' : 's'}`
  )

  renderTicketChart(chronologicalRows)
}

function setMetricStateUnavailable() {
  setText('homeLatestDate', 'Data unavailable')
  setText('homeBacklogDelta', 'Ticket volume comparison is currently unavailable.')
  setText('homeChartPeriod', 'Unavailable')
  renderTicketChart([])

  const chartState = document.getElementById('homeChartState')
  if (chartState) {
    chartState.hidden = false
    chartState.textContent =
      'The latest ticket data could not be loaded. Open Analytics or contact an administrator.'
  }
}

function renderBacklogDelta(row) {
  const solved = Number(row?.solved_tickets)
  const received = Number(row?.new_tickets)
  const target = document.getElementById('homeBacklogDelta')

  if (!target || !Number.isFinite(solved) || !Number.isFinite(received)) return

  const difference = solved - received
  if (difference >= 0) {
    target.innerHTML = `Team closed <strong>${formatCount(difference)} more</strong> tickets than came in — backlog is shrinking.`
    return
  }

  target.innerHTML = `<strong>${formatCount(Math.abs(difference))} more</strong> tickets came in than were solved — backlog increased.`
}

function renderCurrentDate() {
  setText(
    'homeCurrentDate',
    new Intl.DateTimeFormat('en-PH', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    }).format(new Date())
  )
}

function renderAnnouncements() {
  const body = document.getElementById('announcementRows')
  if (!body) return

  body.className = 'empty-state team-updates-body'
  body.innerHTML = `
    <span class="updates-empty-icon" aria-hidden="true"></span>
    <strong>No updates posted yet</strong>
    <small>New announcements from the team will show up here.</small>
    <span class="sr-only home-empty-table-cell">None</span>
  `
}

async function loadPublishedAnnouncements() {
  const body = document.getElementById('announcementRows')
  if (!body) return

  try {
    const { data, error } = await supabase
      .from('team_announcements')
      .select('id, title, body, category, published_by_name, published_at')
      .eq('status', 'published')
      .order('published_at', { ascending: false })
      .limit(5)

    if (error) throw error

    if (!Array.isArray(data) || data.length === 0) {
      renderAnnouncements()
      return
    }

    body.className = 'team-updates-body has-updates'
    body.replaceChildren()

    const list = document.createElement('div')
    list.className = 'team-update-list'

    const columns = document.createElement('div')
    columns.className = 'team-update-columns'

    const dateColumn = document.createElement('span')
    dateColumn.textContent = 'Date'

    const titleColumn = document.createElement('span')
    titleColumn.textContent = 'Title'

    const unlabeledColumn = document.createElement('span')
    unlabeledColumn.setAttribute('aria-hidden', 'true')
    columns.append(dateColumn, titleColumn, unlabeledColumn)
    list.appendChild(columns)

    for (const announcement of data) {
      list.appendChild(createTeamUpdate(announcement))
    }

    body.appendChild(list)
  } catch (error) {
    console.error('Unable to load published announcements:', error)
    renderAnnouncements()
  }
}

function createTeamUpdate(announcement) {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'team-update-item'
  row.setAttribute('aria-label', `Open announcement: ${announcement.title}`)

  const date = document.createElement('span')
  date.className = 'team-update-date'
  date.textContent = formatAnnouncementDate(announcement.published_at)

  const title = document.createElement('strong')
  title.textContent = announcement.title

  const category = document.createElement('span')
  category.className = 'team-update-category'
  category.textContent = announcement.category || 'General'

  row.append(date, title, category)
  row.addEventListener('click', () => openAnnouncementDialog(announcement))
  return row
}

function openAnnouncementDialog(announcement) {
  const dialog = document.getElementById('announcementDialog')
  if (!dialog) return

  setText('announcementDialogCategory', announcement.category || 'General')
  setText('announcementDialogTitle', announcement.title)
  setText(
    'announcementDialogMeta',
    `${formatAnnouncementDate(announcement.published_at)} · ${announcement.published_by_name || 'Administrator'}`
  )
  renderAnnouncementHtml(
    document.getElementById('announcementDialogBody'),
    announcement.body
  )

  if (typeof dialog.showModal === 'function') {
    dialog.showModal()
  } else {
    dialog.setAttribute('open', '')
  }
}

function formatAnnouncementDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Recently published'

  return new Intl.DateTimeFormat('en-PH', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(date)
}

function renderUpcomingEvents() {
  const list = document.getElementById('upcomingEventList')
  if (!list) return

  const events = upcomingRecurringTeamEvents()

  if (!events.length) {
    list.innerHTML = '<div class="home-schedule-empty"><strong>None</strong></div>'
    return
  }

  list.innerHTML = events.map(event => {
    const date = new Date(`${event.date}T00:00:00Z`)
    const month = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short' }).format(date)

    return `
      <article class="event-card home-static-event-card">
        <div class="event-date-box"><span>${escapeHtml(month)}</span><strong>${date.getUTCDate()}</strong></div>
        <div class="event-copy"><strong>${escapeHtml(event.title)}</strong><span>${escapeHtml(event.time)}</span></div>
        <span class="event-type ${escapeHtml(event.type.toLowerCase())}">${escapeHtml(event.type)}</span>
      </article>
    `
  }).join('')

  const cards = list.querySelectorAll('.home-static-event-card')
  events.forEach((event, index) => {
    setUpcomingEventDate(cards[index], event.date)
  })
  sortUpcomingEventCards(list)
}

function renderCalendar() {
  const label = document.getElementById('calendarMonthLabel')
  const grid = document.getElementById('calendarGrid')
  if (!label || !grid) return

  const year = calendarState.date.getFullYear()
  const month = calendarState.date.getMonth()
  const firstDay = new Date(year, month, 1)
  const startDate = new Date(year, month, 1 - firstDay.getDay())

  label.textContent = new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric'
  }).format(calendarState.date)

  const eventMap = new Map()
  recurringTeamEventsForMonth(year, month).forEach(event => {
    const eventType = event.type.toLowerCase()
    if (!eventMap.has(event.date) || eventType === 'deadline') {
      eventMap.set(event.date, eventType)
    }
  })

  const cells = []

  for (let index = 0; index < 42; index += 1) {
    const date = new Date(startDate)
    date.setDate(startDate.getDate() + index)

    const dateKey = toLocalIsoDate(date)
    const eventType = eventMap.get(dateKey)
    const isCurrentMonth = date.getMonth() === month
    const isToday = isSameDay(date, today)
    const classes = ['calendar-day']

    if (!isCurrentMonth) classes.push('muted')
    if (isToday) classes.push('today')
    if (eventType) classes.push('has-event', eventType)

    cells.push(`
      <button
        class="${classes.join(' ')}"
        type="button"
        aria-label="${escapeHtml(date.toDateString())}${eventType ? `, ${eventType}` : ''}"
      >${date.getDate()}</button>
    `)
  }

  grid.innerHTML = cells.join('')
}

function installPageEvents() {
  const sidebar = document.getElementById('homeSidebar')
  const toggle = document.getElementById('sidebarToggle')
  const backdrop = document.getElementById('sidebarBackdrop')

  const closeSidebar = () => {
    sidebar?.classList.remove('open')
    backdrop?.classList.remove('open')
    toggle?.setAttribute('aria-expanded', 'false')
  }

  toggle?.addEventListener('click', () => {
    const isOpen = sidebar?.classList.toggle('open') === true
    backdrop?.classList.toggle('open', isOpen)
    toggle.setAttribute('aria-expanded', String(isOpen))
  })

  backdrop?.addEventListener('click', closeSidebar)

  document.getElementById('announcementDialog')?.addEventListener('click', event => {
    if (event.target === event.currentTarget) {
      event.currentTarget.close()
    }
  })

  window.addEventListener('resize', () => {
    if (window.innerWidth > 820) closeSidebar()
  })

  document.getElementById('calendarPrevious')?.addEventListener('click', () => {
    calendarState.date.setMonth(calendarState.date.getMonth() - 1)
    renderCalendar()
  })

  document.getElementById('calendarNext')?.addEventListener('click', () => {
    calendarState.date.setMonth(calendarState.date.getMonth() + 1)
    renderCalendar()
  })

  document.getElementById('homeLogoutBtn')?.addEventListener('click', async () => {
    try {
      await supabase.auth.signOut({ scope: 'local' })
    } finally {
      window.location.replace('./login.html')
    }
  })
}

function renderTicketChart(rows) {
  const svg = document.getElementById('homeTicketChart')
  const chartState = document.getElementById('homeChartState')

  if (!svg || !chartState) return

  svg.replaceChildren()

  if (!Array.isArray(rows) || rows.length === 0) {
    chartState.hidden = false
    chartState.textContent = 'No historical ticket data is available yet.'
    return
  }

  chartState.hidden = true

  const dimensions = {
    left: 58,
    top: 18,
    plotWidth: 720,
    plotHeight: 222
  }
  const maximum = getNiceMaximum(
    Math.max(
      ...rows.flatMap(row => [
        Number(row.new_tickets) || 0,
        Number(row.solved_tickets) || 0
      ])
    )
  )
  const tickCount = 5

  for (let tick = 0; tick <= tickCount; tick += 1) {
    const ratio = tick / tickCount
    const y = dimensions.top + ratio * dimensions.plotHeight
    const value = Math.round(maximum * (1 - ratio))

    svg.appendChild(createSvgElement('line', {
      x1: dimensions.left,
      y1: y,
      x2: dimensions.left + dimensions.plotWidth,
      y2: y,
      class: 'home-chart-grid'
    }))

    const label = createSvgElement('text', {
      x: dimensions.left - 10,
      y: y + 4,
      'text-anchor': 'end',
      class: 'home-chart-text'
    })
    label.textContent = formatCount(value)
    svg.appendChild(label)
  }

  svg.appendChild(createSvgElement('line', {
    x1: dimensions.left,
    y1: dimensions.top + dimensions.plotHeight,
    x2: dimensions.left + dimensions.plotWidth,
    y2: dimensions.top + dimensions.plotHeight,
    class: 'home-chart-axis'
  }))

  const labelIndexes = getChartLabelIndexes(rows.length, 6)

  labelIndexes.forEach(index => {
    const x = getPointX(index, rows.length, dimensions)
    const label = createSvgElement('text', {
      x,
      y: dimensions.top + dimensions.plotHeight + 25,
      'text-anchor': 'middle',
      class: 'home-chart-text'
    })
    label.textContent = formatReportDate(rows[index].report_date, true)
    svg.appendChild(label)
  })

  svg.appendChild(createSvgElement('path', {
    d: buildChartPath(rows, 'new_tickets', dimensions, maximum),
    class: 'home-chart-line-new'
  }))

  svg.appendChild(createSvgElement('path', {
    d: buildChartPath(rows, 'solved_tickets', dimensions, maximum),
    class: 'home-chart-line-solved'
  }))

  rows.forEach((row, index) => {
    addChartPoint(svg, rows, row, index, 'new_tickets', 'home-chart-point-new', dimensions, maximum)
    addChartPoint(svg, rows, row, index, 'solved_tickets', 'home-chart-point-solved', dimensions, maximum)
  })
}

function addChartPoint(svg, rows, row, index, key, className, dimensions, maximum) {
  const x = getPointX(index, rows.length, dimensions)
  const value = Number(row[key]) || 0
  const y = dimensions.top + dimensions.plotHeight -
    (value / maximum) * dimensions.plotHeight
  const point = createSvgElement('circle', {
    cx: x,
    cy: y,
    r: 3.2,
    class: className
  })
  const title = createSvgElement('title')
  title.textContent = `${formatReportDate(row.report_date)} — ${key === 'new_tickets' ? 'New' : 'Solved'} tickets: ${formatCount(value)}`
  point.appendChild(title)
  svg.appendChild(point)
}

function buildChartPath(rows, key, dimensions, maximum) {
  return rows.map((row, index) => {
    const x = getPointX(index, rows.length, dimensions)
    const value = Number(row[key]) || 0
    const y = dimensions.top + dimensions.plotHeight -
      (value / maximum) * dimensions.plotHeight
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
  }).join(' ')
}

function getPointX(index, rowCount, dimensions) {
  return rowCount === 1
    ? dimensions.left + dimensions.plotWidth / 2
    : dimensions.left + (index / (rowCount - 1)) * dimensions.plotWidth
}

function getChartLabelIndexes(rowCount, maximumLabels) {
  const indexes = new Set()
  const labelCount = Math.min(maximumLabels, rowCount)

  for (let labelIndex = 0; labelIndex < labelCount; labelIndex += 1) {
    indexes.add(
      labelCount === 1
        ? 0
        : Math.round((labelIndex / (labelCount - 1)) * (rowCount - 1))
    )
  }

  return indexes
}

function createSvgElement(tagName, attributes = {}) {
  const element = document.createElementNS(SVG_NAMESPACE, tagName)
  Object.entries(attributes).forEach(([name, value]) => {
    element.setAttribute(name, String(value))
  })
  return element
}

function getNiceMaximum(value) {
  if (!Number.isFinite(value) || value <= 0) return 1

  const magnitude = 10 ** Math.floor(Math.log10(value))
  const normalized = value / magnitude
  const niceNormalized = normalized <= 1
    ? 1
    : normalized <= 2
      ? 2
      : normalized <= 5
        ? 5
        : 10

  return niceNormalized * magnitude
}

function formatReportDate(value, short = false) {
  if (!value) return 'No data available'

  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return String(value)

  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: short ? 'short' : 'long',
    day: 'numeric',
    year: short ? undefined : 'numeric'
  }).format(date)
}

function formatCount(value) {
  const number = Number(value)
  return Number.isFinite(number)
    ? new Intl.NumberFormat('en-US').format(number)
    : '—'
}

function formatPercentage(value) {
  const number = Number(value)
  return Number.isFinite(number)
    ? new Intl.NumberFormat('en-US', {
        style: 'percent',
        maximumFractionDigits: 1
      }).format(number)
    : '—'
}

function toFriendlyName(value) {
  return String(value)
    .replace(/[._-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Support Team'
}

function toLocalIsoDate(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function isSameDay(first, second) {
  return first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
}

function setText(id, value) {
  const element = document.getElementById(id)
  if (element) element.textContent = value
}

function escapeHtml(value) {
  const element = document.createElement('div')
  element.textContent = String(value)
  return element.innerHTML
}
