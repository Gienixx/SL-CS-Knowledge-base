import {
  DIMENSION_KEYS,
  comparison,
  formatAht,
  formatCount,
  formatDate,
  formatMinutes,
  formatPercent,
  latestDate,
  loadAgentDimensionRows,
  loadFilterOptions,
  loadTargets,
  logout,
  normalize,
  parseRange,
  previousRange,
  rangeLabel,
  requireApprovedUser,
  resolveRange,
  rowsForRange,
  selectedDimension,
  supabase,
  targetStatus
} from './sheet-reporting.js?v=1'

const SVG_NS = 'http://www.w3.org/2000/svg'
const FILTER_KEYS = Object.freeze(['agent', ...DIMENSION_KEYS])

const REPORTS = Object.freeze({
  'new-vs-solved': { title: 'New vs. Solved Tickets', defaultRange: '30d', kind: 'ticket-trend', table: 'daily_ticket_metrics', metricKey: 'ticket_volume' },
  'new-tickets': { title: 'New Tickets', defaultRange: '30d', kind: 'ticket-metric', table: 'daily_ticket_metrics', metric: 'new_tickets', metricKey: 'new_tickets' },
  'solved-tickets': { title: 'Solved Tickets', defaultRange: '30d', kind: 'ticket-metric', table: 'daily_ticket_metrics', metric: 'solved_tickets', metricKey: 'solved_tickets' },
  'unsolved-tickets': { title: 'Unsolved Tickets', defaultRange: '30d', kind: 'ticket-stock', table: 'daily_ticket_metrics', metric: 'unsolved_tickets', metricKey: 'unsolved_tickets' },
  'one-touch-resolution': { title: 'One-Touch Resolution', defaultRange: '30d', kind: 'ticket-rate', table: 'daily_ticket_metrics', metric: 'one_touch_resolution', metricKey: 'one_touch_resolution' },
  'reopened-rate': { title: 'Reopened Rate', defaultRange: '30d', kind: 'ticket-rate', table: 'daily_ticket_metrics', metric: 'reopened_rate', metricKey: 'reopened_rate' },
  app: { title: 'Tickets by App', defaultRange: 'latest', kind: 'distribution', table: 'daily_distribution_metrics', dimension: 'app', metricKey: 'app_ticket_count' },
  platform: { title: 'Tickets by Platform', defaultRange: 'latest', kind: 'distribution', table: 'daily_distribution_metrics', dimension: 'platform', metricKey: 'platform_ticket_count' },
  country: { title: 'Tickets by Country', defaultRange: 'latest', kind: 'distribution', table: 'daily_distribution_metrics', dimension: 'country', metricKey: 'country_ticket_count' },
  concern: { title: 'Tickets by Concern', defaultRange: 'latest', kind: 'concern', table: 'ticket_driver_metrics', dimension: 'concern', metricKey: 'concern_ticket_count' },
  'agent-productivity': { title: 'Agent Productivity', defaultRange: 'latest', kind: 'agent', table: 'agent_productivity', metricKey: 'agent_solved_tickets' }
})

function ui() {
  return {
    page: document.getElementById('reportPage'),
    status: document.getElementById('reportStatus'),
    content: document.getElementById('reportContent'),
    title: document.getElementById('reportTitle'),
    subtitle: document.getElementById('reportSubtitle'),
    logout: document.getElementById('reportLogoutLink'),
    form: document.getElementById('reportFilterForm'),
    range: document.getElementById('reportRange'),
    start: document.getElementById('reportStartDate'),
    end: document.getElementById('reportEndDate'),
    validation: document.getElementById('reportFilterValidation'),
    reset: document.getElementById('reportResetFilters'),
    source: document.getElementById('reportSourceBadge'),
    rangeSummary: document.getElementById('reportRangeSummary'),
    activeFilters: document.getElementById('reportActiveFilters'),
    summary: document.getElementById('reportSummary'),
    chartTitle: document.getElementById('reportChartTitle'),
    chartSubtitle: document.getElementById('reportChartSubtitle'),
    chart: document.getElementById('reportChart'),
    dataBadge: document.getElementById('reportDataBadge'),
    breakdownSection: document.getElementById('reportBreakdownSection'),
    breakdownTitle: document.getElementById('reportBreakdownTitle'),
    breakdownSubtitle: document.getElementById('reportBreakdownSubtitle'),
    breakdown: document.getElementById('reportBreakdown'),
    tableTitle: document.getElementById('reportTableTitle'),
    tableSubtitle: document.getElementById('reportTableSubtitle'),
    tableMeta: document.getElementById('reportTableMeta'),
    tableCaption: document.getElementById('reportTableCaption'),
    tableHead: document.getElementById('reportTableHead'),
    tableBody: document.getElementById('reportTableBody')
  }
}

