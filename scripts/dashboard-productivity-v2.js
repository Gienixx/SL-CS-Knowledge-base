import { supabase } from './supabaseClient.js?v=8'

const AHT_UNIT = 'minutes.seconds'

function ensureProductivityStyles() {
  if (document.getElementById('dashboardProductivityStyles')) {
    return
  }

  const stylesheet = document.createElement('link')
  stylesheet.id = 'dashboardProductivityStyles'
  stylesheet.rel = 'stylesheet'
  stylesheet.href = './dashboard-productivity.css?v=1'
  document.head.appendChild(stylesheet)
}

function formatCount(value) {
  const number = Number(value)

  return Number.isFinite(number)
    ? new Intl.NumberFormat('en-US').format(number)
    : '—'
}

function formatAht(value) {
  if (value === null || value === undefined || value === '') {
    return '—'
  }

  const decimalMinutes = Number(value)

  if (!Number.isFinite(decimalMinutes) || decimalMinutes < 0) {
    return '—'
  }

  const totalSeconds = Math.round(decimalMinutes * 60)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return `${minutes}:${String(seconds).padStart(2, '0')}`
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

function buildProductivityMarkup() {
  const board = document.querySelector('.dashboard-board')

  if (!board) {
    throw new Error('The dashboard board could not be found.')
  }

  if (document.getElementById('productivityOverview')) {
    return
  }

  const section = document.createElement('article')
  section.id = 'productivityOverview'
  section.className = 'dashboard-section productivity-overview'
  section.innerHTML = `
    <div class="section-tab">Agents</div>
    <div class="section-content">
      <div class="productivity-heading">
        <div>
          <h2>Agent Productivity</h2>
          <p>Latest solved-ticket output and workload by agent</p>
        </div>
        <span
          id="productivityDateBadge"
          class="placeholder-badge productivity-date-badge"
        >Loading</span>
      </div>

      <div class="productivity-summary-grid">
        <section class="productivity-summary-card">
          <span>Team solved</span>
          <strong id="teamSolvedValue">—</strong>
        </section>
        <section class="productivity-summary-card">
          <span>Agents reported</span>
          <strong id="reportedAgentsValue">—</strong>
        </section>
        <section class="productivity-summary-card">
          <span>Open tickets</span>
          <strong id="teamOpenValue">—</strong>
        </section>
      </div>

      <section class="chart-card productivity-chart-card">
        <div class="card-heading productivity-chart-heading">
          <div>
            <h2>Solved Tickets by Agent</h2>
            <p class="metric-caption">
              Ranked by solved volume; AHT is shown in minutes:seconds (MM:SS)
            </p>
          </div>
        </div>

        <div
          id="productivityChart"
          class="productivity-chart"
          aria-live="polite"
        >
          <div class="productivity-state">Loading agent productivity...</div>
        </div>
      </section>
    </div>
  `

  board.appendChild(section)
}

function setText(id, value) {
  const element = document.getElementById(id)

  if (element) {
    element.textContent = value
  }
}

function createMetric(labelText, valueText) {
  const metric = document.createElement('div')
  metric.className = 'productivity-row-metric'

  const label = document.createElement('span')
  label.textContent = labelText

  const value = document.createElement('strong')
  value.textContent = valueText

  metric.append(label, value)
  return metric
}

function createAgentRow(row, index, maximumSolved, teamSolved) {
  const solvedTickets = Number(row.solved_tickets) || 0
  const openTickets = row.open_tickets
  const formattedAht = formatAht(row.aht_value)
  const teamShare = teamSolved > 0
    ? solvedTickets / teamSolved
    : 0
  const relativeWidth = maximumSolved > 0
    ? (solvedTickets / maximumSolved) * 100
    : 0

  const item = document.createElement('article')
  item.className = 'productivity-row'
  item.setAttribute(
    'aria-label',
    `${row.agent_name}: ${formatCount(solvedTickets)} solved tickets, ` +
    `${formatPercentage(teamShare)} of team output, ` +
    `${formattedAht === '—' ? 'AHT unavailable' : `AHT ${formattedAht}`}`
  )

  const rank = document.createElement('span')
  rank.className = 'productivity-rank'
  rank.textContent = String(index + 1)

  const identity = document.createElement('div')
  identity.className = 'productivity-agent-identity'

  const agentName = document.createElement('strong')
  agentName.className = 'productivity-agent-name'
  agentName.textContent = row.agent_name || row.agent_key

  const share = document.createElement('span')
  share.className = 'productivity-agent-share'
  share.textContent = `${formatPercentage(teamShare)} of team output`

  identity.append(agentName, share)

  const chart = document.createElement('div')
  chart.className = 'productivity-bar-area'

  const track = document.createElement('div')
  track.className = 'productivity-bar-track'

  const bar = document.createElement('span')
  bar.className = 'productivity-bar'
  bar.style.width = `${Math.max(0, Math.min(100, relativeWidth))}%`
  track.appendChild(bar)

  const solved = document.createElement('strong')
  solved.className = 'productivity-solved-value'
  solved.textContent = `${formatCount(solvedTickets)} solved`

  chart.append(track, solved)

  const metrics = document.createElement('div')
  metrics.className = 'productivity-row-metrics'
  metrics.append(
    createMetric(
      'Open',
      openTickets === null || openTickets === undefined
        ? '—'
        : formatCount(openTickets)
    ),
    createMetric('AHT', formattedAht)
  )

  item.append(rank, identity, chart, metrics)
  return item
}

function renderProductivity(rows) {
  const container = document.getElementById('productivityChart')

  if (!container) return

  container.replaceChildren()

  if (!Array.isArray(rows) || rows.length === 0) {
    const emptyState = document.createElement('div')
    emptyState.className = 'productivity-state'
    emptyState.textContent = 'No agent productivity data is available.'
    container.appendChild(emptyState)
    return
  }

  const sortedRows = [...rows].sort((first, second) => {
    const solvedDifference =
      (Number(second.solved_tickets) || 0) -
      (Number(first.solved_tickets) || 0)

    return solvedDifference ||
      String(first.agent_name).localeCompare(String(second.agent_name))
  })
  const teamSolved = sortedRows.reduce(
    (sum, row) => sum + (Number(row.solved_tickets) || 0),
    0
  )
  const maximumSolved = Math.max(
    0,
    ...sortedRows.map(row => Number(row.solved_tickets) || 0)
  )
  const teamOpen = sortedRows.reduce(
    (sum, row) => {
      const value = Number(row.open_tickets)
      return Number.isFinite(value) ? sum + value : sum
    },
    0
  )

  setText('teamSolvedValue', formatCount(teamSolved))
  setText('reportedAgentsValue', formatCount(sortedRows.length))
  setText('teamOpenValue', formatCount(teamOpen))

  sortedRows.forEach((row, index) => {
    container.appendChild(
      createAgentRow(
        row,
        index,
        maximumSolved,
        teamSolved
      )
    )
  })
}

function renderProductivityError(message) {
  const container = document.getElementById('productivityChart')

  if (!container) return

  container.replaceChildren()
  const errorState = document.createElement('div')
  errorState.className = 'productivity-state productivity-state-error'
  errorState.textContent = message
  container.appendChild(errorState)
}

async function getLatestProductivityDate() {
  const { data, error } = await supabase
    .from('agent_productivity')
    .select('report_date')
    .order('report_date', { ascending: false })
    .limit(1)

  if (error) throw error

  return Array.isArray(data) && data.length > 0
    ? data[0].report_date
    : null
}

async function loadProductivityData() {
  const latestDate = await getLatestProductivityDate()

  if (!latestDate) {
    setText('productivityDateBadge', 'No data')
    renderProductivity([])
    return
  }

  const { data, error } = await supabase
    .from('agent_productivity')
    .select(
      'report_date, agent_key, agent_name, solved_tickets, open_tickets, aht_value, aht_unit'
    )
    .eq('report_date', latestDate)

  if (error) throw error

  setText('productivityDateBadge', formatReportDate(latestDate))
  renderProductivity(Array.isArray(data) ? data : [])
}

export async function initializeProductivityDashboard() {
  ensureProductivityStyles()
  buildProductivityMarkup()

  try {
    await loadProductivityData()
  } catch (error) {
    console.error('Unable to load agent productivity:', error)
    setText('productivityDateBadge', 'Unavailable')
    renderProductivityError(
      'Agent productivity could not be loaded. Please refresh or contact an administrator.'
    )
  }
}

export { AHT_UNIT, formatAht }
