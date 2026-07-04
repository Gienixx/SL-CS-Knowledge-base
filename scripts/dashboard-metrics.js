import { supabase } from './supabaseClient.js?v=8'

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const HISTORY_LIMIT = 30

function ensureLiveDashboardStyles() {
  if (document.getElementById('dashboardLiveStyles')) {
    return
  }

  const stylesheet = document.createElement('link')
  stylesheet.id = 'dashboardLiveStyles'
  stylesheet.rel = 'stylesheet'
  stylesheet.href = './styles/dashboard-live.css?v=1'
  document.head.appendChild(stylesheet)
}

function setText(id, value) {
  const element = document.getElementById(id)

  if (element) {
    element.textContent = value
  }
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

function formatReportDate(value, options = {}) {
  if (!value) {
    return 'No data available'
  }

  const date = new Date(`${value}T00:00:00Z`)

  if (Number.isNaN(date.getTime())) {
    return String(value)
  }

  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: options.short ? 'short' : 'long',
    day: 'numeric',
    year: options.includeYear === false ? undefined : 'numeric'
  }).format(date)
}

function buildDashboardMarkup() {
  const board = document.querySelector('.dashboard-board')

  if (!board) {
    throw new Error('The dashboard board could not be found.')
  }

  board.classList.add('phase-one-dashboard')
  board.setAttribute('aria-label', 'Live customer service dashboard')
  board.innerHTML = `
    <article class="dashboard-section phase-one-summary">
      <div class="section-tab">Latest Day</div>
      <div class="section-content">
        <div class="dashboard-status-bar">
          <div class="dashboard-status-copy">
            <span class="dashboard-status-label">Data updated through</span>
            <strong id="latestReportDate" class="dashboard-status-date">Loading...</strong>
          </div>
          <span id="dashboardDataStatus" class="dashboard-status-pill" data-status="loading">
            Loading data
          </span>
        </div>

        <div class="kpi-grid">
          <section class="metric-card">
            <h2>New Tickets</h2>
            <div class="metric-value">
              <span class="metric-icon" aria-hidden="true">+</span>
              <span id="newTicketsValue">—</span>
            </div>
            <p class="metric-caption">Received on the latest reporting date</p>
          </section>

          <section class="metric-card">
            <h2>Solved Tickets</h2>
            <div class="metric-value">
              <span class="metric-icon" aria-hidden="true">✓</span>
              <span id="solvedTicketsValue">—</span>
            </div>
            <p class="metric-caption">Closed on the latest reporting date</p>
          </section>

          <section class="metric-card accent">
            <h2>Unsolved Tickets</h2>
            <div class="metric-value">
              <span class="metric-icon" aria-hidden="true">!</span>
              <span id="unsolvedTicketsValue">—</span>
            </div>
            <p class="metric-caption">Open ticket backlog</p>
          </section>

          <section class="metric-card">
            <h2>One-Touch Resolution</h2>
            <div class="metric-value">
              <span class="metric-icon" aria-hidden="true">1</span>
              <span id="oneTouchResolutionValue">—</span>
            </div>
            <p class="metric-caption">Resolved in one interaction</p>
          </section>

          <section class="metric-card accent">
            <h2>Reopened Rate</h2>
            <div class="metric-value">
              <span class="metric-icon" aria-hidden="true">↻</span>
              <span id="reopenedRateValue">—</span>
            </div>
            <p class="metric-caption">Tickets reopened after resolution</p>
          </section>
        </div>
      </div>
    </article>

    <article class="dashboard-section ticket-volume">
      <div class="section-tab">30-Day Trend</div>
      <div class="section-content">
        <section class="chart-card live-chart-card">
          <div class="card-heading">
            <div>
              <h2>New vs. Solved Tickets</h2>
              <p class="metric-caption">Daily ticket volume across the latest available reporting dates</p>
            </div>
            <span id="chartPeriodBadge" class="placeholder-badge">Loading</span>
          </div>

          <div class="ticket-chart-wrap">
            <svg
              id="ticketVolumeChart"
              class="chart-svg"
              viewBox="0 0 800 330"
              role="img"
              aria-label="New and solved ticket volume over the latest reporting dates"
            ></svg>
            <div id="chartEmptyState" class="chart-empty-state">
              Loading ticket-volume history...
            </div>
          </div>

          <div class="legend" aria-hidden="true">
            <span><i style="background:#382f90"></i>New tickets</span>
            <span><i style="background:#f5ad3d"></i>Solved tickets</span>
          </div>
        </section>
      </div>
    </article>
  `

  const subtitle = document.querySelector('.title-block p')

  if (subtitle) {
    subtitle.textContent =
      'Live support metrics synchronized daily from the team ticket tracker.'
  }

  const footer = document.querySelector('.footer-note')

  if (footer) {
    footer.className = 'phase-one-footer'
    footer.innerHTML =
      '<span>Source:</span><strong>2026 Ticket Tracker</strong>'
  }
}

