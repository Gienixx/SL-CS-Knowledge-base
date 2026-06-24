import { supabase } from './supabaseClient.js?v=8'

const SVG_NS = 'http://www.w3.org/2000/svg'
const COLORS = [
  '#382f90', '#f5ad3d', '#746dca', '#5e9f8c',
  '#d9796f', '#9a72b3', '#6a6377', '#b8b3e5'
]

function count(value) {
  return new Intl.NumberFormat('en-US').format(Number(value) || 0)
}

function percent(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  }).format(Number(value) || 0)
}

function reportDate(value) {
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isNaN(date.getTime())
    ? String(value || 'No data')
    : new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC',
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      }).format(date)
}

function setText(id, value) {
  const element = document.getElementById(id)
  if (element) element.textContent = value
}

function svgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name)
  Object.entries(attributes).forEach(([key, value]) => {
    element.setAttribute(key, String(value))
  })
  return element
}

function point(cx, cy, radius, degrees) {
  const radians = degrees * Math.PI / 180
  return {
    x: cx + radius * Math.cos(radians),
    y: cy + radius * Math.sin(radians)
  }
}

function sectorPath(cx, cy, radius, startAngle, endAngle) {
  const sweep = endAngle - startAngle

  if (sweep >= 359.999) {
    return [
      `M ${cx} ${cy - radius}`,
      `A ${radius} ${radius} 0 1 1 ${cx} ${cy + radius}`,
      `A ${radius} ${radius} 0 1 1 ${cx} ${cy - radius}`,
      'Z'
    ].join(' ')
  }

  const start = point(cx, cy, radius, startAngle)
  const end = point(cx, cy, radius, endAngle)
  const largeArc = sweep > 180 ? 1 : 0

  return [
    `M ${cx} ${cy}`,
    `L ${start.x.toFixed(3)} ${start.y.toFixed(3)}`,
    `A ${radius} ${radius} 0 ${largeArc} 1 ` +
      `${end.x.toFixed(3)} ${end.y.toFixed(3)}`,
    'Z'
  ].join(' ')
}

function aggregate(rows) {
  const groups = new Map()

  rows.forEach(row => {
    const key = String(row.driver_group_key || row.driver_group_label)
    const value = Number(row.ticket_count)
    if (!key || !Number.isFinite(value) || value < 0) return

    const current = groups.get(key) || {
      key,
      label: row.driver_group_label || key,
      tickets: 0,
      concerns: 0
    }

    current.tickets += value
    current.concerns += 1
    groups.set(key, current)
  })

  return [...groups.values()].sort((a, b) =>
    b.tickets - a.tickets || a.label.localeCompare(b.label)
  )
}

function buildMarkup() {
  const board = document.querySelector('.dashboard-board')
  if (!board) throw new Error('Dashboard board not found.')
  if (document.getElementById('ticketDriverOverview')) return

  const section = document.createElement('article')
  section.id = 'ticketDriverOverview'
  section.className = 'dashboard-section ticket-driver-overview'
  section.innerHTML = `
    <div class="section-tab">Ticket Drivers</div>
    <div class="section-content">
      <div class="driver-heading">
        <div>
          <h2>Ticket Driver Groups</h2>
          <p>Latest support-contact volume aggregated from individual concerns</p>
        </div>
        <span id="driverDateBadge" class="placeholder-badge driver-date-badge">Loading</span>
      </div>
      <div class="driver-summary-grid">
        <section class="driver-summary-card"><span>Total driver tickets</span><strong id="driverTicketTotal">—</strong></section>
        <section class="driver-summary-card"><span>Driver groups</span><strong id="driverGroupCount">—</strong></section>
        <section class="driver-summary-card"><span>Leading driver</span><strong id="leadingDriverValue">—</strong></section>
      </div>
      <section class="chart-card driver-chart-card">
        <div class="card-heading">
          <div>
            <h2>Tickets by Driver Group</h2>
            <p class="metric-caption">Each slice shows the group’s share of mapped driver tickets</p>
          </div>
        </div>
        <div id="ticketDriverChart" class="driver-chart" aria-live="polite">
          <div class="driver-state">Loading ticket driver data...</div>
        </div>
      </section>
    </div>
  `
  board.appendChild(section)
}

