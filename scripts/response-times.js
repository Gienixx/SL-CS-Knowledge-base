import { supabase } from './supabaseClient.js?v=8'
import {
  requiresFirstLoginPasswordChange
} from './first-login-policy.js?v=4'

const REPORT_TIME_ZONE = 'America/New_York'
const SVG_NS = 'http://www.w3.org/2000/svg'
const FILTER_KEYS = Object.freeze([
  'app',
  'platform',
  'country',
  'driver',
  'agent',
  'priority',
  'channel'
])

function elements() {
  return {
    page: document.getElementById('responsePage'),
    status: document.getElementById('responseStatus'),
    content: document.getElementById('responseContent'),
    logout: document.getElementById('responseLogoutLink'),
    form: document.getElementById('responseFilterForm'),
    range: document.getElementById('responseRange'),
    start: document.getElementById('responseStartDate'),
    end: document.getElementById('responseEndDate'),
    validation: document.getElementById('responseFilterValidation'),
    reset: document.getElementById('responseResetFilters'),
    rangeSummary: document.getElementById('responseRangeSummary'),
    activeFilters: document.getElementById('responseActiveFilters'),
    readiness: document.getElementById('slaReadiness'),
    readinessTitle: document.getElementById('slaReadinessTitle'),
    readinessText: document.getElementById('slaReadinessText'),
    summary: document.getElementById('responseSummary'),
    badge: document.getElementById('responseDataBadge'),
    chart: document.getElementById('responseTrendChart'),
    responseBuckets: document.getElementById('responseBuckets'),
    resolutionBuckets: document.getElementById('resolutionBuckets'),
    slaMetrics: document.getElementById('slaMetricBreakdown'),
    tableMeta: document.getElementById('responseTableMeta'),
    tableCaption: document.getElementById('responseTableCaption'),
    tableBody: document.getElementById('responseTableBody'),
    selects: Object.fromEntries(FILTER_KEYS.map(key => [
      key,
      document.getElementById(
        `response${key === 'driver' ? 'Driver' : key[0].toUpperCase() + key.slice(1)}`
      )
    ]))
  }
}

function normalize(value) {
  return String(value || '').trim().toLowerCase()
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) &&
    !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())
}

function addDays(value, amount) {
  const date = new Date(`${value}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + amount)
  return date.toISOString().slice(0, 10)
}

function todayInEastern() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date())
  const values = Object.fromEntries(
    parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value])
  )
  return `${values.year}-${values.month}-${values.day}`
}

function formatDate(value, short = false) {
  if (!value) return 'No date'
  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: short ? 'short' : 'long',
    day: 'numeric',
    year: short ? undefined : 'numeric'
  }).format(date)
}

function formatTimestamp(value) {
  if (!value) return 'Not synchronized'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Not synchronized'
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date)
}

function formatCount(value) {
  const number = Number(value)
  return Number.isFinite(number)
    ? new Intl.NumberFormat('en-US').format(number)
    : 'Unavailable'
}

function formatDuration(value) {
  const minutes = Number(value)
  if (!Number.isFinite(minutes)) return 'Unavailable'
  if (minutes < 60) {
    return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(minutes)} min`
  }
  const hours = minutes / 60
  if (hours < 24) {
    return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(hours)} hr`
  }
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(hours / 24)} days`
}

function parseRequest() {
  const params = new URLSearchParams(window.location.search)
  const allowedRanges = new Set(['7d', '30d', '90d', 'mtd', 'custom'])
  const range = allowedRanges.has(params.get('range'))
    ? params.get('range')
    : '30d'

  return {
    range,
    start: isIsoDate(params.get('start')) ? params.get('start') : '',
    end: isIsoDate(params.get('end')) ? params.get('end') : '',
    ...Object.fromEntries(FILTER_KEYS.map(key => [key, normalize(params.get(key))]))
  }
}

