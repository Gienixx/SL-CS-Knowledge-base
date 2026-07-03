import {
  comparison,
  formatCount,
  formatDate,
  formatMinutes,
  formatPercent,
  latestDate,
  loadTargets,
  logout,
  parseRange,
  previousRange,
  rangeLabel,
  requireApprovedUser,
  resolveRange,
  rowsForRange,
  targetStatus
} from './sheet-reporting.js?v=1'

const SVG_NS = 'http://www.w3.org/2000/svg'

function ui() {
  return {
    page: document.getElementById('responsePage'), status: document.getElementById('responseStatus'), content: document.getElementById('responseContent'), logout: document.getElementById('responseLogoutLink'),
    form: document.getElementById('responseFilterForm'), range: document.getElementById('responseRange'), start: document.getElementById('responseStartDate'), end: document.getElementById('responseEndDate'),
    reset: document.getElementById('responseResetFilters'), validation: document.getElementById('responseFilterValidation'), rangeSummary: document.getElementById('responseRangeSummary'), activeFilters: document.getElementById('responseActiveFilters'),
    availability: document.getElementById('responseAvailability'), availabilityTitle: document.getElementById('responseAvailabilityTitle'), availabilityText: document.getElementById('responseAvailabilityText'),
    summary: document.getElementById('responseSummary'), badge: document.getElementById('responseDataBadge'), chart: document.getElementById('responseTrendChart'), tableMeta: document.getElementById('responseTableMeta'),
    tableCaption: document.getElementById('responseTableCaption'), tableBody: document.getElementById('responseTableBody')
  }
}

function parseState() { return parseRange(new URLSearchParams(window.location.search), '30d') }

async function loadRows(range) {
  return rowsForRange(
    'daily_ticket_metrics',
    'report_date, responded_tickets, first_response_minutes_total, first_response_median_minutes, resolved_tickets, resolution_minutes_total, resolution_median_minutes',
    range
  )
}

function normalizeRows(rows) {
  return rows.map(row => {
    const responded = Number(row.responded_tickets) || 0
    const resolved = Number(row.resolved_tickets) || 0
    return {
      report_date: row.report_date,
      responded_tickets: responded,
      avg_first_response: responded > 0 ? Number(row.first_response_minutes_total) / responded : null,
      median_first_response: responded > 0 ? Number(row.first_response_median_minutes) : null,
      resolved_tickets: resolved,
      avg_resolution: resolved > 0 ? Number(row.resolution_minutes_total) / resolved : null,
      median_resolution: resolved > 0 ? Number(row.resolution_median_minutes) : null
    }
  })
}

function weightedAverage(rows, valueKey, countKey) {
  const valid = rows.filter(row => Number.isFinite(Number(row[valueKey])) && Number(row[countKey]) > 0)
  const count = valid.reduce((total, row) => total + Number(row[countKey]), 0)
  return count ? valid.reduce((total, row) => total + Number(row[valueKey]) * Number(row[countKey]), 0) / count : null
}

function average(rows, key) {
  const values = rows.map(row => Number(row[key])).filter(Number.isFinite)
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
}

function model(rows) {
  const normalized = normalizeRows(rows)
  return {
    rows: normalized,
    responded: normalized.reduce((total, row) => total + row.responded_tickets, 0),
    resolved: normalized.reduce((total, row) => total + row.resolved_tickets, 0),
    avgFirst: weightedAverage(normalized, 'avg_first_response', 'responded_tickets'),
    medianFirst: average(normalized.filter(row => row.responded_tickets > 0), 'median_first_response'),
    avgResolution: weightedAverage(normalized, 'avg_resolution', 'resolved_tickets'),
    medianResolution: average(normalized.filter(row => row.resolved_tickets > 0), 'median_resolution')
  }
}

function initializeForm(elements, state, range) {
  elements.range.value = state.range; elements.start.value = state.start; elements.end.value = state.end
  const toggle = () => { const custom = elements.range.value === 'custom'; document.querySelectorAll('[data-custom-date]').forEach(field => { field.hidden = !custom }); elements.start.required = custom; elements.end.required = custom }
  toggle(); elements.range.addEventListener('change', toggle)
  elements.reset.addEventListener('click', () => window.location.assign('./response-times.html'))
  elements.form.addEventListener('submit', event => {
    event.preventDefault(); const params = new URLSearchParams({ range: elements.range.value })
    if (elements.range.value === 'custom') {
      if (!elements.start.value || !elements.end.value || elements.start.value > elements.end.value) { elements.validation.textContent = 'Choose a valid custom date range.'; return }
      params.set('start', elements.start.value); params.set('end', elements.end.value)
    }
    window.location.assign(`./response-times.html?${params}`)
  })
  elements.rangeSummary.textContent = rangeLabel(range)
}

function renderActive(elements, range, priorRange) {
  elements.activeFilters.replaceChildren()
  for (const text of [rangeLabel(range), `Previous: ${rangeLabel(priorRange)}`, 'Synchronized Google Sheet']) { const chip = document.createElement('span'); chip.textContent = text; elements.activeFilters.appendChild(chip) }
}

function renderAvailability(elements, current) {
  const responseAvailable = current.responded > 0
  const resolutionAvailable = current.resolved > 0
  const ready = responseAvailable || resolutionAvailable
  elements.availability.dataset.ready = String(ready)
  elements.availabilityTitle.textContent = ready ? 'Synchronized response fields available' : 'Response-time fields are not populated'
  elements.availabilityText.textContent = ready
    ? `${formatCount(current.responded)} responded and ${formatCount(current.resolved)} resolved tickets support the available calculations.`
    : 'The current Google Sheet synchronization did not provide responded or resolved ticket counts for this date range. Values remain unavailable rather than being inferred.'
}