function parseRequest() {
  const params = new URLSearchParams(window.location.search)
  const reportKey = normalize(params.get('report'))
  const config = REPORTS[reportKey]
  if (!config) throw new Error('This report link is invalid. Return to the dashboard and open a chart again.')
  const state = {
    ...parseRange(params, config.defaultRange),
    agent: normalize(params.get('agent')),
    app: normalize(params.get('app')),
    platform: normalize(params.get('platform')),
    country: normalize(params.get('country')),
    concern: normalize(params.get('concern') || params.get('driver')),
    priority: normalize(params.get('priority')),
    channel: normalize(params.get('channel'))
  }
  return { reportKey, config, state }
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + (Number(row[key]) || 0), 0)
}

function average(rows, key) {
  const values = rows.map(row => Number(row[key])).filter(Number.isFinite)
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
}

function aggregate(rows, keyField, labelField, valueField) {
  const map = new Map()
  rows.forEach(row => {
    const key = normalize(row[keyField])
    if (!key) return
    const item = map.get(key) || { key, label: row[labelField] || key, value: 0 }
    item.value += Number(row[valueField]) || 0
    map.set(key, item)
  })
  return [...map.values()].sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
}

function metricFormatter(kind, value) {
  if (kind === 'ticket-rate') return formatPercent(value, { ratio: true })
  return formatCount(value)
}

function ticketModel(config, rows) {
  const normalizedRows = rows.map(row => ({
    report_date: row.report_date,
    new_tickets: Number(row.new_tickets) || 0,
    solved_tickets: Number(row.solved_tickets) || 0,
    unsolved_tickets: Number(row.unsolved_tickets) || 0,
    one_touch_resolution: Number.isFinite(Number(row.one_touch_resolution)) ? Number(row.one_touch_resolution) : null,
    reopened_rate: Number.isFinite(Number(row.reopened_rate)) ? Number(row.reopened_rate) : null
  }))
  const latest = normalizedRows.at(-1)
  if (config.kind === 'ticket-trend') {
    const created = sum(normalizedRows, 'new_tickets')
    const solved = sum(normalizedRows, 'solved_tickets')
    return {
      metricKey: config.metricKey,
      metricValue: created + solved,
      format: 'count',
      summary: [
        ['New tickets', formatCount(created), 'Selected period'],
        ['Solved tickets', formatCount(solved), 'Selected period'],
        ['Net change', formatCount(created - solved), 'New minus solved'],
        ['Latest backlog', formatCount(latest?.unsolved_tickets), 'Latest synchronized day']
      ],
      chart: { type: 'line', rows: normalizedRows, series: [['new_tickets', 'New tickets'], ['solved_tickets', 'Solved tickets']] },
      breakdown: [],
      table: { columns: [['report_date', 'Date', 'date'], ['new_tickets', 'New', 'count'], ['solved_tickets', 'Solved', 'count'], ['unsolved_tickets', 'Unsolved', 'count']], rows: normalizedRows }
    }
  }

  const metric = config.metric
  const rate = config.kind === 'ticket-rate'
  const value = config.kind === 'ticket-stock'
    ? latest?.[metric]
    : rate
      ? average(normalizedRows, metric)
      : sum(normalizedRows, metric)
  const chartRows = normalizedRows.map(row => ({ report_date: row.report_date, value: row[metric] }))
  return {
    metricKey: config.metricKey,
    metricValue: value,
    format: rate ? 'ratio' : 'count',
    summary: [[config.title, metricFormatter(config.kind, value), config.kind === 'ticket-stock' ? 'Latest synchronized day' : rate ? 'Average daily rate' : 'Selected-period total']],
    chart: { type: 'line', rows: chartRows, series: [['value', config.title]], percent: rate },
    breakdown: [],
    table: { columns: [['report_date', 'Date', 'date'], ['value', config.title, rate ? 'ratio' : 'count']], rows: chartRows }
  }
}