function createSvgElement(tagName, attributes = {}) {
  const element = document.createElementNS(SVG_NAMESPACE, tagName)

  Object.entries(attributes).forEach(([name, value]) => {
    element.setAttribute(name, String(value))
  })

  return element
}

function getNiceMaximum(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return 1
  }

  const magnitude = 10 ** Math.floor(Math.log10(value))
  const normalized = value / magnitude
  let niceNormalized

  if (normalized <= 1) {
    niceNormalized = 1
  } else if (normalized <= 2) {
    niceNormalized = 2
  } else if (normalized <= 5) {
    niceNormalized = 5
  } else {
    niceNormalized = 10
  }

  return niceNormalized * magnitude
}

function buildPath(rows, dataKey, dimensions, maximum) {
  const {
    left,
    top,
    plotWidth,
    plotHeight
  } = dimensions

  return rows.map((row, index) => {
    const x = rows.length === 1
      ? left + plotWidth / 2
      : left + (index / (rows.length - 1)) * plotWidth
    const value = Number(row[dataKey]) || 0
    const y = top + plotHeight - (value / maximum) * plotHeight

    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
  }).join(' ')
}

function addChartPoint(
  svg,
  row,
  index,
  rows,
  dataKey,
  className,
  dimensions,
  maximum
) {
  const x = rows.length === 1
    ? dimensions.left + dimensions.plotWidth / 2
    : dimensions.left +
      (index / (rows.length - 1)) * dimensions.plotWidth
  const value = Number(row[dataKey]) || 0
  const y = dimensions.top + dimensions.plotHeight -
    (value / maximum) * dimensions.plotHeight
  const circle = createSvgElement('circle', {
    cx: x,
    cy: y,
    r: 3.2,
    class: className
  })
  const title = createSvgElement('title')
  const label = dataKey === 'new_tickets'
    ? 'New tickets'
    : 'Solved tickets'

  title.textContent =
    `${formatReportDate(row.report_date)} — ${label}: ${formatCount(value)}`
  circle.appendChild(title)
  svg.appendChild(circle)
}