function resolveRange(state) {
  const anchorDate = todayInEastern()
  if (state.range === 'custom') {
    if (!isIsoDate(state.start) || !isIsoDate(state.end)) {
      throw new Error('Choose both a valid start date and end date.')
    }
    if (state.start > state.end) {
      throw new Error('The start date cannot be after the end date.')
    }
    return { startDate: state.start, endDate: state.end }
  }
  if (state.range === 'mtd') {
    return { startDate: `${anchorDate.slice(0, 7)}-01`, endDate: anchorDate }
  }
  const days = Number.parseInt(state.range, 10) || 30
  return { startDate: addDays(anchorDate, -(days - 1)), endDate: anchorDate }
}

function rangeLabel(range) {
  return range.startDate === range.endDate
    ? formatDate(range.startDate)
    : `${formatDate(range.startDate, true)} – ${formatDate(range.endDate)}`
}

async function requireApprovedUser() {
  const {
    data: { user },
    error: userError
  } = await supabase.auth.getUser()

  if (userError) throw userError
  if (!user) {
    window.location.replace('./login.html')
    return null
  }

  let currentUser = user
  if (requiresFirstLoginPasswordChange(currentUser)) {
    const {
      data: { session },
      error: refreshError
    } = await supabase.auth.refreshSession()

    if (!refreshError && session?.user) currentUser = session.user
    if (requiresFirstLoginPasswordChange(currentUser)) {
      window.location.replace('./change-password.html?firstLogin=1')
      return null
    }
  }

  const email = currentUser.email?.trim().toLowerCase()
  if (!email) return null

  const { data, error } = await supabase
    .from('login')
    .select('email')
    .ilike('email', email)
    .limit(1)

  if (error) throw error
  if (!Array.isArray(data) || data.length === 0) {
    await supabase.auth.signOut()
    window.location.replace('./login.html')
    return null
  }
  return currentUser
}

function rpcParameters(state, range) {
  return {
    p_start_date: range.startDate,
    p_end_date: range.endDate,
    p_app_key: state.app || null,
    p_platform_key: state.platform || null,
    p_country_key: state.country || null,
    p_driver_key: state.driver || null,
    p_agent_key: state.agent || null,
    p_priority: state.priority || null,
    p_channel: state.channel || null,
    p_time_zone: REPORT_TIME_ZONE
  }
}

async function loadDashboard(state, range) {
  const { data, error } = await supabase.rpc(
    'get_sla_response_dashboard',
    rpcParameters(state, range)
  )
  if (error) throw error
  return data || {}
}

function initializeForm(ui, state) {
  ui.range.value = state.range
  ui.start.value = state.start
  ui.end.value = state.end
  FILTER_KEYS.forEach(key => {
    if (ui.selects[key]) ui.selects[key].value = state[key]
  })

  const toggleCustom = () => {
    const custom = ui.range.value === 'custom'
    document.querySelectorAll('[data-custom-date]').forEach(field => {
      field.hidden = !custom
    })
    ui.start.required = custom
    ui.end.required = custom
    ui.validation.textContent = ''
  }

  toggleCustom()
  ui.range.addEventListener('change', toggleCustom)
  ui.reset.addEventListener('click', () => {
    window.location.assign('./response-times.html')
  })
  ui.form.addEventListener('submit', event => {
    event.preventDefault()
    const mode = ui.range.value
    const start = ui.start.value
    const end = ui.end.value

    if (mode === 'custom') {
      if (!isIsoDate(start) || !isIsoDate(end)) {
        ui.validation.textContent = 'Choose both a valid start date and end date.'
        return
      }
      if (start > end) {
        ui.validation.textContent = 'The start date cannot be after the end date.'
        return
      }
    }

    const url = new URL(window.location.href)
    url.searchParams.set('range', mode)
    if (mode === 'custom') {
      url.searchParams.set('start', start)
      url.searchParams.set('end', end)
    } else {
      url.searchParams.delete('start')
      url.searchParams.delete('end')
    }

    FILTER_KEYS.forEach(key => {
      const value = normalize(ui.selects[key]?.value)
      if (value) url.searchParams.set(key, value)
      else url.searchParams.delete(key)
    })
    window.location.assign(url.toString())
  })
}