function distributionModel(config, rows, selectedValue = '') {
  const filtered = selectedValue ? rows.filter(row => normalize(row.dimension_key) === selectedValue) : rows
  const breakdown = aggregate(filtered, 'dimension_key', 'dimension_label', 'ticket_count')
  const total = breakdown.reduce((value, row) => value + row.value, 0)
  const daily = aggregateByDate(filtered, 'ticket_count')
  return {
    metricKey: config.metricKey,
    metricValue: total,
    format: 'count',
    summary: [
      ['Tickets', formatCount(total), 'Selected period'],
      ['Categories', formatCount(breakdown.length), config.title],
      ['Leading category', breakdown[0]?.label || 'Unavailable', breakdown[0] ? formatCount(breakdown[0].value) : 'No synchronized rows']
    ],
    chart: selectedValue
      ? { type: 'line', rows: daily, series: [['value', 'Tickets']] }
      : { type: 'bar', rows: breakdown },
    breakdown,
    table: { columns: [['label', 'Category', 'text'], ['value', 'Tickets', 'count'], ['share', 'Share', 'percent']], rows: breakdown.map(row => ({ ...row, share: total ? row.value / total * 100 : 0 })) }
  }
}

function concernModel(config, rows, selectedValue = '') {
  const normalizedRows = rows.map(row => ({
    report_date: row.report_date,
    key: normalize(row.driver_key),
    label: row.driver_label || row.driver_key,
    ticket_count: Number(row.ticket_count) || 0
  }))
  const filtered = selectedValue ? normalizedRows.filter(row => row.key === selectedValue) : normalizedRows
  const breakdown = aggregate(filtered, 'key', 'label', 'ticket_count')
  const total = breakdown.reduce((value, row) => value + row.value, 0)
  return {
    metricKey: config.metricKey,
    metricValue: total,
    format: 'count',
    summary: [['Concern tickets', formatCount(total), 'Selected period'], ['Concern groups', formatCount(breakdown.length), 'Synchronized groups']],
    chart: selectedValue ? { type: 'line', rows: aggregateByDate(filtered, 'ticket_count'), series: [['value', 'Tickets']] } : { type: 'bar', rows: breakdown },
    breakdown,
    table: { columns: [['label', 'Concern', 'text'], ['value', 'Tickets', 'count'], ['share', 'Share', 'percent']], rows: breakdown.map(row => ({ ...row, share: total ? row.value / total * 100 : 0 })) }
  }
}

function aggregateByDate(rows, valueField) {
  const map = new Map()
  rows.forEach(row => map.set(row.report_date, (map.get(row.report_date) || 0) + (Number(row[valueField]) || 0)))
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([report_date, value]) => ({ report_date, value }))
}