function pie(rows, total) {
  const figure = document.createElement('div')
  figure.className = 'driver-pie-figure'
  const svg = svgElement('svg', {
    class: 'driver-pie',
    viewBox: '0 0 240 240',
    role: 'img',
    'aria-label': 'Ticket driver group distribution pie chart'
  })

  let angle = -90
  rows.forEach((row, index) => {
    const share = total > 0 ? row.tickets / total : 0
    if (share <= 0) return
    const next = angle + share * 360
    const path = svgElement('path', {
      d: sectorPath(120, 120, 108, angle, next),
      fill: COLORS[index % COLORS.length],
      class: 'driver-pie-slice',
      tabindex: '0'
    })
    const title = svgElement('title')
    title.textContent = `${row.label}: ${count(row.tickets)} tickets (${percent(share)})`
    path.appendChild(title)
    svg.appendChild(path)
    angle = next
  })

  const caption = document.createElement('div')
  caption.className = 'driver-pie-caption'
  caption.innerHTML = `<strong>${count(total)}</strong><span>mapped driver tickets</span>`
  figure.append(svg, caption)
  return figure
}

function legendRow(row, total, index) {
  const share = total > 0 ? row.tickets / total : 0
  const item = document.createElement('div')
  item.className = 'driver-legend-row'

  const identity = document.createElement('div')
  identity.className = 'driver-legend-identity'
  const marker = document.createElement('span')
  marker.className = 'driver-legend-marker'
  marker.style.backgroundColor = COLORS[index % COLORS.length]
  const label = document.createElement('strong')
  label.className = 'driver-legend-label'
  label.textContent = row.label
  const concerns = document.createElement('span')
  concerns.className = 'driver-legend-concerns'
  concerns.textContent = `${count(row.concerns)} concern ${row.concerns === 1 ? 'type' : 'types'}`
  identity.append(marker, label, concerns)

  const values = document.createElement('div')
  values.className = 'driver-legend-values'
  const tickets = document.createElement('strong')
  tickets.textContent = count(row.tickets)
  const percentage = document.createElement('span')
  percentage.textContent = percent(share)
  values.append(tickets, percentage)
  item.append(identity, values)
  return item
}

function render(rows) {
  const container = document.getElementById('ticketDriverChart')
  if (!container) return
  container.replaceChildren()

  if (!rows.length) {
    container.innerHTML = '<div class="driver-state">No ticket driver data is available.</div>'
    setText('driverTicketTotal', '0')
    setText('driverGroupCount', '0')
    setText('leadingDriverValue', '—')
    return
  }

  const total = rows.reduce((sum, row) => sum + row.tickets, 0)
  const leader = rows.find(row => row.tickets > 0)
  setText('driverTicketTotal', count(total))
  setText('driverGroupCount', count(rows.length))
  setText('leadingDriverValue', leader ? leader.label : 'No volume')

  if (total <= 0) {
    container.innerHTML = '<div class="driver-state">The latest driver data contains only zero values.</div>'
    return
  }

  const layout = document.createElement('div')
  layout.className = 'driver-pie-layout'
  const legend = document.createElement('div')
  legend.className = 'driver-legend'
  rows.forEach((row, index) => legend.appendChild(legendRow(row, total, index)))
  layout.append(pie(rows, total), legend)
  container.appendChild(layout)
}

async function load() {
  const latest = await supabase
    .from('ticket_driver_metrics')
    .select('report_date')
    .order('report_date', { ascending: false })
    .limit(1)

  if (latest.error) throw latest.error
  const date = latest.data?.[0]?.report_date
  const badge = document.getElementById('driverDateBadge')

  if (!date) {
    if (badge) badge.textContent = 'No data'
    render([])
    return
  }

  const result = await supabase
    .from('ticket_driver_metrics')
    .select('driver_group_key, driver_group_label, ticket_count')
    .eq('report_date', date)

  if (result.error) throw result.error
  if (badge) badge.textContent = reportDate(date)
  render(aggregate(result.data || []))
}

export async function initializeDriverPieDashboard() {
  buildMarkup()
  try {
    await load()
  } catch (error) {
    console.error('Unable to load ticket driver pie chart:', error)
    const badge = document.getElementById('driverDateBadge')
    if (badge) badge.textContent = 'Unavailable'
    const container = document.getElementById('ticketDriverChart')
    if (container) {
      container.innerHTML = '<div class="driver-state driver-state-error">Ticket driver data could not be loaded.</div>'
    }
  }
}
