import {
  DIMENSION_KEYS,
  comparison,
  formatAht,
  formatCount,
  formatDate,
  formatPercent,
  latestDate,
  loadAgentDimensionRows,
  loadAllAgentDimensions,
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
  targetStatus
} from './sheet-reporting.js?v=1'

const SVG_NS = 'http://www.w3.org/2000/svg'

function elements() {
  return {
    page: document.getElementById('agentAnalyticsPage'), status: document.getElementById('agentAnalyticsStatus'), content: document.getElementById('agentAnalyticsContent'),
    logout: document.getElementById('agentAnalyticsLogoutLink'), form: document.getElementById('agentAnalyticsFilterForm'), range: document.getElementById('agentAnalyticsRange'),
    start: document.getElementById('agentAnalyticsStartDate'), end: document.getElementById('agentAnalyticsEndDate'), agent: document.getElementById('agentAnalyticsAgent'),
    reset: document.getElementById('agentAnalyticsResetFilters'), validation: document.getElementById('agentAnalyticsFilterValidation'), rangeSummary: document.getElementById('agentRangeSummary'),
    activeFilters: document.getElementById('agentAnalyticsActiveFilters'), summary: document.getElementById('agentAnalyticsSummary'), badge: document.getElementById('agentAnalyticsDataBadge'),
    trendTitle: document.getElementById('agentTrendTitle'), trendSubtitle: document.getElementById('agentTrendSubtitle'), chart: document.getElementById('agentAnalyticsTrendChart'),
    rankingTitle: document.getElementById('agentRankingTitle'), rankingSubtitle: document.getElementById('agentRankingSubtitle'), ranking: document.getElementById('agentAnalyticsRanking'),
    dimensionSection: document.getElementById('agentDimensionSection'), dimensionBreakdown: document.getElementById('agentDimensionBreakdown'), tableMeta: document.getElementById('agentAnalyticsTableMeta'),
    tableCaption: document.getElementById('agentAnalyticsTableCaption'), tableHead: document.getElementById('agentAnalyticsTableHead'), tableBody: document.getElementById('agentAnalyticsTableBody')
  }
}

function parseState() {
  const params = new URLSearchParams(window.location.search)
  return {
    ...parseRange(params, '30d'),
    agent: normalize(params.get('agent')),
    app: normalize(params.get('app')),
    platform: normalize(params.get('platform')),
    country: normalize(params.get('country')),
    concern: normalize(params.get('concern') || params.get('driver')),
    priority: normalize(params.get('priority')),
    channel: normalize(params.get('channel'))
  }
}

function sum(rows, key) { return rows.reduce((total, row) => total + (Number(row[key]) || 0), 0) }

function aggregateProductivity(rows) {
  const groups = new Map()
  rows.forEach(row => {
    const key = normalize(row.agent_key)
    if (!key) return
    const item = groups.get(key) || { agent_key: key, agent_name: row.agent_name || key, solved_tickets: 0, open_values: [], latest_open: null, latest_date: '', aht_weighted: 0, aht_solved: 0, aht_values: [] }
    const solved = Number(row.solved_tickets) || 0
    const open = Number(row.open_tickets)
    const aht = Number(row.aht_value)
    item.solved_tickets += solved
    if (Number.isFinite(open)) {
      item.open_values.push(open)
      if (row.report_date >= item.latest_date) { item.latest_date = row.report_date; item.latest_open = open }
    }
    if (Number.isFinite(aht)) {
      item.aht_values.push(aht)
      if (solved > 0) { item.aht_weighted += aht * solved; item.aht_solved += solved }
    }
    groups.set(key, item)
  })
  const agents = [...groups.values()].map(item => ({
    agent_key: item.agent_key,
    agent_name: item.agent_name,
    solved_tickets: item.solved_tickets,
    latest_open_tickets: item.latest_open,
    avg_open_tickets: item.open_values.length ? item.open_values.reduce((a, b) => a + b, 0) / item.open_values.length : null,
    avg_aht_minutes: item.aht_solved ? item.aht_weighted / item.aht_solved : item.aht_values.length ? item.aht_values.reduce((a, b) => a + b, 0) / item.aht_values.length : null
  }))
  const teamSolved = sum(agents, 'solved_tickets')
  const teamOpen = sum(agents, 'avg_open_tickets')
  agents.forEach(agent => {
    agent.team_output_share = teamSolved ? agent.solved_tickets / teamSolved : null
    agent.workload_share = teamOpen ? agent.avg_open_tickets / teamOpen : null
    agent.workload_adjusted_index = agent.team_output_share !== null && agent.workload_share > 0 ? agent.team_output_share / agent.workload_share * 100 : null
  })
  return agents.sort((a, b) => b.solved_tickets - a.solved_tickets || a.agent_name.localeCompare(b.agent_name))
}