function agentModel(rows) {
  const groups = new Map()
  rows.forEach(row => {
    const key = normalize(row.agent_key)
    if (!key) return
    const item = groups.get(key) || { agent_key: key, agent_name: row.agent_name || key, solved_tickets: 0, latest_open: null, latest_date: '', aht_weight: 0, aht_solved: 0, aht_values: [] }
    item.solved_tickets += Number(row.solved_tickets) || 0
    if (row.report_date >= item.latest_date) {
      item.latest_date = row.report_date
      item.latest_open = Number(row.open_tickets)
    }
    const aht = Number(row.aht_value)
    const solved = Number(row.solved_tickets) || 0
    if (Number.isFinite(aht)) {
      item.aht_values.push(aht)
      if (solved > 0) { item.aht_weight += aht * solved; item.aht_solved += solved }
    }
    groups.set(key, item)
  })
  const agents = [...groups.values()].map(item => ({
    ...item,
    avg_aht: item.aht_solved ? item.aht_weight / item.aht_solved : average(item.aht_values.map(value => ({ value })), 'value')
  })).sort((a, b) => b.solved_tickets - a.solved_tickets || a.agent_name.localeCompare(b.agent_name))
  const solved = sum(agents, 'solved_tickets')
  const open = sum(agents, 'latest_open')
  return {
    metricKey: 'agent_solved_tickets',
    metricValue: solved,
    format: 'count',
    summary: [['Team solved', formatCount(solved), 'Selected period'], ['Latest open', formatCount(open), 'Latest synchronized snapshot'], ['Agents', formatCount(agents.length), 'Matching selection']],
    chart: { type: 'bar', rows: agents.map(row => ({ key: row.agent_key, label: row.agent_name, value: row.solved_tickets, drilldown: 'agent' })) },
    breakdown: agents.map(row => ({ key: row.agent_key, label: row.agent_name, value: row.solved_tickets, drilldown: 'agent' })),
    table: { columns: [['agent_name', 'Agent', 'text'], ['solved_tickets', 'Solved', 'count'], ['latest_open', 'Latest Open', 'count'], ['avg_aht', 'AHT', 'aht']], rows: agents }
  }
}

function filteredDimensionModel(rows, dimension, agentKey) {
  const total = sum(rows, 'ticket_count')
  const daily = aggregateByDate(rows, 'ticket_count')
  const agents = aggregate(rows, 'agent_key', 'agent_name', 'ticket_count').map(row => ({ ...row, drilldown: 'agent' }))
  const label = rows[0]?.dimension_label || dimension.value
  return {
    metricKey: `${dimension.key}_ticket_count`,
    metricValue: total,
    format: 'count',
    summary: [
      ['Matched tickets', formatCount(total), `${dimension.key}: ${label}`],
      ['Reporting days', formatCount(daily.length), 'Synchronized Google Sheet'],
      ['Agents represented', formatCount(agents.length), agentKey ? 'Selected agent' : 'Agent-level dimension rows']
    ],
    chart: { type: 'line', rows: daily, series: [['value', 'Matched tickets']] },
    breakdown: agents,
    table: { columns: [['label', 'Agent', 'text'], ['value', 'Matched tickets', 'count'], ['share', 'Share', 'percent']], rows: agents.map(row => ({ ...row, share: total ? row.value / total * 100 : 0 })) },
    filteredLabel: label
  }
}

