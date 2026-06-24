import { supabase } from './supabaseClient.js?v=8'

function ensureDriverStyles() {
  if (document.getElementById('dashboardDriverStyles')) {
    return
  }

  const stylesheet = document.createElement('link')
  stylesheet.id = 'dashboardDriverStyles'
  stylesheet.rel = 'stylesheet'
  stylesheet.href = './dashboard-drivers.css?v=1'
  document.head.appendChild(stylesheet)
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
        minimumFractionDigits: 1,
        maximumFractionDigits: 1
      }).format(number)
    : '—'
}

function formatReportDate(value) {
  if (!value) return 'No data'

  const date = new Date(`${value}T00:00:00Z`)

  if (Number.isNaN(date.getTime())) {
    return String(value)
  }

  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(date)
}

function setText(id, value) {
  const element = document.getElementById(id)

  if (element) {
    element.textContent = value
  }
}

function buildDriverMarkup() {
  const board = document.querySelector('.dashboard-board')

  if (!board) {
    throw new Error('The dashboard board could not be found.')
  }

  if (document.getElementById('ticketDriverOverview')) {
    return
  }

  const section = document.createElement('article')
  section.id = 'ticketDriverOverview'
  section.className = 'dashboard-section ticket-driver-overview'
  section.innerHTML = `
    <div class="section-tab">Ticket Drivers</div>
    <div class="section-content">
      <div class="driver-heading">
        <div>
          <h2>Ticket Driver Groups</h2>
          <p>
            Latest support-contact volume aggregated from individual ticket concerns
          </p>
        </div>
        <span
          id="driverDateBadge"
          class="placeholder-badge driver-date-badge"
        >Loading</span>
      </div>

      <div class="driver-summary-grid">
        <section class="driver-summary-card">
          <span>Total driver tickets</span>
          <strong id="driverTicketTotal">—</strong>
        </section>
        <section class="driver-summary-card">
          <span>Driver groups</span>
          <strong id="driverGroupCount">—</strong>
        </section>
        <section class="driver-summary-card">
          <span>Leading driver</span>
          <strong id="leadingDriverValue">—</strong>
        </section>
      </div>

      <section class="chart-card driver-chart-card">
        <div class="card-heading">
          <div>
            <h2>Tickets by Driver Group</h2>
            <p class="metric-caption">
              Ranked by total tickets; percentages show each group’s share of all mapped driver tickets
            </p>
          </div>
        </div>

        <div
          id="ticketDriverChart"
          class="driver-chart"
          aria-live="polite"
        >
          <div class="driver-state">Loading ticket driver data...</div>
        </div>
      </section>
    </div>
  `

  board.appendChild(section)
}

function aggregateDriverRows(rows) {
  const groups = new Map()

  rows.forEach(row => {
    const groupKey = String(
      row.driver_group_key || row.driver_group_label || 'unknown'
    )
    const ticketCount = Number(row.ticket_count)

    if (!Number.isFinite(ticketCount) || ticketCount < 0) {
      return
    }

    const existing = groups.get(groupKey) || {
      groupKey,
      groupLabel: row.driver_group_label || groupKey,
      ticketCount: 0,
      concernRecords: 0
    }

    existing.ticketCount += ticketCount
    existing.concernRecords += 1

    if (row.driver_group_label) {
      existing.groupLabel = row.driver_group_label
    }

    groups.set(groupKey, existing)
  })

  return [...groups.values()].sort((first, second) =>
    second.ticketCount - first.ticketCount ||
    first.groupLabel.localeCompare(second.groupLabel)
  )
}