function renderTicketChart(rows) {
  const svg = document.getElementById('ticketVolumeChart')
  const emptyState = document.getElementById('chartEmptyState')

  if (!svg || !emptyState) {
    return
  }

  svg.replaceChildren()

  if (!Array.isArray(rows) || rows.length === 0) {
    emptyState.hidden = false
    emptyState.textContent = 'No historical ticket data is available yet.'
    return
  }

  emptyState.hidden = true

  const dimensions = {
    left: 60,
    right: 22,
    top: 20,
    bottom: 58,
    plotWidth: 718,
    plotHeight: 252
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
      class: 'ticket-chart-grid'
    }))

    const label = createSvgElement('text', {
      x: dimensions.left - 10,
      y: y + 4,
      'text-anchor': 'end',
      class: 'ticket-chart-text'
    })
    label.textContent = formatCount(value)
    svg.appendChild(label)
  }

  svg.appendChild(createSvgElement('line', {
    x1: dimensions.left,
    y1: dimensions.top,
    x2: dimensions.left,
    y2: dimensions.top + dimensions.plotHeight,
    class: 'ticket-chart-axis'
  }))
  svg.appendChild(createSvgElement('line', {
    x1: dimensions.left,
    y1: dimensions.top + dimensions.plotHeight,
    x2: dimensions.left + dimensions.plotWidth,
    y2: dimensions.top + dimensions.plotHeight,
    class: 'ticket-chart-axis'
  }))

  const labelIndexes = new Set()
  const labelCount = Math.min(6, rows.length)

  for (let labelIndex = 0; labelIndex < labelCount; labelIndex += 1) {
    labelIndexes.add(
      labelCount === 1
        ? 0
        : Math.round(
            (labelIndex / (labelCount - 1)) * (rows.length - 1)
          )
    )
  }

  labelIndexes.forEach(index => {
    const x = rows.length === 1
      ? dimensions.left + dimensions.plotWidth / 2
      : dimensions.left +
        (index / (rows.length - 1)) * dimensions.plotWidth
    const label = createSvgElement('text', {
      x,
      y: dimensions.top + dimensions.plotHeight + 25,
      'text-anchor': 'middle',
      class: 'ticket-chart-text'
    })

    label.textContent = formatReportDate(
      rows[index].report_date,
      {
        short: true,
        includeYear: false
      }
    )
    svg.appendChild(label)
  })

  svg.appendChild(createSvgElement('path', {
    d: buildPath(
      rows,
      'new_tickets',
      dimensions,
      maximum
    ),
    class: 'ticket-chart-line-new'
  }))

  svg.appendChild(createSvgElement('path', {
    d: buildPath(
      rows,
      'solved_tickets',
      dimensions,
      maximum
    ),
    class: 'ticket-chart-line-solved'
  }))

  rows.forEach((row, index) => {
    addChartPoint(
      svg,
      row,
      index,
      rows,
      'new_tickets',
      'ticket-chart-point-new',
      dimensions,
      maximum
    )
    addChartPoint(
      svg,
      row,
      index,
      rows,
      'solved_tickets',
      'ticket-chart-point-solved',
      dimensions,
      maximum
    )
  })
}

function setDashboardStatus(status, text) {
  const statusElement = document.getElementById('dashboardDataStatus')

  if (!statusElement) {
    return
  }

  statusElement.dataset.status = status
  statusElement.textContent = text
}

function showLatestMetrics(latestRow) {
  setText('latestReportDate', formatReportDate(latestRow.report_date))
  setText('newTicketsValue', formatCount(latestRow.new_tickets))
  setText('solvedTicketsValue', formatCount(latestRow.solved_tickets))
  setText('unsolvedTicketsValue', formatCount(latestRow.unsolved_tickets))
  setText(
    'oneTouchResolutionValue',
    formatPercentage(latestRow.one_touch_resolution)
  )
  setText('reopenedRateValue', formatPercentage(latestRow.reopened_rate))
}

async function loadDashboardMetrics() {
  const { data, error } = await supabase
    .from('daily_ticket_metrics')
    .select(
      'report_date, new_tickets, solved_tickets, unsolved_tickets, one_touch_resolution, reopened_rate'
    )
    .order('report_date', { ascending: false })
    .limit(HISTORY_LIMIT)

  if (error) {
    throw error
  }

  if (!Array.isArray(data) || data.length === 0) {
    setDashboardStatus('empty', 'No imported data')
    setText('latestReportDate', 'No data available')
    setText('chartPeriodBadge', 'No data')
    renderTicketChart([])
    return
  }

  const latestRow = data[0]
  const chronologicalRows = [...data].reverse()

  showLatestMetrics(latestRow)
  renderTicketChart(chronologicalRows)
  setDashboardStatus('ready', 'Live data')
  setText(
    'chartPeriodBadge',
    `${chronologicalRows.length} day${chronologicalRows.length === 1 ? '' : 's'}`
  )
}

export async function initializePhaseOneDashboard() {
  ensureLiveDashboardStyles()
  buildDashboardMarkup()

  try {
    await loadDashboardMetrics()
  } catch (error) {
    console.error('Unable to load dashboard metrics:', error)
    setDashboardStatus('error', 'Data unavailable')
    setText('latestReportDate', 'Unable to load data')
    setText('chartPeriodBadge', 'Unavailable')

    const emptyState = document.getElementById('chartEmptyState')

    if (emptyState) {
      emptyState.hidden = false
      emptyState.textContent =
        'The dashboard data could not be loaded. Please refresh or contact an administrator.'
    }
  }
}