async function loadBaseModel(config, state, range) {
  const dimension = selectedDimension(state)

  if (dimension && !state.agent && config.kind === 'distribution' && dimension.key === config.dimension) {
    const rows = await rowsForRange(
      'daily_distribution_metrics',
      'report_date, dimension_type, dimension_key, dimension_label, ticket_count',
      range,
      query => query
        .eq('dimension_type', config.dimension)
        .eq('dimension_key', dimension.value)
    )
    return distributionModel(config, rows, dimension.value)
  }

  if (dimension && !state.agent && config.kind === 'concern' && dimension.key === 'concern') {
    const rows = await rowsForRange(
      'ticket_driver_metrics',
      'report_date, driver_key, driver_label, ticket_count',
      range,
      query => query.eq('driver_key', dimension.value)
    )
    return concernModel(config, rows, dimension.value)
  }

  if (dimension) {
    const rows = await loadAgentDimensionRows(range, dimension, state.agent)
    if (!rows.length) {
      throw new Error('No agent-level dimension rows match this filter. Run a Google Sheet synchronization that includes agent_dimension_metrics before using this cross-filter.')
    }
    return filteredDimensionModel(rows, dimension, state.agent)
  }

  if (config.kind === 'agent') {
    const rows = await rowsForRange(
      'agent_productivity',
      'report_date, agent_key, agent_name, solved_tickets, open_tickets, aht_value',
      range,
      query => state.agent ? query.eq('agent_key', state.agent) : query
    )
    return agentModel(rows)
  }

  if (state.agent && (config.kind === 'distribution' || config.kind === 'concern')) {
    const dimensionType = config.kind === 'concern' ? 'concern' : config.dimension
    const rows = await rowsForRange(
      'agent_dimension_metrics',
      'report_date, agent_key, agent_name, dimension_type, dimension_key, dimension_label, ticket_count',
      range,
      query => query.eq('agent_key', state.agent).eq('dimension_type', dimensionType)
    )
    if (!rows.length) {
      throw new Error(`No synchronized ${dimensionType} rows are available for the selected agent.`)
    }
    const breakdown = aggregate(rows, 'dimension_key', 'dimension_label', 'ticket_count')
    const total = breakdown.reduce((sumValue, row) => sumValue + row.value, 0)
    return {
      metricKey: `${dimensionType}_ticket_count`,
      metricValue: total,
      format: 'count',
      summary: [
        ['Matched tickets', formatCount(total), 'Selected agent'],
        ['Categories', formatCount(breakdown.length), `Agent ${dimensionType} distribution`],
        ['Leading category', breakdown[0]?.label || 'Unavailable', breakdown[0] ? formatCount(breakdown[0].value) : 'No synchronized rows']
      ],
      chart: { type: 'bar', rows: breakdown },
      breakdown,
      table: {
        columns: [['label', 'Category', 'text'], ['value', 'Tickets', 'count'], ['share', 'Share', 'percent']],
        rows: breakdown.map(row => ({ ...row, share: total ? row.value / total * 100 : 0 }))
      }
    }
  }

  if (state.agent) {
    throw new Error('Agent filtering for this metric is unavailable in the synchronized workbook. Open Agent Productivity or select an available synchronized dimension report.')
  }

  if (config.kind.startsWith('ticket')) {
    const rows = await rowsForRange('daily_ticket_metrics', 'report_date, new_tickets, solved_tickets, unsolved_tickets, one_touch_resolution, reopened_rate', range)
    return ticketModel(config, rows)
  }

  if (config.kind === 'distribution') {
    const rows = await rowsForRange(
      'daily_distribution_metrics',
      'report_date, dimension_type, dimension_key, dimension_label, ticket_count',
      range,
      query => query.eq('dimension_type', config.dimension)
    )
    return distributionModel(config, rows, state[config.dimension])
  }

  const rows = await rowsForRange('ticket_driver_metrics', 'report_date, driver_key, driver_label, ticket_count', range)
  return concernModel(config, rows, state.concern)
}

function formatModelValue(model, value) {
  if (model.format === 'ratio') return formatPercent(value, { ratio: true })
  return formatCount(value)
}

function enhanceSummary(model, previousModel, target) {
  const change = comparison(model.metricValue, previousModel?.metricValue)
  const rows = [...model.summary]
  rows.push(['Previous period', formatModelValue(model, previousModel?.metricValue), 'Matched preceding date range'])
  rows.push(['Absolute change', formatModelValue(model, change.absolute), 'Current minus previous'])
  rows.push(['Percentage change', formatPercent(change.percentage), 'Versus previous period'])
  const targetResult = targetStatus(model.metricValue, target)
  if (targetResult) {
    rows.push([
      target.label || 'Configured target',
      targetResult.met ? 'Met' : 'Not met',
      `${formatModelValue(model, model.metricValue)} vs ${formatModelValue(model, targetResult.goal)}`
    ])
  }
  return rows
}

function setCopy(elements, config, dimension) {
  document.title = `${config.title} | SocialLoop CS Base`
  elements.title.textContent = config.title
  elements.subtitle.textContent = dimension
    ? 'Agent-level cross-filtered ticket volume from the synchronized Google Sheet.'
    : 'Detailed Google Sheet reporting with period comparisons and drill-downs.'
  elements.chartTitle.textContent = dimension ? 'Matched ticket trend' : `${config.title} trend`
  elements.chartSubtitle.textContent = 'Current selected period'
  elements.tableTitle.textContent = dimension ? 'Cross-filtered detail' : `${config.title} data`
  elements.tableSubtitle.textContent = 'Only synchronized Google Sheet values are shown.'
  elements.source.dataset.source = 'google_sheet'
  elements.source.textContent = 'Synchronized Google Sheet'
}