function productivityModel(rows) {
  const agents = aggregateProductivity(rows)
  const dailyMap = new Map()
  rows.forEach(row => {
    const item = dailyMap.get(row.report_date) || { report_date: row.report_date, solved_tickets: 0, open_tickets: 0 }
    item.solved_tickets += Number(row.solved_tickets) || 0
    item.open_tickets += Number(row.open_tickets) || 0
    dailyMap.set(row.report_date, item)
  })
  const trend = [...dailyMap.values()].sort((a, b) => a.report_date.localeCompare(b.report_date))
  return { mode: 'productivity', metricKey: 'agent_solved_tickets', metricValue: sum(agents, 'solved_tickets'), agents, trend }
}

function dimensionModel(rows, dimension) {
  const agentMap = new Map()
  const dateMap = new Map()
  rows.forEach(row => {
    const agent = agentMap.get(row.agent_key) || { agent_key: row.agent_key, agent_name: row.agent_name || row.agent_key, ticket_count: 0 }
    agent.ticket_count += Number(row.ticket_count) || 0
    agentMap.set(row.agent_key, agent)
    dateMap.set(row.report_date, (dateMap.get(row.report_date) || 0) + (Number(row.ticket_count) || 0))
  })
  const agents = [...agentMap.values()].sort((a, b) => b.ticket_count - a.ticket_count || a.agent_name.localeCompare(b.agent_name))
  const total = sum(agents, 'ticket_count')
  agents.forEach(agent => { agent.team_share = total ? agent.ticket_count / total : null })
  return {
    mode: 'dimension', metricKey: `${dimension.key}_ticket_count`, metricValue: total, agents,
    trend: [...dateMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([report_date, ticket_count]) => ({ report_date, ticket_count })),
    label: rows[0]?.dimension_label || dimension.value
  }
}

async function loadModel(state, range) {
  const dimension = selectedDimension(state)
  if (dimension) {
    const rows = await loadAgentDimensionRows(range, dimension, state.agent)
    if (!rows.length) throw new Error('No synchronized agent_dimension_metrics rows match this cross-filter.')
    return dimensionModel(rows, dimension)
  }
  const rows = await rowsForRange('agent_productivity', 'report_date, agent_key, agent_name, solved_tickets, open_tickets, aht_value', range, query => state.agent ? query.eq('agent_key', state.agent) : query)
  return productivityModel(rows)
}

function populateSelect(select, rows, selected) {
  const first = select.options[0]
  select.replaceChildren(first)
  rows.forEach(row => { const option = document.createElement('option'); option.value = row.key; option.textContent = row.label; select.appendChild(option) })
  if (selected && ![...select.options].some(option => option.value === selected)) { const option = document.createElement('option'); option.value = selected; option.textContent = selected; select.appendChild(option) }
  select.value = selected || ''
}