function populateOptions(ui, state, options) {
  FILTER_KEYS.forEach(key => {
    const select = ui.selects[key]
    if (!select) return
    const previous = state[key]
    const firstOption = select.options[0]
    select.replaceChildren(firstOption)
    const rows = Array.isArray(options?.[key]) ? options[key] : []
    rows.forEach(row => {
      const option = document.createElement('option')
      option.value = row.key
      option.textContent = row.label || row.key
      select.appendChild(option)
    })
    select.value = previous
  })
}

function renderActiveFilters(ui, state, range) {
  ui.activeFilters.replaceChildren()
  const chips = [rangeLabel(range), 'Source: Zendesk']
  FILTER_KEYS.forEach(key => {
    if (!state[key]) return
    const selected = ui.selects[key]?.selectedOptions?.[0]?.textContent || state[key]
    chips.push(`${key === 'driver' ? 'concern' : key}: ${selected}`)
  })
  chips.forEach(text => {
    const chip = document.createElement('span')
    chip.textContent = text
    ui.activeFilters.appendChild(chip)
  })
}

function renderReadiness(ui, readiness) {
  const ready = readiness?.slaAvailable === true
  ui.readiness.dataset.ready = String(ready)
  ui.readinessTitle.textContent = ready
    ? 'SLA metric-event stream active'
    : 'SLA reporting unavailable'
  ui.readinessText.textContent = ready
    ? `Last successful SLA sync: ${formatTimestamp(readiness?.slaLastSyncAt)}.`
    : 'First-response and resolution metrics are available, but SLA breach values remain unavailable until the Zendesk SLA stream is enabled and successfully synchronized.'
}

function renderSummary(ui, summary) {
  const cards = [
    ['Average first response', formatDuration(summary?.avg_first_response_calendar_minutes), 'Calendar time'],
    ['Median first response', formatDuration(summary?.median_first_response_calendar_minutes), '50th percentile'],
    ['90th percentile response', formatDuration(summary?.p90_first_response_calendar_minutes), 'Slowest 10% threshold'],
    ['Business-hours response', formatDuration(summary?.avg_first_response_business_minutes), 'Zendesk business time'],
    ['Average resolution', formatDuration(summary?.avg_resolution_minutes), 'Creation to final resolution'],
    ['Median resolution', formatDuration(summary?.median_resolution_minutes), '50th percentile'],
    ['90th percentile resolution', formatDuration(summary?.p90_resolution_minutes), 'Slowest 10% threshold'],
    ['SLA breaches', summary?.sla_breaches == null ? 'Unavailable' : formatCount(summary.sla_breaches), summary?.sla_breached_tickets == null ? 'Awaiting trusted SLA events' : `${formatCount(summary.sla_breached_tickets)} affected tickets`]
  ]

  ui.summary.replaceChildren()
  cards.forEach(([label, value, caption]) => {
    const card = document.createElement('article')
    card.className = 'detail-summary-card response-summary-card'
    const heading = document.createElement('h2')
    heading.textContent = label
    const metric = document.createElement('strong')
    metric.className = 'detail-summary-value'
    metric.textContent = value
    const detail = document.createElement('p')
    detail.textContent = caption
    card.append(heading, metric, detail)
    ui.summary.appendChild(card)
  })
}

function createSvg(tag, attributes = {}) {
  const element = document.createElementNS(SVG_NS, tag)
  Object.entries(attributes).forEach(([name, value]) => {
    element.setAttribute(name, String(value))
  })
  return element
}