function populateSelect(select, rows, selected) {
  const first = select.options[0]
  select.replaceChildren(first)
  rows.forEach(row => {
    const option = document.createElement('option')
    option.value = row.key
    option.textContent = row.label
    select.appendChild(option)
  })
  if (selected && ![...select.options].some(option => option.value === selected)) {
    const option = document.createElement('option')
    option.value = selected
    option.textContent = selected
    select.appendChild(option)
  }
  select.value = selected || ''
}

function reportFilterOptions(config, state, options, key) {
  if (key === 'agent') {
    if (config.kind === 'agent' || config.kind === 'distribution' || config.kind === 'concern') {
      return options.agent || []
    }
    return []
  }

  const aggregateMatch = !state.agent && (
    (config.kind === 'distribution' && key === config.dimension) ||
    (config.kind === 'concern' && key === 'concern')
  )
  if (aggregateMatch) return options.aggregate?.[key] || []
  return options.cross?.[key] || []
}

function initializeFilters(elements, request, range, options) {
  const { state, config, reportKey } = request
  elements.range.value = state.range
  elements.start.value = state.start
  elements.end.value = state.end
  for (const key of FILTER_KEYS) {
    const select = elements.form.elements[key]
    const rows = reportFilterOptions(config, state, options, key)
    populateSelect(select, rows, state[key])
    const wrapper = select.closest('[data-dimension-filter]')
    if (wrapper) wrapper.hidden = rows.length === 0 && !state[key]
  }

  const toggleDates = () => {
    const custom = elements.range.value === 'custom'
    document.querySelectorAll('[data-custom-date]').forEach(field => { field.hidden = !custom })
    elements.start.required = custom
    elements.end.required = custom
  }
  toggleDates()
  elements.range.addEventListener('change', toggleDates)

  elements.form.addEventListener('submit', event => {
    event.preventDefault()
    const data = new FormData(elements.form)
    const selectedDimensions = DIMENSION_KEYS.filter(key => normalize(data.get(key)))
    if (selectedDimensions.length > 1) {
      elements.validation.textContent = 'Choose only one App, Platform, Country, Concern, Priority, or Channel filter at a time.'
      return
    }
    const params = new URLSearchParams({ report: reportKey, range: String(data.get('range') || config.defaultRange) })
    if (params.get('range') === 'custom') {
      const start = String(data.get('start') || '')
      const end = String(data.get('end') || '')
      if (!start || !end || start > end) {
        elements.validation.textContent = 'Choose a valid custom start and end date.'
        return
      }
      params.set('start', start)
      params.set('end', end)
    }
    for (const key of FILTER_KEYS) {
      const value = normalize(data.get(key))
      if (value) params.set(key, value)
    }
    window.location.assign(`./report-details.html?${params}`)
  })

  elements.reset.addEventListener('click', () => {
    window.location.assign(`./report-details.html?report=${encodeURIComponent(reportKey)}&range=${encodeURIComponent(config.defaultRange)}`)
  })
  elements.rangeSummary.textContent = rangeLabel(range)
}

function renderActiveFilters(elements, state, range, options) {
  elements.activeFilters.replaceChildren()
  const chips = [rangeLabel(range), 'Synchronized Google Sheet']
  for (const key of FILTER_KEYS) {
    if (!state[key]) continue
    const label = options[key]?.find(row => row.key === state[key])?.label || state[key]
    chips.push(`${key}: ${label}`)
  }
  chips.forEach(text => {
    const chip = document.createElement('span')
    chip.textContent = text
    elements.activeFilters.appendChild(chip)
  })
}

function renderSummary(elements, rows) {
  elements.summary.replaceChildren()
  rows.forEach(([label, value, caption]) => {
    const card = document.createElement('article')
    card.className = 'report-summary-card'
    const name = document.createElement('span')
    name.textContent = label
    const strong = document.createElement('strong')
    strong.textContent = value
    const small = document.createElement('small')
    small.textContent = caption || ''
    card.append(name, strong, small)
    elements.summary.appendChild(card)
  })
}

function svg(name, attributes = {}) {
  const node = document.createElementNS(SVG_NS, name)
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)))
  return node
}