function initializeForm(ui, state, range, options) {
  ui.range.value = state.range
  ui.start.value = state.start
  ui.end.value = state.end
  populateSelect(ui.agent, options.agent || [], state.agent)
  DIMENSION_KEYS.forEach(key => {
    const select = ui.form.elements[key]
    const rows = options.cross?.[key] || []
    populateSelect(select, rows, state[key])
    select.closest('[data-dimension-filter]').hidden = rows.length === 0 && !state[key]
  })
  const toggleCustom = () => {
    const custom = ui.range.value === 'custom'
    document.querySelectorAll('[data-custom-date]').forEach(field => { field.hidden = !custom })
    ui.start.required = custom; ui.end.required = custom
  }
  toggleCustom(); ui.range.addEventListener('change', toggleCustom)
  ui.reset.addEventListener('click', () => window.location.assign('./agent-analytics.html'))
  ui.form.addEventListener('submit', event => {
    event.preventDefault()
    const data = new FormData(ui.form)
    const active = DIMENSION_KEYS.filter(key => normalize(data.get(key)))
    if (active.length > 1) { ui.validation.textContent = 'Choose only one dimension filter at a time.'; return }
    const params = new URLSearchParams({ range: String(data.get('range') || '30d') })
    if (params.get('range') === 'custom') {
      const start = String(data.get('start') || ''), end = String(data.get('end') || '')
      if (!start || !end || start > end) { ui.validation.textContent = 'Choose a valid custom date range.'; return }
      params.set('start', start); params.set('end', end)
    }
    const agent = normalize(data.get('agent')); if (agent) params.set('agent', agent)
    DIMENSION_KEYS.forEach(key => { const value = normalize(data.get(key)); if (value) params.set(key, value) })
    window.location.assign(`./agent-analytics.html?${params}`)
  })
  ui.rangeSummary.textContent = rangeLabel(range)
}

function renderActiveFilters(ui, state, range, options) {
  ui.activeFilters.replaceChildren()
  const chips = [rangeLabel(range), 'Synchronized Google Sheet']
  if (state.agent) chips.push(`agent: ${options.agent?.find(row => row.key === state.agent)?.label || state.agent}`)
  DIMENSION_KEYS.forEach(key => { if (state[key]) chips.push(`${key}: ${options[key]?.find(row => row.key === state[key])?.label || state[key]}`) })
  chips.forEach(text => { const chip = document.createElement('span'); chip.textContent = text; ui.activeFilters.appendChild(chip) })
}

function renderSummary(ui, model, prior, target) {
  ui.summary.replaceChildren()
  const change = comparison(model.metricValue, prior.metricValue)
  const cards = model.mode === 'dimension'
    ? [['Matched tickets', formatCount(model.metricValue), model.label], ['Agents represented', formatCount(model.agents.length), 'Cross-filtered rows']]
    : [['Solved tickets', formatCount(model.metricValue), 'Selected period'], ['Latest open', formatCount(sum(model.agents, 'latest_open_tickets')), 'Latest synchronized snapshot'], ['Average AHT', formatAht(weightedAht(model.agents)), 'Solved-weighted where possible'], ['Agents', formatCount(model.agents.length), 'Matching selection']]
  cards.push(['Previous period', formatCount(prior.metricValue), 'Matched preceding date range'])
  cards.push(['Absolute change', formatCount(change.absolute), 'Current minus previous'])
  cards.push(['Percentage change', formatPercent(change.percentage), 'Versus previous period'])
  const status = targetStatus(model.metricValue, target)
  if (status) cards.push([target.label || 'Configured target', status.met ? 'Met' : 'Not met', `${formatCount(model.metricValue)} vs ${formatCount(status.goal)}`])
  cards.forEach(([label, value, caption]) => {
    const card = document.createElement('article'); card.className = 'agent-summary-card'
    const heading = document.createElement('h2'); heading.textContent = label
    const strong = document.createElement('strong'); strong.textContent = value
    const p = document.createElement('p'); p.textContent = caption
    card.append(heading, strong, p); ui.summary.appendChild(card)
  })
}

function weightedAht(agents) {
  const rows = agents.filter(row => Number.isFinite(Number(row.avg_aht_minutes)))
  const solved = sum(rows, 'solved_tickets')
  return solved ? rows.reduce((total, row) => total + Number(row.avg_aht_minutes) * (Number(row.solved_tickets) || 0), 0) / solved : rows.length ? rows.reduce((total, row) => total + Number(row.avg_aht_minutes), 0) / rows.length : null
}

function svg(name, attributes = {}) { const node = document.createElementNS(SVG_NS, name); Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value))); return node }

