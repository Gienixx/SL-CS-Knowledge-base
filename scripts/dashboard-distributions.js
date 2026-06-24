import { supabase } from './supabaseClient.js?v=8'

const DISTRIBUTION_ORDER = Object.freeze({
  app: Object.freeze(['eureka', 'survey_pop', 'survey_spin']),
  platform: Object.freeze(['ios', 'android', 'web']),
  country: Object.freeze([
    'au',
    'ca',
    'fr',
    'de',
    'gb',
    'us',
    'unknown'
  ])
})

const DISTRIBUTION_SECTIONS = Object.freeze([
  Object.freeze({
    type: 'app',
    title: 'Tickets by App',
    caption: 'Share of mapped tickets across SocialLoop apps',
    containerId: 'appDistributionChart'
  }),
  Object.freeze({
    type: 'platform',
    title: 'Tickets by Platform',
    caption: 'Share of mapped tickets by device platform',
    containerId: 'platformDistributionChart'
  }),
  Object.freeze({
    type: 'country',
    title: 'Tickets by Country',
    caption: 'Share of mapped tickets by user country',
    containerId: 'countryDistributionChart'
  })
])

function ensureDistributionStyles() {
  if (document.getElementById('dashboardDistributionStyles')) {
    return
  }

  const stylesheet = document.createElement('link')
  stylesheet.id = 'dashboardDistributionStyles'
  stylesheet.rel = 'stylesheet'
  stylesheet.href = './dashboard-distributions.css?v=1'
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

function buildDistributionMarkup() {
  const board = document.querySelector('.dashboard-board')

  if (!board) {
    throw new Error('The dashboard board could not be found.')
  }

  if (document.getElementById('distributionOverview')) {
    return
  }

  const section = document.createElement('article')
  section.id = 'distributionOverview'
  section.className = 'dashboard-section distribution-overview'
  section.innerHTML = `
    <div class="section-tab">Breakdown</div>
    <div class="section-content">
      <div class="distribution-heading">
        <div>
          <h2>Latest Ticket Distribution</h2>
          <p>Counts and percentages for the latest synchronized reporting date</p>
        </div>
        <span
          id="distributionDateBadge"
          class="placeholder-badge distribution-date-badge"
        >Loading</span>
      </div>

      <div class="distribution-grid">
        ${DISTRIBUTION_SECTIONS.map(sectionConfig => `
          <section class="chart-card distribution-card">
            <div class="card-heading">
              <div>
                <h2>${sectionConfig.title}</h2>
                <p class="metric-caption">${sectionConfig.caption}</p>
              </div>
            </div>
            <div
              id="${sectionConfig.containerId}"
              class="distribution-chart"
              aria-live="polite"
            >
              <div class="distribution-state">Loading distribution data...</div>
            </div>
          </section>
        `).join('')}
      </div>
    </div>
  `

  board.appendChild(section)
}

function getOrderedRows(type, rows) {
  const order = DISTRIBUTION_ORDER[type] || []
  const orderIndexes = new Map(
    order.map((key, index) => [key, index])
  )

  return [...rows].sort((first, second) => {
    const firstIndex = orderIndexes.has(first.dimension_key)
      ? orderIndexes.get(first.dimension_key)
      : Number.MAX_SAFE_INTEGER
    const secondIndex = orderIndexes.has(second.dimension_key)
      ? orderIndexes.get(second.dimension_key)
      : Number.MAX_SAFE_INTEGER

    return firstIndex - secondIndex ||
      String(first.dimension_label).localeCompare(
        String(second.dimension_label)
      )
  })
}

function createDistributionRow(row, total) {
  const ticketCount = Number(row.ticket_count) || 0
  const percentage = total > 0 ? ticketCount / total : 0
  const item = document.createElement('div')
  item.className = 'distribution-row'

  const header = document.createElement('div')
  header.className = 'distribution-row-header'

  const label = document.createElement('span')
  label.className = 'distribution-label'
  label.textContent = row.dimension_label || row.dimension_key

  const count = document.createElement('strong')
  count.className = 'distribution-count'
  count.textContent = formatCount(ticketCount)

  header.append(label, count)

  const track = document.createElement('div')
  track.className = 'distribution-track'
  track.setAttribute('aria-hidden', 'true')

  const bar = document.createElement('span')
  bar.className = 'distribution-bar'
  bar.style.width = `${Math.max(0, Math.min(100, percentage * 100))}%`
  track.appendChild(bar)

  const metadata = document.createElement('div')
  metadata.className = 'distribution-meta'
  metadata.textContent =
    `${formatPercentage(percentage)} of ${formatCount(total)} mapped tickets`

  item.title =
    `${row.dimension_label}: ${formatCount(ticketCount)} tickets ` +
    `(${formatPercentage(percentage)})`
  item.append(header, track, metadata)

  return item
}

function renderDistribution(type, rows) {
  const sectionConfig = DISTRIBUTION_SECTIONS.find(
    section => section.type === type
  )
  const container = sectionConfig
    ? document.getElementById(sectionConfig.containerId)
    : null

  if (!container) return

  container.replaceChildren()

  if (!Array.isArray(rows) || rows.length === 0) {
    const emptyState = document.createElement('div')
    emptyState.className = 'distribution-state'
    emptyState.textContent = 'No data is available for this distribution.'
    container.appendChild(emptyState)
    return
  }

  const orderedRows = getOrderedRows(type, rows)
  const total = orderedRows.reduce(
    (sum, row) => sum + (Number(row.ticket_count) || 0),
    0
  )

  orderedRows.forEach(row => {
    container.appendChild(createDistributionRow(row, total))
  })
}

function renderDistributionError(message) {
  DISTRIBUTION_SECTIONS.forEach(sectionConfig => {
    const container = document.getElementById(sectionConfig.containerId)

    if (!container) return

    container.replaceChildren()
    const errorState = document.createElement('div')
    errorState.className = 'distribution-state distribution-state-error'
    errorState.textContent = message
    container.appendChild(errorState)
  })
}

async function getLatestDistributionDate() {
  const { data, error } = await supabase
    .from('daily_distribution_metrics')
    .select('report_date')
    .order('report_date', { ascending: false })
    .limit(1)

  if (error) throw error

  return Array.isArray(data) && data.length > 0
    ? data[0].report_date
    : null
}

async function loadDistributionData() {
  const latestDate = await getLatestDistributionDate()

  if (!latestDate) {
    document.getElementById('distributionDateBadge').textContent = 'No data'
    DISTRIBUTION_SECTIONS.forEach(sectionConfig => {
      renderDistribution(sectionConfig.type, [])
    })
    return
  }

  const { data, error } = await supabase
    .from('daily_distribution_metrics')
    .select(
      'report_date, dimension_type, dimension_key, dimension_label, ticket_count'
    )
    .eq('report_date', latestDate)

  if (error) throw error

  const rows = Array.isArray(data) ? data : []

  document.getElementById('distributionDateBadge').textContent =
    formatReportDate(latestDate)

  DISTRIBUTION_SECTIONS.forEach(sectionConfig => {
    renderDistribution(
      sectionConfig.type,
      rows.filter(row => row.dimension_type === sectionConfig.type)
    )
  })
}

export async function initializeDistributionDashboard() {
  ensureDistributionStyles()
  buildDistributionMarkup()

  try {
    await loadDistributionData()
  } catch (error) {
    console.error('Unable to load dashboard distributions:', error)

    const badge = document.getElementById('distributionDateBadge')

    if (badge) badge.textContent = 'Unavailable'

    renderDistributionError(
      'Distribution data could not be loaded. Please refresh or contact an administrator.'
    )
  }
}