function createDriverRow(
  row,
  totalTickets,
  maximumTickets,
  index
) {
  const percentage = totalTickets > 0
    ? row.ticketCount / totalTickets
    : 0
  const relativeWidth = maximumTickets > 0
    ? (row.ticketCount / maximumTickets) * 100
    : 0
  const item = document.createElement('article')

  item.className = 'driver-row'
  item.dataset.driverGroupKey = row.groupKey
  item.setAttribute(
    'aria-label',
    `${row.groupLabel}: ${formatCount(row.ticketCount)} tickets, ` +
    `${formatPercentage(percentage)} of mapped driver tickets`
  )

  const identity = document.createElement('div')
  identity.className = 'driver-identity'

  const label = document.createElement('strong')
  label.className = 'driver-label'
  label.textContent = row.groupLabel

  const concernCount = document.createElement('span')
  concernCount.className = 'driver-concern-count'
  concernCount.textContent =
    `${formatCount(row.concernRecords)} concern ` +
    `${row.concernRecords === 1 ? 'type' : 'types'}`

  identity.append(label, concernCount)

  const barArea = document.createElement('div')
  barArea.className = 'driver-bar-area'

  const track = document.createElement('div')
  track.className = 'driver-bar-track'
  track.setAttribute('role', 'progressbar')
  track.setAttribute('aria-label', `${row.groupLabel} ticket volume`)
  track.setAttribute('aria-valuemin', '0')
  track.setAttribute('aria-valuemax', String(maximumTickets))
  track.setAttribute('aria-valuenow', String(row.ticketCount))

  const bar = document.createElement('span')
  bar.className = 'driver-bar'
  bar.style.width = `${Math.max(0, Math.min(100, relativeWidth))}%`
  track.appendChild(bar)

  const percentageText = document.createElement('span')
  percentageText.className = 'driver-percentage'
  percentageText.textContent = formatPercentage(percentage)

  barArea.append(track, percentageText)

  const value = document.createElement('div')
  value.className = 'driver-value'

  const count = document.createElement('strong')
  count.textContent = formatCount(row.ticketCount)

  const unit = document.createElement('span')
  unit.textContent = row.ticketCount === 1 ? 'ticket' : 'tickets'

  value.append(count, unit)
  item.append(identity, barArea, value)

  if (index === 0) {
    item.dataset.leadingDriver = 'true'
  }

  return item
}

function renderDriverChart(rows) {
  const container = document.getElementById('ticketDriverChart')

  if (!container) return

  container.replaceChildren()

  if (!Array.isArray(rows) || rows.length === 0) {
    const emptyState = document.createElement('div')
    emptyState.className = 'driver-state'
    emptyState.textContent =
      'No ticket driver data is available for the latest reporting date.'
    container.appendChild(emptyState)

    setText('driverTicketTotal', '0')
    setText('driverGroupCount', '0')
    setText('leadingDriverValue', '—')
    return
  }

  const totalTickets = rows.reduce(
    (total, row) => total + row.ticketCount,
    0
  )
  const maximumTickets = Math.max(
    0,
    ...rows.map(row => row.ticketCount)
  )
  const leadingDriver = rows.find(row => row.ticketCount > 0)

  setText('driverTicketTotal', formatCount(totalTickets))
  setText('driverGroupCount', formatCount(rows.length))
  setText(
    'leadingDriverValue',
    leadingDriver ? leadingDriver.groupLabel : 'No volume'
  )

  rows.forEach((row, index) => {
    container.appendChild(
      createDriverRow(
        row,
        totalTickets,
        maximumTickets,
        index
      )
    )
  })
}

function renderDriverError(message) {
  const container = document.getElementById('ticketDriverChart')

  if (!container) return

  container.replaceChildren()

  const errorState = document.createElement('div')
  errorState.className = 'driver-state driver-state-error'
  errorState.textContent = message
  container.appendChild(errorState)

  setText('driverTicketTotal', '—')
  setText('driverGroupCount', '—')
  setText('leadingDriverValue', 'Unavailable')
}

async function getLatestDriverDate() {
  const { data, error } = await supabase
    .from('ticket_driver_metrics')
    .select('report_date')
    .order('report_date', { ascending: false })
    .limit(1)

  if (error) throw error

  return Array.isArray(data) && data.length > 0
    ? data[0].report_date
    : null
}

async function loadDriverData() {
  const latestDate = await getLatestDriverDate()
  const badge = document.getElementById('driverDateBadge')

  if (!latestDate) {
    if (badge) badge.textContent = 'No data'
    renderDriverChart([])
    return
  }

  const { data, error } = await supabase
    .from('ticket_driver_metrics')
    .select(
      'report_date, driver_group_key, driver_group_label, driver_key, ticket_count'
    )
    .eq('report_date', latestDate)

  if (error) throw error

  if (badge) {
    badge.textContent = formatReportDate(latestDate)
  }

  renderDriverChart(
    aggregateDriverRows(Array.isArray(data) ? data : [])
  )
}

export async function initializeDriverDashboard() {
  ensureDriverStyles()
  buildDriverMarkup()

  try {
    await loadDriverData()
  } catch (error) {
    console.error('Unable to load ticket driver metrics:', error)

    const badge = document.getElementById('driverDateBadge')

    if (badge) badge.textContent = 'Unavailable'

    renderDriverError(
      'Ticket driver data could not be loaded. Please refresh or contact an administrator.'
    )
  }
}