function renderChart(ui, model) {
  ui.chart.replaceChildren()
  if (!model.trend.length) { ui.chart.textContent = 'No synchronized daily rows match this selection.'; return }
  const scroll = document.createElement('div'); scroll.className = 'agent-chart-scroll'
  const image = svg('svg', { class: 'agent-chart-svg', viewBox: '0 0 900 340', role: 'img', 'aria-label': 'Agent analytics trend' })
  const left = 62, top = 24, width = 806, height = 250
  const series = model.mode === 'dimension' ? [['ticket_count', 'Matched tickets']] : [['solved_tickets', 'Solved'], ['open_tickets', 'Open']]
  const maximum = Math.max(1, ...model.trend.flatMap(row => series.map(([key]) => Number(row[key]) || 0)))
  series.forEach(([key, label], seriesIndex) => {
    const points = model.trend.map((row, index) => ({ x: model.trend.length === 1 ? left + width / 2 : left + index / (model.trend.length - 1) * width, y: top + height - (Number(row[key]) || 0) / maximum * height, value: Number(row[key]) || 0, date: row.report_date }))
    image.appendChild(svg('path', { d: points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' '), class: seriesIndex ? 'agent-chart-line-open' : 'agent-chart-line-solved' }))
    points.forEach(point => { const circle = svg('circle', { cx: point.x, cy: point.y, r: 3.5, class: seriesIndex ? 'agent-chart-point-open' : 'agent-chart-point-solved' }); const title = svg('title'); title.textContent = `${formatDate(point.date)} — ${label}: ${formatCount(point.value)}`; circle.appendChild(title); image.appendChild(circle) })
  })
  scroll.appendChild(image); ui.chart.appendChild(scroll)
}

function stateParams(state) {
  const params = new URLSearchParams({ range: state.range })
  if (state.range === 'custom') { params.set('start', state.start); params.set('end', state.end) }
  DIMENSION_KEYS.forEach(key => { if (state[key]) params.set(key, state[key]) })
  return params
}

function renderRanking(ui, model, state) {
  ui.ranking.replaceChildren()
  const maximum = Math.max(1, ...model.agents.map(row => Number(model.mode === 'dimension' ? row.ticket_count : row.solved_tickets) || 0))
  model.agents.forEach(row => {
    const params = stateParams(state); params.set('agent', row.agent_key)
    const link = document.createElement('a'); link.className = 'agent-ranking-row'; link.href = `./agent-analytics.html?${params}`
    const name = document.createElement('span'); name.className = 'agent-ranking-name'; name.textContent = row.agent_name
    const track = document.createElement('span'); track.className = 'agent-ranking-track'
    const bar = document.createElement('span'); bar.className = 'agent-ranking-bar'; const value = Number(model.mode === 'dimension' ? row.ticket_count : row.solved_tickets) || 0; bar.style.width = `${value / maximum * 100}%`; track.appendChild(bar)
    const strong = document.createElement('strong'); strong.className = 'agent-ranking-value'; strong.textContent = formatCount(value)
    link.append(name, track, strong); ui.ranking.appendChild(link)
  })
}

function renderDimensions(ui, rows, state) {
  ui.dimensionBreakdown.replaceChildren()
  const groups = new Map()
  rows.forEach(row => {
    const key = `${row.dimension_type}:${row.dimension_key}`
    const item = groups.get(key) || { type: row.dimension_type, key: row.dimension_key, label: row.dimension_label || row.dimension_key, value: 0 }
    item.value += Number(row.ticket_count) || 0; groups.set(key, item)
  })
  const items = [...groups.values()].sort((a, b) => a.type.localeCompare(b.type) || b.value - a.value)
  ui.dimensionSection.hidden = items.length === 0
  items.forEach(item => {
    const params = stateParams({ ...state, ...Object.fromEntries(DIMENSION_KEYS.map(key => [key, ''])) })
    if (state.agent) params.set('agent', state.agent)
    params.set(item.type, item.key)
    const link = document.createElement('a'); link.className = 'agent-ranking-row'; link.href = `./agent-analytics.html?${params}`
    const label = document.createElement('span'); label.className = 'agent-ranking-name'; label.textContent = `${item.type}: ${item.label}`
    const spacer = document.createElement('span'); spacer.className = 'agent-ranking-track'
    const strong = document.createElement('strong'); strong.className = 'agent-ranking-value'; strong.textContent = formatCount(item.value)
    link.append(label, spacer, strong); ui.dimensionBreakdown.appendChild(link)
  })
}

