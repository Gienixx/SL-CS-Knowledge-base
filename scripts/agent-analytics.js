import { supabase } from './supabaseClient.js?v=8'
import {
  requiresFirstLoginPasswordChange
} from './first-login-policy.js?v=4'

const REPORT_TIME_ZONE = 'America/New_York'
const SVG_NS = 'http://www.w3.org/2000/svg'

function elements() {
  return {
    page: document.getElementById('agentAnalyticsPage'),
    status: document.getElementById('agentAnalyticsStatus'),
    content: document.getElementById('agentAnalyticsContent'),
    logout: document.getElementById('agentAnalyticsLogoutLink'),
    form: document.getElementById('agentAnalyticsFilterForm'),
    range: document.getElementById('agentAnalyticsRange'),
    start: document.getElementById('agentAnalyticsStartDate'),
    end: document.getElementById('agentAnalyticsEndDate'),
    agent: document.getElementById('agentAnalyticsAgent'),
    reset: document.getElementById('agentAnalyticsResetFilters'),
    validation: document.getElementById('agentAnalyticsFilterValidation'),
    rangeSummary: document.getElementById('agentRangeSummary'),
    activeFilters: document.getElementById('agentAnalyticsActiveFilters'),
    readiness: document.getElementById('agentMappingReadiness'),
    readinessTitle: document.getElementById('agentMappingReadinessTitle'),
    readinessText: document.getElementById('agentMappingReadinessText'),
    summary: document.getElementById('agentAnalyticsSummary'),
    badge: document.getElementById('agentAnalyticsDataBadge'),
    trendTitle: document.getElementById('agentTrendTitle'),
    trendSubtitle: document.getElementById('agentTrendSubtitle'),
    chart: document.getElementById('agentAnalyticsTrendChart'),
    ranking: document.getElementById('agentAnalyticsRanking'),
    tableMeta: document.getElementById('agentAnalyticsTableMeta'),
    tableCaption: document.getElementById('agentAnalyticsTableCaption'),
    tableBody: document.getElementById('agentAnalyticsTableBody')
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

function formatCount(value) {
  if (value === null || value === undefined || value === '') return 'Unavailable'
  const number = Number(value)
  return Number.isFinite(number)
    ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(number)
    : 'Unavailable'
}

function formatAht(value) {
  if (value === null || value === undefined || value === '') return 'Unavailable'
  const minutes = Number(value)
  if (!Number.isFinite(minutes) || minutes < 0) return 'Unavailable'
  const totalSeconds = Math.round(minutes * 60)
  const wholeMinutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${wholeMinutes}:${String(seconds).padStart(2, '0')}`
}

function formatDuration(value) {
  if (value === null || value === undefined || value === '') return 'Unavailable'
  const minutes = Number(value)
  if (!Number.isFinite(minutes) || minutes < 0) return 'Unavailable'
  if (minutes < 60) {
    return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(minutes)} min`
  }
  const hours = minutes / 60
  if (hours < 24) {
    return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(hours)} hr`
  }
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(hours / 24)} days`
}

function formatPercent(value) {
  if (value === null || value === undefined || value === '') return 'Unavailable'
  const ratio = Number(value)
  return Number.isFinite(ratio)
    ? new Intl.NumberFormat('en-US', {
        style: 'percent',
        minimumFractionDigits: 1,
        maximumFractionDigits: 1
      }).format(ratio)
    : 'Unavailable'
}

function formatIndex(value) {
  if (value === null || value === undefined || value === '') return 'Unavailable'
  const number = Number(value)
  return Number.isFinite(number)
    ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(number)
    : 'Unavailable'
}

function parseRequest() {
  const params = new URLSearchParams(window.location.search)
  const allowedRanges = new Set(['7d', '30d', '90d', 'mtd', 'custom'])
  return {
    range: allowedRanges.has(params.get('range')) ? params.get('range') : '30d',
    start: isIsoDate(params.get('start')) ? params.get('start') : '',
    end: isIsoDate(params.get('end')) ? params.get('end') : '',
    agent: normalize(params.get('agent'))
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

async function loadDashboard(state, range) {
  const { data, error } = await supabase.rpc(
    'get_agent_analytics_dashboard',
    {
      p_start_date: range.startDate,
      p_end_date: range.endDate,
      p_agent_key: state.agent || null,
      p_time_zone: REPORT_TIME_ZONE
    }
  )

  if (error) throw error
  return data || {}
}

function initializeForm(ui, state) {
  ui.range.value = state.range
  ui.start.value = state.start
  ui.end.value = state.end

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
    window.location.assign('./agent-analytics.html')
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

    const agent = normalize(ui.agent.value)
    if (agent) url.searchParams.set('agent', agent)
    else url.searchParams.delete('agent')
    window.location.assign(url.toString())
  })
}

function populateAgents(ui, state, options) {
  const first = ui.agent.options[0]
  ui.agent.replaceChildren(first)
  const agents = Array.isArray(options?.agents) ? options.agents : []

  agents.forEach(row => {
    const option = document.createElement('option')
    option.value = row.key
    option.textContent = row.mapped === false
      ? `${row.label || row.key} — mapping required`
      : row.label || row.key
    ui.agent.appendChild(option)
  })

  ui.agent.value = state.agent
  if (state.agent && ui.agent.value !== state.agent) {
    const option = document.createElement('option')
    option.value = state.agent
    option.textContent = state.agent
    ui.agent.appendChild(option)
    ui.agent.value = state.agent
  }
}

function selectedAgentLabel(ui, state) {
  if (!state.agent) return 'All agents'
  return ui.agent.selectedOptions?.[0]?.textContent?.replace(' — mapping required', '') || state.agent
}

function renderActiveFilters(ui, state, range) {
  ui.activeFilters.replaceChildren()
  const chips = [rangeLabel(range), 'Ticket Productivity + Zendesk events']
  if (state.agent) chips.push(`Agent: ${selectedAgentLabel(ui, state)}`)

  chips.forEach(text => {
    const chip = document.createElement('span')
    chip.textContent = text
    ui.activeFilters.appendChild(chip)
  })
}

function renderReadiness(ui, readiness) {
  const unmapped = Array.isArray(readiness?.unmappedAgents)
    ? readiness.unmappedAgents
    : []
  const mapped = Number(readiness?.mappedAgents) || 0
  const ready = unmapped.length === 0 && mapped > 0
  ui.readiness.dataset.ready = String(ready)

  if (ready) {
    ui.readinessTitle.textContent = 'Zendesk agent mapping ready'
    ui.readinessText.textContent = `${formatCount(mapped)} mapped agent${mapped === 1 ? '' : 's'} can use response, resolution, and reopen analytics.`
    return
  }

  if (unmapped.length > 0) {
    ui.readinessTitle.textContent = 'Manual agent mapping required'
    ui.readinessText.textContent = `${unmapped.map(row => row.label || row.key).join(', ')} must be mapped in Supabase before Zendesk event metrics can be attributed.`
    return
  }

  ui.readinessTitle.textContent = 'No mapped agents in this selection'
  ui.readinessText.textContent = 'Productivity metrics remain available, but Zendesk response, resolution, and reopen values cannot be attributed yet.'
}

function summaryCards(summary, state, selectedLabel) {
  const scopeLabel = state.agent ? selectedLabel : 'Team'
  const teamSolved = Number(summary?.team_solved_tickets)
  const scopeSolved = Number(summary?.scope_solved_tickets)
  const teamShare = Number.isFinite(teamSolved) && teamSolved > 0 && Number.isFinite(scopeSolved)
    ? scopeSolved / teamSolved
    : null

  return [
    [`${scopeLabel} solved`, formatCount(summary?.scope_solved_tickets), state.agent ? `${formatPercent(teamShare)} of team output` : 'Selected-period total'],
    [`${scopeLabel} latest open`, formatCount(summary?.scope_latest_open_tickets), state.agent ? `${formatCount(summary?.team_latest_open_tickets)} open across team` : 'Latest synchronized snapshot'],
    ['Average AHT', formatAht(summary?.avg_aht_minutes), 'Solved-volume weighted where available'],
    ['Median AHT', formatAht(summary?.median_aht_minutes), 'Median daily AHT'],
    ['Average first response', formatDuration(summary?.avg_first_response_minutes), 'Mapped Zendesk tickets'],
    ['Average resolution', formatDuration(summary?.avg_resolution_minutes), 'Creation to latest period resolution'],
    ['Reopen rate', formatPercent(summary?.reopen_rate), 'Resolved tickets reopened before range end'],
    ['Team one-touch resolution', formatPercent(summary?.team_one_touch_resolution_rate), 'Team-level daily sheet metric']
  ]
}

function renderSummary(ui, summary, state) {
  ui.summary.replaceChildren()
  summaryCards(summary, state, selectedAgentLabel(ui, state)).forEach(
    ([label, value, caption]) => {
      const card = document.createElement('article')
      card.className = 'detail-summary-card agent-summary-card'
      const heading = document.createElement('h2')
      heading.textContent = label
      const metric = document.createElement('strong')
      metric.textContent = value
      const detail = document.createElement('p')
      detail.textContent = caption
      card.append(heading, metric, detail)
      ui.summary.appendChild(card)
    }
  )
}

function svgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name)
  Object.entries(attributes).forEach(([key, value]) => {
    element.setAttribute(key, String(value))
  })
  return element
}

