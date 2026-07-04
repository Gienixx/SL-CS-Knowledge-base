import { supabase } from './supabaseClient.js?v=8'

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'

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

const PIE_COLORS = Object.freeze([
  '#382f90',
  '#f5ad3d',
  '#7a72c9',
  '#6a6377',
  '#b8b3e5',
  '#d9796f',
  '#5e9f8c'
])

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
  stylesheet.href = './styles/dashboard-distributions.css?v=2'
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

function createSvgElement(tagName, attributes = {}) {
  const element = document.createElementNS(SVG_NAMESPACE, tagName)

  Object.entries(attributes).forEach(([name, value]) => {
    element.setAttribute(name, String(value))
  })

  return element
}

function polarToCartesian(centerX, centerY, radius, angleDegrees) {
  const angleRadians = (angleDegrees * Math.PI) / 180

  return {
    x: centerX + radius * Math.cos(angleRadians),
    y: centerY + radius * Math.sin(angleRadians)
  }
}

function buildPieSectorPath(
  centerX,
  centerY,
  radius,
  startAngle,
  endAngle
) {
  const sweep = endAngle - startAngle

  if (sweep >= 359.999) {
    return [
      `M ${centerX} ${centerY - radius}`,
      `A ${radius} ${radius} 0 1 1 ${centerX} ${centerY + radius}`,
      `A ${radius} ${radius} 0 1 1 ${centerX} ${centerY - radius}`,
      'Z'
    ].join(' ')
  }

  const start = polarToCartesian(
    centerX,
    centerY,
    radius,
    startAngle
  )
  const end = polarToCartesian(
    centerX,
    centerY,
    radius,
    endAngle
  )
  const largeArcFlag = sweep > 180 ? 1 : 0

  return [
    `M ${centerX} ${centerY}`,
    `L ${start.x.toFixed(3)} ${start.y.toFixed(3)}`,
    `A ${radius} ${radius} 0 ${largeArcFlag} 1 ` +
      `${end.x.toFixed(3)} ${end.y.toFixed(3)}`,
    'Z'
  ].join(' ')
}

function createPieChart(rows, total, type) {
  const figure = document.createElement('div')
  figure.className = 'distribution-pie-figure'

  const svg = createSvgElement('svg', {
    class: 'distribution-pie',
    viewBox: '0 0 220 220',
    role: 'img',
    'aria-label': `${type} ticket distribution pie chart`
  })

  let currentAngle = -90

  rows.forEach((row, index) => {
    const ticketCount = Number(row.ticket_count) || 0
    const percentage = total > 0 ? ticketCount / total : 0

    if (percentage <= 0) return

    const endAngle = currentAngle + percentage * 360
    const path = createSvgElement('path', {
      d: buildPieSectorPath(
        110,
        110,
        100,
        currentAngle,
        endAngle
      ),
      fill: PIE_COLORS[index % PIE_COLORS.length],
      class: 'distribution-pie-slice',
      tabindex: '0'
    })
    const title = createSvgElement('title')

    title.textContent =
      `${row.dimension_label}: ${formatCount(ticketCount)} tickets ` +
      `(${formatPercentage(percentage)})`
    path.appendChild(title)
    svg.appendChild(path)
    currentAngle = endAngle
  })

  const totalLabel = document.createElement('div')
  totalLabel.className = 'distribution-pie-total'
  totalLabel.innerHTML = `
    <strong>${formatCount(total)}</strong>
    <span>mapped tickets</span>
  `

  figure.append(svg, totalLabel)
  return figure
}

function createLegendRow(row, total, index) {
  const ticketCount = Number(row.ticket_count) || 0
  const percentage = total > 0 ? ticketCount / total : 0
  const item = document.createElement('div')
  item.className = 'distribution-legend-row'

  const identity = document.createElement('div')
  identity.className = 'distribution-legend-identity'

  const marker = document.createElement('span')
  marker.className = 'distribution-legend-marker'
  marker.style.backgroundColor = PIE_COLORS[index % PIE_COLORS.length]

  const label = document.createElement('span')
  label.className = 'distribution-legend-label'
  label.textContent = row.dimension_label || row.dimension_key

  identity.append(marker, label)

  const values = document.createElement('div')
  values.className = 'distribution-legend-values'

  const count = document.createElement('strong')
  count.textContent = formatCount(ticketCount)

  const percent = document.createElement('span')
  percent.textContent = formatPercentage(percentage)

  values.append(count, percent)
  item.append(identity, values)

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

  if (total <= 0) {
    const emptyState = document.createElement('div')
    emptyState.className = 'distribution-state'
    emptyState.textContent = 'The latest distribution contains only zero values.'
    container.appendChild(emptyState)
    return
  }

  const layout = document.createElement('div')
  layout.className = 'distribution-pie-layout'
  const legend = document.createElement('div')
  legend.className = 'distribution-pie-legend'

  orderedRows.forEach((row, index) => {
    legend.appendChild(createLegendRow(row, total, index))
  })

  layout.append(
    createPieChart(orderedRows, total, type),
    legend
  )
  container.appendChild(layout)
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