function niceMaximum(value) {
  if (!Number.isFinite(value) || value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const normalized = value / magnitude
  const rounded = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return rounded * magnitude
}

function linePath(rows, key, dimensions, maximum) {
  const valid = rows
    .map((row, index) => ({ index, value: Number(row[key]) }))
    .filter(point => Number.isFinite(point.value))
  if (valid.length === 0) return ''
  return valid.map((point, sequence) => {
    const x = rows.length === 1
      ? dimensions.left + dimensions.width / 2
      : dimensions.left + (point.index / (rows.length - 1)) * dimensions.width
    const y = dimensions.top + dimensions.height - (point.value / maximum) * dimensions.height
    return `${sequence === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
  }).join(' ')
}

function renderTrend(ui, rows) {
  ui.chart.replaceChildren()
  const values = rows.flatMap(row => [
    Number(row.first_response_minutes),
    Number(row.resolution_minutes)
  ]).filter(Number.isFinite)

  if (!Array.isArray(rows) || rows.length === 0 || values.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'response-empty'
    empty.textContent = 'No response-time or resolution-time records match this selection.'
    ui.chart.appendChild(empty)
    return
  }

  const svg = createSvg('svg', {
    viewBox: '0 0 900 350',
    role: 'img',
    'aria-label': 'Daily first-response and resolution time trend'
  })
  const dimensions = { left: 70, top: 22, width: 800, height: 260 }
  const maximum = niceMaximum(Math.max(...values))

  for (let tick = 0; tick <= 5; tick += 1) {
    const ratio = tick / 5
    const y = dimensions.top + ratio * dimensions.height
    const value = maximum * (1 - ratio)
    svg.appendChild(createSvg('line', {
      x1: dimensions.left,
      y1: y,
      x2: dimensions.left + dimensions.width,
      y2: y,
      class: 'response-chart-grid'
    }))
    const label = createSvg('text', {
      x: dimensions.left - 10,
      y: y + 4,
      'text-anchor': 'end',
      class: 'response-chart-text'
    })
    label.textContent = formatDuration(value)
    svg.appendChild(label)
  }

  svg.appendChild(createSvg('line', {
    x1: dimensions.left,
    y1: dimensions.top,
    x2: dimensions.left,
    y2: dimensions.top + dimensions.height,
    class: 'response-chart-axis'
  }))
  svg.appendChild(createSvg('line', {
    x1: dimensions.left,
    y1: dimensions.top + dimensions.height,
    x2: dimensions.left + dimensions.width,
    y2: dimensions.top + dimensions.height,
    class: 'response-chart-axis'
  }))

  const labelCount = Math.min(6, rows.length)
  const indexes = new Set()
  for (let index = 0; index < labelCount; index += 1) {
    indexes.add(labelCount === 1 ? 0 : Math.round((index / (labelCount - 1)) * (rows.length - 1)))
  }
  indexes.forEach(index => {
    const x = rows.length === 1
      ? dimensions.left + dimensions.width / 2
      : dimensions.left + (index / (rows.length - 1)) * dimensions.width
    const label = createSvg('text', {
      x,
      y: dimensions.top + dimensions.height + 28,
      'text-anchor': 'middle',
      class: 'response-chart-text'
    })
    label.textContent = formatDate(rows[index].report_date, true)
    svg.appendChild(label)
  })

  const series = [
    ['first_response_minutes', 'response-chart-line-response', 'response-chart-point-response', 'First response'],
    ['resolution_minutes', 'response-chart-line-resolution', 'response-chart-point-resolution', 'Resolution']
  ]

  series.forEach(([key, lineClass, pointClass, label]) => {
    const path = linePath(rows, key, dimensions, maximum)
    if (path) svg.appendChild(createSvg('path', { d: path, class: lineClass }))
    rows.forEach((row, index) => {
      const value = Number(row[key])
      if (!Number.isFinite(value)) return
      const x = rows.length === 1
        ? dimensions.left + dimensions.width / 2
        : dimensions.left + (index / (rows.length - 1)) * dimensions.width
      const y = dimensions.top + dimensions.height - (value / maximum) * dimensions.height
      const point = createSvg('circle', { cx: x, cy: y, r: 3.5, class: pointClass })
      const title = createSvg('title')
      title.textContent = `${formatDate(row.report_date)} — ${label}: ${formatDuration(value)}`
      point.appendChild(title)
      svg.appendChild(point)
    })
  })

  const legend = document.createElement('div')
  legend.className = 'response-chart-legend'
  legend.innerHTML = '<span><i style="background:#382f90"></i>First response</span><span><i style="background:#d98900"></i>Resolution</span>'
  ui.chart.append(svg, legend)
}

function renderBars(container, rows, valueKey, emptyMessage) {
  container.replaceChildren()
  if (!Array.isArray(rows) || rows.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'response-empty'
    empty.textContent = emptyMessage
    container.appendChild(empty)
    return
  }
  const maximum = Math.max(...rows.map(row => Number(row[valueKey]) || 0), 1)
  rows.forEach(row => {
    const value = Number(row[valueKey]) || 0
    const item = document.createElement('div')
    item.className = 'response-bar-row'
    const label = document.createElement('span')
    label.className = 'response-bar-label'
    label.textContent = row.label || row.key || 'Unknown'
    const track = document.createElement('span')
    track.className = 'response-bar-track'
    const fill = document.createElement('span')
    fill.className = 'response-bar-fill'
    fill.style.width = `${(value / maximum) * 100}%`
    track.appendChild(fill)
    const metric = document.createElement('strong')
    metric.className = 'response-bar-value'
    metric.textContent = formatCount(value)
    item.append(label, track, metric)
    container.appendChild(item)
  })
}

function renderTable(ui, rows, slaAvailable) {
  const descending = [...rows].reverse()
  ui.tableBody.replaceChildren()
  descending.forEach(row => {
    const tr = document.createElement('tr')
    const values = [
      formatDate(row.report_date),
      formatDuration(row.first_response_minutes),
      formatDuration(row.resolution_minutes),
      slaAvailable ? formatCount(row.sla_breaches) : 'Unavailable'
    ]
    values.forEach(value => {
      const cell = document.createElement('td')
      cell.textContent = value
      tr.appendChild(cell)
    })
    ui.tableBody.appendChild(tr)
  })
  ui.tableMeta.textContent = `${formatCount(rows.length)} reporting day${rows.length === 1 ? '' : 's'}`
  ui.tableCaption.textContent = rows.length > 0
    ? `Daily response-time values for ${formatDate(rows[0].report_date, true)} through ${formatDate(rows.at(-1).report_date)}.`
    : 'No daily response-time records match this selection.'
}

function showError(ui, error) {
  console.error('Response-time dashboard error:', error)
  ui.page.setAttribute('aria-busy', 'false')
  ui.status.replaceChildren()
  const heading = document.createElement('h2')
  heading.textContent = 'Unable to load response-time reporting'
  const detail = document.createElement('p')
  const missingRpc = String(error?.message || '').includes('get_sla_response_dashboard') ||
    error?.code === 'PGRST202'
  detail.textContent = missingRpc
    ? 'The Step 6 database migration has not been applied or the Supabase schema cache has not refreshed.'
    : 'The reporting data could not be loaded. Refresh the page or contact an administrator.'
  ui.status.append(heading, detail)
}

async function initialize() {
  const ui = elements()
  const state = parseRequest()
  initializeForm(ui, state)

  ui.logout.addEventListener('click', async event => {
    event.preventDefault()
    await supabase.auth.signOut()
    window.location.href = './login.html'
  })

  try {
    const user = await requireApprovedUser()
    if (!user) return
    const range = resolveRange(state)
    const data = await loadDashboard(state, range)
    const trend = Array.isArray(data.trend) ? data.trend : []
    const slaAvailable = data.readiness?.slaAvailable === true

    populateOptions(ui, state, data.options || {})
    renderActiveFilters(ui, state, range)
    renderReadiness(ui, data.readiness || {})
    renderSummary(ui, data.summary || {})
    renderTrend(ui, trend)
    renderBars(
      ui.responseBuckets,
      data.responseBuckets,
      'ticket_count',
      'No first-response records match this selection.'
    )
    renderBars(
      ui.resolutionBuckets,
      data.resolutionBuckets,
      'ticket_count',
      'No resolved tickets match this selection.'
    )
    renderBars(
      ui.slaMetrics,
      slaAvailable ? data.slaMetrics : [],
      'breach_count',
      slaAvailable
        ? 'No SLA breaches were recorded for this selection.'
        : 'SLA breach reporting is unavailable until the Zendesk SLA stream is enabled and successfully synchronized.'
    )
    renderTable(ui, trend, slaAvailable)

    ui.rangeSummary.textContent = rangeLabel(range)
    ui.badge.textContent = `Zendesk · ${formatCount(trend.length)} days`
    ui.status.hidden = true
    ui.content.hidden = false
    ui.page.setAttribute('aria-busy', 'false')
  } catch (error) {
    showError(ui, error)
  }
}

initialize()