function renderEmpty(container, message) {
  container.replaceChildren()
  const empty = document.createElement('div')
  empty.className = 'agent-empty-state'
  empty.textContent = message
  container.appendChild(empty)
}

function renderTrend(ui, rows, state) {
  ui.chart.replaceChildren()
  const data = Array.isArray(rows) ? rows : []
  const label = selectedAgentLabel(ui, state)
  ui.trendTitle.textContent = state.agent
    ? `${label} solved output and open workload`
    : 'Team solved output and open workload'
  ui.trendSubtitle.textContent = 'Daily synchronized Ticket Productivity values'

  if (data.length === 0) {
    renderEmpty(ui.chart, 'No productivity records match the selected date range.')
    return
  }

  const scroll = document.createElement('div')
  scroll.className = 'agent-chart-scroll'
  const svg = svgElement('svg', {
    class: 'agent-chart-svg',
    viewBox: '0 0 980 350',
    role: 'img',
    'aria-label': 'Daily solved ticket and open workload trend'
  })
  const dimensions = { left: 64, top: 24, width: 880, height: 250 }
  const values = data.flatMap(row => [
    Number(row.solved_tickets) || 0,
    Number(row.open_tickets) || 0
  ])
  const maximum = Math.max(1, ...values)
  const niceMaximum = Math.ceil(maximum / 5) * 5 || 1

  for (let tick = 0; tick <= 5; tick += 1) {
    const ratio = tick / 5
    const y = dimensions.top + ratio * dimensions.height
    const value = niceMaximum * (1 - ratio)
    svg.appendChild(svgElement('line', {
      x1: dimensions.left,
      y1: y,
      x2: dimensions.left + dimensions.width,
      y2: y,
      class: 'agent-chart-grid'
    }))
    const text = svgElement('text', {
      x: dimensions.left - 10,
      y: y + 4,
      'text-anchor': 'end',
      class: 'agent-chart-label'
    })
    text.textContent = formatCount(Math.round(value))
    svg.appendChild(text)
  }

  svg.appendChild(svgElement('line', {
    x1: dimensions.left,
    y1: dimensions.top,
    x2: dimensions.left,
    y2: dimensions.top + dimensions.height,
    class: 'agent-chart-axis'
  }))
  svg.appendChild(svgElement('line', {
    x1: dimensions.left,
    y1: dimensions.top + dimensions.height,
    x2: dimensions.left + dimensions.width,
    y2: dimensions.top + dimensions.height,
    class: 'agent-chart-axis'
  }))

  ;[
    { key: 'solved_tickets', label: 'Solved', className: 'solved' },
    { key: 'open_tickets', label: 'Open', className: 'open' }
  ].forEach(series => {
    const points = data.map((row, index) => {
      const x = data.length === 1
        ? dimensions.left + dimensions.width / 2
        : dimensions.left + (index / (data.length - 1)) * dimensions.width
      const value = Number(row[series.key]) || 0
      const y = dimensions.top + dimensions.height -
        (value / niceMaximum) * dimensions.height
      return { x, y, value, row }
    })
    const path = points.map((point, index) =>
      `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`
    ).join(' ')
    svg.appendChild(svgElement('path', {
      d: path,
      class: `agent-chart-line-${series.className}`
    }))

    points.forEach(point => {
      const circle = svgElement('circle', {
        cx: point.x,
        cy: point.y,
        r: 3.6,
        class: `agent-chart-point-${series.className}`
      })
      const title = svgElement('title')
      title.textContent = `${formatDate(point.row.report_date)} — ${series.label}: ${formatCount(point.value)}`
      circle.appendChild(title)
      svg.appendChild(circle)
    })
  })

  const labelCount = Math.min(7, data.length)
  const indexes = new Set()
  for (let index = 0; index < labelCount; index += 1) {
    indexes.add(labelCount === 1
      ? 0
      : Math.round((index / (labelCount - 1)) * (data.length - 1)))
  }
  indexes.forEach(index => {
    const x = data.length === 1
      ? dimensions.left + dimensions.width / 2
      : dimensions.left + (index / (data.length - 1)) * dimensions.width
    const text = svgElement('text', {
      x,
      y: dimensions.top + dimensions.height + 30,
      'text-anchor': 'middle',
      class: 'agent-chart-label'
    })
    text.textContent = formatDate(data[index].report_date, true)
    svg.appendChild(text)
  })

  scroll.appendChild(svg)
  const legend = document.createElement('div')
  legend.className = 'agent-chart-legend'
  const solved = document.createElement('span')
  solved.textContent = 'Solved tickets'
  const open = document.createElement('span')
  open.textContent = 'Open tickets'
  legend.append(solved, open)
  ui.chart.append(scroll, legend)
}