function renderLineChart(elements, chart) {
  elements.chart.replaceChildren()
  const rows = chart.rows || []
  if (!rows.length) return renderEmpty(elements.chart, 'No synchronized rows match this date range.')
  const scroll = document.createElement('div')
  scroll.className = 'report-chart-scroll'
  const image = svg('svg', { class: 'report-chart-svg', viewBox: '0 0 900 340', role: 'img', 'aria-label': 'Google Sheet report trend' })
  const left = 62, top = 24, width = 806, height = 250
  const values = rows.flatMap(row => chart.series.map(([key]) => Number(row[key]) || 0))
  const maximum = Math.max(1, ...values)
  for (let tick = 0; tick <= 5; tick += 1) {
    const y = top + tick / 5 * height
    image.appendChild(svg('line', { x1: left, y1: y, x2: left + width, y2: y, class: 'report-chart-grid' }))
    const label = svg('text', { x: left - 10, y: y + 4, 'text-anchor': 'end', class: 'report-chart-label' })
    const value = maximum * (1 - tick / 5)
    label.textContent = chart.percent ? formatPercent(value, { ratio: true }) : formatCount(Math.round(value))
    image.appendChild(label)
  }
  chart.series.forEach(([key, label], seriesIndex) => {
    const points = rows.map((row, index) => ({
      x: rows.length === 1 ? left + width / 2 : left + index / (rows.length - 1) * width,
      y: top + height - ((Number(row[key]) || 0) / maximum) * height,
      value: Number(row[key]) || 0,
      date: row.report_date
    }))
    image.appendChild(svg('path', { d: points.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' '), class: seriesIndex ? 'report-chart-line-secondary' : 'report-chart-line-primary' }))
    points.forEach(point => {
      const circle = svg('circle', { cx: point.x, cy: point.y, r: 3.5, class: seriesIndex ? 'report-chart-point-secondary' : 'report-chart-point-primary' })
      const title = svg('title')
      title.textContent = `${formatDate(point.date)} — ${label}: ${chart.percent ? formatPercent(point.value, { ratio: true }) : formatCount(point.value)}`
      circle.appendChild(title)
      image.appendChild(circle)
    })
  })
  scroll.appendChild(image)
  elements.chart.appendChild(scroll)
}

function drilldownUrl(row, request) {
  const params = new URLSearchParams({ range: request.state.range })
  if (request.state.range === 'custom') {
    params.set('start', request.state.start)
    params.set('end', request.state.end)
  }
  for (const key of DIMENSION_KEYS) if (request.state[key]) params.set(key, request.state[key])
  if (row.drilldown === 'agent') {
    params.set('agent', row.key)
    return `./agent-analytics.html?${params}`
  }
  params.set(request.config.dimension || 'concern', row.key)
  params.set('report', request.reportKey)
  return `./report-details.html?${params}`
}

function renderBars(container, rows, request, interactive = false) {
  container.replaceChildren()
  if (!rows.length) return renderEmpty(container, 'No synchronized categories match this selection.')
  const maximum = Math.max(1, ...rows.map(row => Number(row.value) || 0))
  rows.forEach(row => {
    const item = interactive ? document.createElement('a') : document.createElement('div')
    item.className = 'report-breakdown-row'
    if (interactive) {
      item.href = drilldownUrl(row, request)
      item.classList.add('report-breakdown-link')
    }
    const label = document.createElement('span')
    label.className = 'report-breakdown-label'
    label.textContent = row.label || row.key
    const track = document.createElement('span')
    track.className = 'report-breakdown-track'
    const bar = document.createElement('span')
    bar.className = 'report-breakdown-bar'
    bar.style.width = `${Math.min(100, (Number(row.value) || 0) / maximum * 100)}%`
    track.appendChild(bar)
    const value = document.createElement('strong')
    value.className = 'report-breakdown-value'
    value.textContent = formatCount(row.value)
    item.append(label, track, value)
    container.appendChild(item)
  })
}

function renderEmpty(container, message) {
  container.replaceChildren()
  const empty = document.createElement('div')
  empty.className = 'report-chart-empty'
  empty.textContent = message
  container.appendChild(empty)
}