function renderTable(ui, model) {
  ui.tableHead.replaceChildren(); ui.tableBody.replaceChildren()
  const columns = model.mode === 'dimension'
    ? [['agent_name', 'Agent', 'text'], ['ticket_count', 'Matched Tickets', 'count'], ['team_share', 'Team Share', 'percent']]
    : [['agent_name', 'Agent', 'text'], ['solved_tickets', 'Solved', 'count'], ['latest_open_tickets', 'Latest Open', 'count'], ['avg_open_tickets', 'Avg Open', 'count'], ['avg_aht_minutes', 'AHT', 'aht'], ['team_output_share', 'Team Share', 'percent'], ['workload_adjusted_index', 'Workload Index', 'count']]
  const header = document.createElement('tr'); columns.forEach(([, label]) => { const th = document.createElement('th'); th.scope = 'col'; th.textContent = label; header.appendChild(th) }); ui.tableHead.appendChild(header)
  model.agents.forEach(row => { const tr = document.createElement('tr'); columns.forEach(([key, , type]) => { const td = document.createElement('td'); const value = row[key]; td.textContent = type === 'count' ? formatCount(value) : type === 'percent' ? formatPercent(value, { ratio: true }) : type === 'aht' ? formatAht(value) : value || 'Unavailable'; tr.appendChild(td) }); ui.tableBody.appendChild(tr) })
  ui.tableMeta.textContent = `${formatCount(model.agents.length)} agent${model.agents.length === 1 ? '' : 's'}`
  ui.tableCaption.textContent = model.agents.length ? 'Agent rows for the selected synchronized reporting range.' : 'No agent rows match this selection.'
}

function showError(ui, error) {
  ui.page.setAttribute('aria-busy', 'false'); ui.content.hidden = true; ui.status.hidden = false; ui.status.replaceChildren()
  const h = document.createElement('h2'); h.textContent = 'Agent analytics unavailable'
  const p = document.createElement('p'); p.textContent = error?.message || 'The page could not be loaded.'
  ui.status.append(h, p)
}

async function initialize() {
  const ui = elements(); ui.logout.addEventListener('click', event => { event.preventDefault(); logout() })
  try {
    const state = parseState(); const user = await requireApprovedUser(); if (!user) return
    const anchor = await latestDate('agent_productivity'); const range = resolveRange(state, anchor); const priorRange = previousRange(range); const dimension = selectedDimension(state)
    const [options, model, prior, dimensions, targets] = await Promise.all([
      loadFilterOptions(range), loadModel(state, range), loadModel(state, priorRange).catch(() => ({ metricValue: null })), loadAllAgentDimensions(range, state.agent), loadTargets([dimension ? `${dimension.key}_ticket_count` : 'agent_solved_tickets'])
    ])
    initializeForm(ui, state, range, options); renderActiveFilters(ui, state, range, options)
    renderSummary(ui, model, prior, targets.get(model.metricKey)); renderChart(ui, model); renderRanking(ui, model, state); renderDimensions(ui, dimensions, state); renderTable(ui, model)
    ui.trendTitle.textContent = model.mode === 'dimension' ? `Matched ${dimension.key} ticket trend` : 'Solved output and open workload'
    ui.trendSubtitle.textContent = `Current: ${rangeLabel(range)} · Previous: ${rangeLabel(priorRange)}`
    ui.rankingTitle.textContent = model.mode === 'dimension' ? 'Matched ticket ranking' : 'Workload-adjusted ranking'
    ui.badge.textContent = 'Synchronized Google Sheet'
    ui.status.hidden = true; ui.content.hidden = false; ui.page.setAttribute('aria-busy', 'false')
  } catch (error) { console.error('Unable to initialize agent analytics:', error); showError(ui, error) }
}

initialize()