function renderRanking(ui, rows) {
  ui.ranking.replaceChildren()
  const agents = [...(Array.isArray(rows) ? rows : [])].sort((first, second) => {
    const firstIndex = Number(first.workload_adjusted_index)
    const secondIndex = Number(second.workload_adjusted_index)
    if (Number.isFinite(firstIndex) && Number.isFinite(secondIndex)) {
      return secondIndex - firstIndex || String(first.agent_name).localeCompare(String(second.agent_name))
    }
    if (Number.isFinite(firstIndex)) return -1
    if (Number.isFinite(secondIndex)) return 1
    return String(first.agent_name).localeCompare(String(second.agent_name))
  })

  if (agents.length === 0) {
    renderEmpty(ui.ranking, 'No agents match the selected range.')
    return
  }

  const maximum = Math.max(
    100,
    ...agents.map(row => Number(row.workload_adjusted_index)).filter(Number.isFinite)
  )

  agents.forEach(row => {
    const item = document.createElement('article')
    item.className = 'agent-ranking-row'
    const identity = document.createElement('div')
    identity.className = 'agent-ranking-name'
    const name = document.createElement('strong')
    name.textContent = row.agent_name || row.agent_key
    const context = document.createElement('small')
    context.textContent = `${formatCount(row.solved_tickets)} solved · ${formatPercent(row.team_output_share)} of team output`
    identity.append(name, context)

    const track = document.createElement('span')
    track.className = 'agent-ranking-track'
    const bar = document.createElement('span')
    bar.className = 'agent-ranking-bar'
    const value = Number(row.workload_adjusted_index)
    bar.style.width = `${Number.isFinite(value) ? Math.max(0, Math.min(100, (value / maximum) * 100)) : 0}%`
    track.appendChild(bar)

    const metric = document.createElement('strong')
    metric.className = 'agent-ranking-value'
    metric.textContent = formatIndex(row.workload_adjusted_index)
    item.append(identity, track, metric)
    ui.ranking.appendChild(item)
  })
}