function addCard(container, label, value, caption) {
  const card = document.createElement('article'); card.className = 'response-summary-card'
  const heading = document.createElement('h2'); heading.textContent = label
  const strong = document.createElement('strong'); strong.textContent = value
  const p = document.createElement('p'); p.textContent = caption
  card.append(heading, strong, p); container.appendChild(card)
}

function renderSummary(elements, current, prior, targets) {
  elements.summary.replaceChildren()
  addCard(elements.summary, 'Avg first response', formatMinutes(current.avgFirst), 'Current period')
  addCard(elements.summary, 'Median first response', formatMinutes(current.medianFirst), 'Current period')
  addCard(elements.summary, 'Avg resolution', formatMinutes(current.avgResolution), 'Current period')
  addCard(elements.summary, 'Median resolution', formatMinutes(current.medianResolution), 'Current period')
  for (const [label, currentValue, priorValue, key] of [
    ['First-response comparison', current.avgFirst, prior.avgFirst, 'first_response_minutes'],
    ['Resolution comparison', current.avgResolution, prior.avgResolution, 'resolution_minutes']
  ]) {
    const change = comparison(currentValue, priorValue)
    addCard(elements.summary, label, formatMinutes(change.absolute), `${formatPercent(change.percentage)} vs previous period`)
    const target = targets.get(key); const status = targetStatus(currentValue, target)
    if (status) addCard(elements.summary, target.label || `${label} target`, status.met ? 'Met' : 'Not met', `${formatMinutes(currentValue)} vs ${formatMinutes(status.goal)}`)
  }
}

function svg(name, attributes = {}) { const node = document.createElementNS(SVG_NS, name); Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value))); return node }

function renderChart(elements, current) {
  elements.chart.replaceChildren()
  const rows = current.rows.filter(row => Number.isFinite(row.avg_first_response) || Number.isFinite(row.avg_resolution))
  if (!rows.length) { elements.chart.textContent = 'No synchronized response-time values are available for this date range.'; return }
  const scroll = document.createElement('div'); scroll.className = 'response-chart-scroll'
  const image = svg('svg', { class: 'response-chart-svg', viewBox: '0 0 900 340', role: 'img', 'aria-label': 'Response-time trend' })
  const left = 62, top = 24, width = 806, height = 250
  const series = [['avg_first_response', 'First response'], ['avg_resolution', 'Resolution']]
  const maximum = Math.max(1, ...rows.flatMap(row => series.map(([key]) => Number(row[key]) || 0)))
  series.forEach(([key, label], index) => {
    const points = rows.map((row, rowIndex) => ({ x: rows.length === 1 ? left + width / 2 : left + rowIndex / (rows.length - 1) * width, y: top + height - (Number(row[key]) || 0) / maximum * height, value: Number(row[key]), date: row.report_date }))
    image.appendChild(svg('path', { d: points.map((point, pointIndex) => `${pointIndex ? 'L' : 'M'} ${point.x} ${point.y}`).join(' '), class: index ? 'response-chart-line-resolution' : 'response-chart-line-first' }))
    points.forEach(point => { const circle = svg('circle', { cx: point.x, cy: point.y, r: 3.5, class: index ? 'response-chart-point-resolution' : 'response-chart-point-first' }); const title = svg('title'); title.textContent = `${formatDate(point.date)} — ${label}: ${formatMinutes(point.value)}`; circle.appendChild(title); image.appendChild(circle) })
  })
  scroll.appendChild(image); elements.chart.appendChild(scroll)
}

function renderTable(elements, current) {
  elements.tableBody.replaceChildren()
  ;[...current.rows].reverse().forEach(row => {
    const tr = document.createElement('tr')
    for (const value of [formatDate(row.report_date), formatCount(row.responded_tickets), formatMinutes(row.avg_first_response), formatMinutes(row.median_first_response), formatCount(row.resolved_tickets), formatMinutes(row.avg_resolution), formatMinutes(row.median_resolution)]) { const td = document.createElement('td'); td.textContent = value; tr.appendChild(td) }
    elements.tableBody.appendChild(tr)
  })
  elements.tableMeta.textContent = `${formatCount(current.rows.length)} day${current.rows.length === 1 ? '' : 's'}`
  elements.tableCaption.textContent = current.rows.length ? 'Daily synchronized response-time fields.' : 'No daily rows match this date range.'
}

function showError(elements, error) {
  elements.page.setAttribute('aria-busy', 'false'); elements.content.hidden = true; elements.status.hidden = false; elements.status.replaceChildren()
  const h = document.createElement('h2'); h.textContent = 'Response Times unavailable'
  const p = document.createElement('p'); p.textContent = error?.message || 'The page could not be loaded.'
  elements.status.append(h, p)
}

async function initialize() {
  const elements = ui(); elements.logout.addEventListener('click', event => { event.preventDefault(); logout() })
  try {
    const state = parseState(); const user = await requireApprovedUser(); if (!user) return
    const anchor = await latestDate('daily_ticket_metrics'); const range = resolveRange(state, anchor); const priorRange = previousRange(range)
    const [currentRows, priorRows, targets] = await Promise.all([loadRows(range), loadRows(priorRange), loadTargets(['first_response_minutes', 'resolution_minutes'])])
    const current = model(currentRows), prior = model(priorRows)
    initializeForm(elements, state, range); renderActive(elements, range, priorRange); renderAvailability(elements, current); renderSummary(elements, current, prior, targets); renderChart(elements, current); renderTable(elements, current)
    elements.badge.textContent = 'Synchronized Google Sheet'; elements.status.hidden = true; elements.content.hidden = false; elements.page.setAttribute('aria-busy', 'false')
  } catch (error) { console.error('Unable to initialize response times:', error); showError(elements, error) }
}

initialize()