function renderChart(elements, chart, request) {
  if (chart.type === 'line') return renderLineChart(elements, chart)
  if (chart.type === 'bar') return renderBars(elements.chart, chart.rows || [], request, true)
  renderEmpty(elements.chart, chart.message || 'No chart is available.')
}

function renderBreakdown(elements, rows, request) {
  elements.breakdownSection.hidden = !rows.length
  if (!rows.length) return
  elements.breakdownTitle.textContent = rows.some(row => row.drilldown === 'agent') ? 'Agent drill-down' : 'Category drill-down'
  elements.breakdownSubtitle.textContent = 'Select a row to continue to the next reporting level.'
  renderBars(elements.breakdown, rows, request, true)
}

function formatCell(value, type) {
  if (type === 'date') return formatDate(value)
  if (type === 'count') return formatCount(value)
  if (type === 'percent') return formatPercent(value)
  if (type === 'ratio') return formatPercent(value, { ratio: true })
  if (type === 'minutes') return formatMinutes(value)
  if (type === 'aht') return formatAht(value)
  return value === null || value === undefined || value === '' ? 'Unavailable' : String(value)
}

function renderTable(elements, table) {
  elements.tableHead.replaceChildren()
  elements.tableBody.replaceChildren()
  const header = document.createElement('tr')
  table.columns.forEach(([, label]) => {
    const th = document.createElement('th')
    th.scope = 'col'
    th.textContent = label
    header.appendChild(th)
  })
  elements.tableHead.appendChild(header)
  table.rows.forEach(row => {
    const tr = document.createElement('tr')
    table.columns.forEach(([key, , type]) => {
      const td = document.createElement('td')
      td.textContent = formatCell(row[key], type)
      tr.appendChild(td)
    })
    elements.tableBody.appendChild(tr)
  })
  elements.tableMeta.textContent = `${formatCount(table.rows.length)} record${table.rows.length === 1 ? '' : 's'}`
  elements.tableCaption.textContent = table.rows.length ? 'Synchronized Google Sheet records for the selected filters.' : 'No synchronized records match the selected filters.'
}

function showError(elements, error) {
  elements.page.setAttribute('aria-busy', 'false')
  elements.content.hidden = true
  elements.status.hidden = false
  elements.status.replaceChildren()
  const heading = document.createElement('h2')
  heading.textContent = 'Report unavailable'
  const paragraph = document.createElement('p')
  paragraph.textContent = error?.message || 'The report could not be loaded.'
  elements.status.append(heading, paragraph)
}

async function initialize() {
  const elements = ui()
  elements.logout.addEventListener('click', event => { event.preventDefault(); logout() })
  try {
    const request = parseRequest()
    const user = await requireApprovedUser()
    if (!user) return
    const anchorDate = await latestDate(request.config.table, request.config.kind === 'distribution' ? { column: 'dimension_type', value: request.config.dimension } : null)
    const range = resolveRange(request.state, anchorDate)
    const priorRange = previousRange(range)
    const dimension = selectedDimension(request.state)
    setCopy(elements, request.config, dimension)

    const [options, model, priorModel, targets] = await Promise.all([
      loadFilterOptions(range),
      loadBaseModel(request.config, request.state, range),
      loadBaseModel(request.config, request.state, priorRange).catch(() => ({ metricValue: null })),
      loadTargets([request.config.metricKey, dimension ? `${dimension.key}_ticket_count` : request.config.metricKey])
    ])
    const target = targets.get(model.metricKey) || targets.get(request.config.metricKey)
    initializeFilters(elements, request, range, options)
    renderActiveFilters(elements, request.state, range, options)
    renderSummary(elements, enhanceSummary(model, priorModel, target))
    renderChart(elements, model.chart, request)
    renderBreakdown(elements, model.breakdown, request)
    renderTable(elements, model.table)
    elements.dataBadge.textContent = `Current: ${rangeLabel(range)} · Previous: ${rangeLabel(priorRange)}`
    elements.status.hidden = true
    elements.content.hidden = false
    elements.page.setAttribute('aria-busy', 'false')
  } catch (error) {
    console.error('Unable to initialize Google Sheet report:', error)
    showError(elements, error)
  }
}

initialize()