function appendTextCell(row, value) {
  const cell = document.createElement('td')
  cell.textContent = value
  row.appendChild(cell)
}

function renderTable(ui, rows) {
  ui.tableBody.replaceChildren()
  const agents = Array.isArray(rows) ? rows : []

  agents.forEach(agent => {
    const row = document.createElement('tr')
    appendTextCell(row, agent.agent_name || agent.agent_key)
    appendTextCell(row, formatCount(agent.solved_tickets))
    appendTextCell(row, formatCount(agent.latest_open_tickets))
    appendTextCell(row, formatCount(agent.avg_open_tickets))
    appendTextCell(row, formatAht(agent.avg_aht_minutes))
    appendTextCell(row, formatAht(agent.median_aht_minutes))
    appendTextCell(row, formatDuration(agent.avg_first_response_minutes))
    appendTextCell(row, formatDuration(agent.avg_resolution_minutes))
    appendTextCell(row, formatPercent(agent.reopen_rate))
    appendTextCell(row, formatPercent(agent.team_output_share))
    appendTextCell(row, formatIndex(agent.workload_adjusted_index))

    const mappingCell = document.createElement('td')
    const mapping = document.createElement('span')
    mapping.className = 'agent-mapping-status'
    mapping.dataset.mapped = String(agent.zendesk_mapped === true)
    mapping.textContent = agent.zendesk_mapped === true ? 'Mapped' : 'Mapping required'
    mappingCell.appendChild(mapping)
    row.appendChild(mappingCell)
    ui.tableBody.appendChild(row)
  })

  ui.tableMeta.textContent = `${formatCount(agents.length)} agent${agents.length === 1 ? '' : 's'}`
  ui.tableCaption.textContent = agents.length
    ? 'Agent performance metrics for the selected date range.'
    : 'No agent performance data matches the selected date range.'
}

function showContent(ui) {
  ui.page.setAttribute('aria-busy', 'false')
  ui.status.hidden = true
  ui.content.hidden = false
}

function showError(ui, error) {
  console.error('Unable to load agent analytics:', error)
  ui.page.setAttribute('aria-busy', 'false')
  ui.content.hidden = true
  ui.status.hidden = false
  ui.status.replaceChildren()
  const heading = document.createElement('h2')
  heading.textContent = 'Agent analytics could not be loaded'
  const message = document.createElement('p')
  message.textContent = String(error?.message || '').includes('get_agent_analytics_dashboard')
    ? 'Run the Phase 3 Step 7 Supabase migration, then refresh this page.'
    : error?.message || 'Refresh the page or contact an administrator.'
  ui.status.append(heading, message)
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
    populateAgents(ui, state, data.options)
    renderActiveFilters(ui, state, range)
    renderReadiness(ui, data.readiness)
    renderSummary(ui, data.summary || {}, state)
    renderTrend(ui, data.trend, state)
    renderRanking(ui, data.agents)
    renderTable(ui, data.agents)
    ui.rangeSummary.textContent = rangeLabel(range)
    ui.badge.textContent = state.agent ? selectedAgentLabel(ui, state) : 'All agents'
    showContent(ui)
  } catch (error) {
    showError(ui, error)
  }
}

initialize()
