import { supabase } from './supabaseClient.js?v=8'

const REPORT_TIME_ZONE = 'America/New_York'
const FILTER_KEYS = Object.freeze([
  'app',
  'platform',
  'country',
  'driver',
  'agent',
  'priority',
  'channel'
])
const SVG_NS = 'http://www.w3.org/2000/svg'

function dateStringInTimeZone(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date)
  const values = Object.fromEntries(
    parts
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  )

  return `${values.year}-${values.month}-${values.day}`
}

function addDays(value, amount) {
  const date = new Date(`${value}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + amount)
  return date.toISOString().slice(0, 10)
}

function firstDayOfMonth(value) {
  return `${value.slice(0, 7)}-01`
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) &&
    !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())
}

function initialState() {
  const params = new URLSearchParams(window.location.search)
  const range = ['7d', '30d', '90d', 'mtd', 'custom'].includes(
    params.get('range')
  )
    ? params.get('range')
    : '30d'

  return {
    range,
    start: validDate(params.get('start')) ? params.get('start') : null,
    end: validDate(params.get('end')) ? params.get('end') : null,
    ...Object.fromEntries(
      FILTER_KEYS.map(key => [key, params.get(key) || null])
    )
  }
}

function resolveDates(state) {
  const today = dateStringInTimeZone()

  if (
    state.range === 'custom' &&
    validDate(state.start) &&
    validDate(state.end)
  ) {
    if (state.start > state.end) {
      throw new Error('The custom start date must be on or before the end date.')
    }

    return {
      startDate: state.start,
      endDate: state.end
    }
  }

  if (state.range === 'mtd') {
    return {
      startDate: firstDayOfMonth(today),
      endDate: today
    }
  }

  const days = Number.parseInt(state.range, 10) || 30

  return {
    startDate: addDays(today, -(days - 1)),
    endDate: today
  }
}

function formatDate(value, short = false) {
  if (!value) return 'No data'

  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return String(value)

  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: short ? 'short' : 'long',
    day: 'numeric',
    year: short ? undefined : 'numeric'
  }).format(date)
}

function rangeLabel(range) {
  if (!range?.startDate || !range?.endDate) return 'Selected period'
  if (range.startDate === range.endDate) return formatDate(range.startDate)

  return `${formatDate(range.startDate, true)} – ${formatDate(range.endDate)}`
}

function count(value) {
  const number = Number(value)
  return Number.isFinite(number)
    ? new Intl.NumberFormat('en-US').format(number)
    : '—'
}

function setText(id, value) {
  const element = document.getElementById(id)
  if (element) element.textContent = value
}

function setCardCopy(valueId, title, caption) {
  const value = document.getElementById(valueId)
  const card = value?.closest('.metric-card')
  if (!card) return

  const heading = card.querySelector('h2')
  const description = card.querySelector('.metric-caption')
  if (heading) heading.textContent = title
  if (description) description.textContent = caption
}

function formMarkup() {
  const dimensions = [
    ['app', 'App'],
    ['platform', 'Platform'],
    ['country', 'Country'],
    ['driver', 'Driver group'],
    ['agent', 'Agent'],
    ['priority', 'Priority'],
    ['channel', 'Channel']
  ]

  return `
    <section class="dashboard-global-filters" aria-labelledby="dashboardFilterTitle">
      <div class="dashboard-filter-heading">
        <div>
          <span class="dashboard-filter-eyebrow">Global filters</span>
          <h2 id="dashboardFilterTitle">Operational view</h2>
        </div>
        <span id="dashboardFilterStatus" class="dashboard-filter-status" data-status="idle">
          Ready
        </span>
      </div>
      <form id="dashboardFilterForm" class="dashboard-filter-form">
        <label class="dashboard-filter-field dashboard-filter-range-field">
          <span>Date range</span>
          <select id="dashboardRangeFilter" name="range">
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
            <option value="mtd">Month to date</option>
            <option value="custom">Custom range</option>
          </select>
        </label>
        <label class="dashboard-filter-field dashboard-custom-date" data-custom-date>
          <span>Start date</span>
          <input id="dashboardStartDate" type="date" name="start" />
        </label>
        <label class="dashboard-filter-field dashboard-custom-date" data-custom-date>
          <span>End date</span>
          <input id="dashboardEndDate" type="date" name="end" />
        </label>
        ${dimensions.map(([key, label]) => `
          <label class="dashboard-filter-field">
            <span>${label}</span>
            <select id="dashboard${label.replace(/\s+/g, '')}Filter" name="${key}">
              <option value="">All ${label.toLowerCase()}s</option>
            </select>
          </label>
        `).join('')}
        <div class="dashboard-filter-actions">
          <button class="dashboard-filter-apply" type="submit">Apply filters</button>
          <button id="dashboardFilterReset" class="dashboard-filter-reset" type="button">
            Reset
          </button>
        </div>
      </form>
      <div id="dashboardActiveFilters" class="dashboard-active-filters" aria-live="polite"></div>
    </section>
  `
}

function buildFilterBar(state) {
  const header = document.querySelector('.topbar')
  if (!header) throw new Error('The dashboard header could not be found.')

  let section = document.querySelector('.dashboard-global-filters')
  if (!section) {
    header.insertAdjacentHTML('afterend', formMarkup())
    section = document.querySelector('.dashboard-global-filters')
  }

  const form = document.getElementById('dashboardFilterForm')
  form.elements.range.value = state.range
  form.elements.start.value = state.start || ''
  form.elements.end.value = state.end || ''
  FILTER_KEYS.forEach(key => {
    form.elements[key].value = state[key] || ''
  })

  updateCustomDateVisibility(state.range)
  return form
}

function updateCustomDateVisibility(range) {
  document.querySelectorAll('[data-custom-date]').forEach(element => {
    element.hidden = range !== 'custom'
  })
}

function readFormState(form) {
  const data = new FormData(form)

  return {
    range: String(data.get('range') || '30d'),
    start: String(data.get('start') || '') || null,
    end: String(data.get('end') || '') || null,
    ...Object.fromEntries(
      FILTER_KEYS.map(key => [
        key,
        String(data.get(key) || '') || null
      ])
    )
  }
}

function updateUrl(state) {
  const params = new URLSearchParams()
  params.set('range', state.range)

  if (state.range === 'custom') {
    if (state.start) params.set('start', state.start)
    if (state.end) params.set('end', state.end)
  }

  FILTER_KEYS.forEach(key => {
    if (state[key]) params.set(key, state[key])
  })

  const query = params.toString()
  const nextUrl = `${window.location.pathname}${query ? `?${query}` : ''}`
  window.history.replaceState({}, '', nextUrl)
}

function setFilterStatus(status, text) {
  const element = document.getElementById('dashboardFilterStatus')
  if (!element) return

  element.dataset.status = status
  element.textContent = text
}

function optionLabel(row) {
  const label = row?.label || row?.key || 'Unknown'
  const ticketCount = Number(row?.ticket_count)

  return Number.isFinite(ticketCount)
    ? `${label} (${count(ticketCount)})`
    : label
}

function populateSelect(select, rows, selectedValue) {
  if (!select) return

  const allOption = select.options[0]
  select.replaceChildren(allOption)

  for (const row of rows || []) {
    const option = document.createElement('option')
    option.value = row.key
    option.textContent = optionLabel(row)
    select.appendChild(option)
  }

  select.value = selectedValue || ''

  if (selectedValue && select.value !== selectedValue) {
    const option = document.createElement('option')
    option.value = selectedValue
    option.textContent = selectedValue
    select.appendChild(option)
    select.value = selectedValue
  }
}

function populateFilterOptions(options, state) {
  const form = document.getElementById('dashboardFilterForm')
  if (!form) return

  FILTER_KEYS.forEach(key => {
    populateSelect(form.elements[key], options?.[key] || [], state[key])
  })
}

function renderActiveFilters(state, data) {
  const container = document.getElementById('dashboardActiveFilters')
  if (!container) return

  const labels = []
  const options = data?.options || {}

  FILTER_KEYS.forEach(key => {
    if (!state[key]) return
    const row = (options[key] || []).find(option => option.key === state[key])
    labels.push(`${key}: ${row?.label || state[key]}`)
  })

  const dates = resolveDates(state)
  const intro = document.createElement('strong')
  intro.textContent = rangeLabel({
    startDate: dates.startDate,
    endDate: dates.endDate
  })
  container.replaceChildren(intro)

  labels.forEach(label => {
    const chip = document.createElement('span')
    chip.textContent = label
    container.appendChild(chip)
  })

  if (labels.length === 0) {
    const chip = document.createElement('span')
    chip.textContent = 'All dimensions'
    container.appendChild(chip)
  }
}

function svgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name)
  Object.entries(attributes).forEach(([key, value]) => {
    element.setAttribute(key, String(value))
  })
  return element
}

function renderTrend(rows) {
  const svg = document.getElementById('ticketVolumeChart')
  const empty = document.getElementById('chartEmptyState')
  if (!svg || !empty) return

  svg.replaceChildren()

  if (!Array.isArray(rows) || rows.length === 0) {
    empty.hidden = false
    empty.textContent = 'No ticket events match the selected filters.'
    return
  }

  empty.hidden = true
  const width = 800
  const height = 330
  const left = 58
  const right = 20
  const top = 20
  const bottom = 55
  const plotWidth = width - left - right
  const plotHeight = height - top - bottom
  const maximum = Math.max(
    1,
    ...rows.flatMap(row => [
      Number(row.tickets_created) || 0,
      Number(row.tickets_solved) || 0
    ])
  )
  const niceMaximum = Math.ceil(maximum / 5) * 5 || 1

  for (let tick = 0; tick <= 5; tick += 1) {
    const ratio = tick / 5
    const y = top + ratio * plotHeight
    const value = Math.round(niceMaximum * (1 - ratio))
    svg.appendChild(svgElement('line', {
      x1: left,
      y1: y,
      x2: left + plotWidth,
      y2: y,
      class: 'ticket-chart-grid'
    }))
    const label = svgElement('text', {
      x: left - 9,
      y: y + 4,
      'text-anchor': 'end',
      class: 'ticket-chart-text'
    })
    label.textContent = count(value)
    svg.appendChild(label)
  }

  const points = key => rows.map((row, index) => {
    const x = rows.length === 1
      ? left + plotWidth / 2
      : left + (index / (rows.length - 1)) * plotWidth
    const value = Number(row[key]) || 0
    const y = top + plotHeight - (value / niceMaximum) * plotHeight
    return { x, y, value, row }
  })

  const addSeries = (key, lineClass, pointClass, labelText) => {
    const series = points(key)
    const path = series.map((point, index) =>
      `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`
    ).join(' ')

    svg.appendChild(svgElement('path', {
      d: path,
      class: lineClass
    }))

    series.forEach(point => {
      const circle = svgElement('circle', {
        cx: point.x,
        cy: point.y,
        r: 3.2,
        class: pointClass
      })
      const title = svgElement('title')
      title.textContent =
        `${formatDate(point.row.report_date)} — ${labelText}: ${count(point.value)}`
      circle.appendChild(title)
      svg.appendChild(circle)
    })
  }

  addSeries(
    'tickets_created',
    'ticket-chart-line-new',
    'ticket-chart-point-new',
    'Created tickets'
  )
  addSeries(
    'tickets_solved',
    'ticket-chart-line-solved',
    'ticket-chart-point-solved',
    'Solved tickets'
  )

  const labelCount = Math.min(6, rows.length)
  const indexes = new Set()
  for (let index = 0; index < labelCount; index += 1) {
    indexes.add(labelCount === 1
      ? 0
      : Math.round((index / (labelCount - 1)) * (rows.length - 1)))
  }

  indexes.forEach(index => {
    const x = rows.length === 1
      ? left + plotWidth / 2
      : left + (index / (rows.length - 1)) * plotWidth
    const label = svgElement('text', {
      x,
      y: top + plotHeight + 26,
      'text-anchor': 'middle',
      class: 'ticket-chart-text'
    })
    label.textContent = formatDate(rows[index].report_date, true)
    svg.appendChild(label)
  })
}

function renderBreakdownList(container, rows, emptyText) {
  if (!container) return
  container.replaceChildren()

  if (!Array.isArray(rows) || rows.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'global-filter-empty'
    empty.textContent = emptyText
    container.appendChild(empty)
    return
  }

  const total = rows.reduce(
    (sum, row) => sum + (Number(row.ticket_count) || 0),
    0
  )
  const list = document.createElement('div')
  list.className = 'global-filter-breakdown-list'

  rows.forEach(row => {
    const value = Number(row.ticket_count) || 0
    const percentage = total > 0 ? value / total : 0
    const item = document.createElement('div')
    item.className = 'global-filter-breakdown-row'
    item.innerHTML = `
      <div class="global-filter-breakdown-copy">
        <strong></strong>
        <span></span>
      </div>
      <div class="global-filter-breakdown-values">
        <strong></strong>
        <span></span>
      </div>
    `
    item.querySelector('.global-filter-breakdown-copy strong').textContent =
      row.label || row.key
    item.querySelector('.global-filter-breakdown-copy span').textContent =
      row.key
    item.querySelector('.global-filter-breakdown-values strong').textContent =
      count(value)
    item.querySelector('.global-filter-breakdown-values span').textContent =
      new Intl.NumberFormat('en-US', {
        style: 'percent',
        maximumFractionDigits: 1
      }).format(percentage)
    list.appendChild(item)
  })

  container.appendChild(list)
}

function ensureOperationalDimensionsSection() {
  let section = document.getElementById('operationalDimensions')
  if (section) return section

  const board = document.querySelector('.dashboard-board')
  if (!board) return null

  section = document.createElement('article')
  section.id = 'operationalDimensions'
  section.className =
    'dashboard-section filter-dimension-overview'
  section.innerHTML = `
    <div class="section-tab">Operations</div>
    <div class="section-content">
      <div class="filter-dimension-heading">
        <div>
          <h2>Priority and Channel</h2>
          <p>Ticket creation volume for the selected filter state</p>
        </div>
        <span id="operationalDimensionsDate" class="placeholder-badge">Loading</span>
      </div>
      <div class="filter-dimension-grid">
        <section class="chart-card">
          <div class="card-heading"><h2>Priority</h2></div>
          <div id="priorityFilteredBreakdown"></div>
        </section>
        <section class="chart-card">
          <div class="card-heading"><h2>Channel</h2></div>
          <div id="channelFilteredBreakdown"></div>
        </section>
      </div>
    </div>
  `
  board.appendChild(section)
  return section
}

function renderSummary(data) {
  const summary = data?.summary || {}
  const range = data?.range || {}

  setCardCopy(
    'newTicketsValue',
    'Created Tickets',
    'Created during the selected period'
  )
  setCardCopy(
    'solvedTicketsValue',
    'Solved Tickets',
    'Solved during the selected period'
  )
  setCardCopy(
    'unsolvedTicketsValue',
    'Open Backlog',
    'Open at the end of the selected period'
  )
  setCardCopy(
    'oneTouchResolutionValue',
    'Backlog Over 24h',
    'Open tickets at least 24 hours old'
  )
  setCardCopy(
    'reopenedRateValue',
    'Reopened Tickets',
    'Reopened during the selected period'
  )

  setText('newTicketsValue', count(summary.tickets_created))
  setText('solvedTicketsValue', count(summary.tickets_solved))
  setText('unsolvedTicketsValue', count(summary.backlog_open))
  setText('oneTouchResolutionValue', count(summary.backlog_over_24h))
  setText('reopenedRateValue', count(summary.reopened_tickets))
  setText('latestReportDate', rangeLabel(range))
  setText('chartPeriodBadge', `${data?.trend?.length || 0} days`)

  const subtitle = document.querySelector('.title-block p')
  if (subtitle) {
    subtitle.textContent =
      'Server-filtered operational metrics synchronized from Zendesk.'
  }

  const status = document.getElementById('dashboardDataStatus')
  if (status) {
    status.dataset.status = 'ready'
    status.textContent = 'Filtered data'
  }

  renderTrend(data?.trend || [])
}

function renderDistributions(data) {
  const breakdowns = data?.breakdowns || {}
  const label = rangeLabel(data?.range)

  setText('distributionDateBadge', label)
  renderBreakdownList(
    document.getElementById('appDistributionChart'),
    breakdowns.app,
    'No app values match the selected filters.'
  )
  renderBreakdownList(
    document.getElementById('platformDistributionChart'),
    breakdowns.platform,
    'No platform values match the selected filters.'
  )
  renderBreakdownList(
    document.getElementById('countryDistributionChart'),
    breakdowns.country,
    'No country values match the selected filters.'
  )
}

function renderDrivers(data) {
  const rows = data?.breakdowns?.driver || []
  const total = rows.reduce(
    (sum, row) => sum + (Number(row.ticket_count) || 0),
    0
  )

  setText('driverDateBadge', rangeLabel(data?.range))
  setText('driverTicketTotal', count(total))
  setText('driverGroupCount', count(rows.length))
  setText('leadingDriverValue', rows[0]?.label || '—')
  renderBreakdownList(
    document.getElementById('ticketDriverChart'),
    rows,
    'No driver groups match the selected filters.'
  )
}

function renderAgents(data) {
  const container = document.getElementById('productivityChart')
  const rows = Array.isArray(data?.agents) ? data.agents : []
  const teamSolved = rows.reduce(
    (sum, row) => sum + (Number(row.solved_tickets) || 0),
    0
  )
  const teamOpen = rows.reduce(
    (sum, row) => sum + (Number(row.open_tickets) || 0),
    0
  )

  setText('productivityDateBadge', rangeLabel(data?.range))
  setText('teamSolvedValue', count(teamSolved))
  setText('reportedAgentsValue', count(rows.length))
  setText('teamOpenValue', count(teamOpen))

  if (!container) return
  container.replaceChildren()

  if (rows.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'global-filter-empty'
    empty.textContent = 'No agents match the selected filters.'
    container.appendChild(empty)
    return
  }

  const list = document.createElement('div')
  list.className = 'global-filter-agent-list'

  rows.forEach((row, index) => {
    const item = document.createElement('article')
    item.className = 'global-filter-agent-row'
    item.innerHTML = `
      <span class="global-filter-agent-rank"></span>
      <div class="global-filter-agent-name">
        <strong></strong>
        <span></span>
      </div>
      <div class="global-filter-agent-metric">
        <strong></strong>
        <span>Solved</span>
      </div>
      <div class="global-filter-agent-metric">
        <strong></strong>
        <span>Open</span>
      </div>
    `
    item.querySelector('.global-filter-agent-rank').textContent =
      String(index + 1)
    item.querySelector('.global-filter-agent-name strong').textContent =
      row.agent_name || row.agent_key
    item.querySelector('.global-filter-agent-name span').textContent =
      row.agent_key
    const metrics = item.querySelectorAll(
      '.global-filter-agent-metric strong'
    )
    metrics[0].textContent = count(row.solved_tickets)
    metrics[1].textContent = count(row.open_tickets)
    list.appendChild(item)
  })

  container.appendChild(list)
}

function renderOperationalDimensions(data) {
  ensureOperationalDimensionsSection()
  setText('operationalDimensionsDate', rangeLabel(data?.range))
  renderBreakdownList(
    document.getElementById('priorityFilteredBreakdown'),
    data?.breakdowns?.priority || [],
    'No priority values match the selected filters.'
  )
  renderBreakdownList(
    document.getElementById('channelFilteredBreakdown'),
    data?.breakdowns?.channel || [],
    'No channel values match the selected filters.'
  )
}

function renderFilteredDashboard(data, state) {
  renderSummary(data)
  renderDistributions(data)
  renderDrivers(data)
  renderAgents(data)
  renderOperationalDimensions(data)
  populateFilterOptions(data?.options || {}, state)
  renderActiveFilters(state, data)

  window.dispatchEvent(new CustomEvent(
    'dashboard:filtered-data',
    {
      detail: {
        state: { ...state },
        data
      }
    }
  ))
}

function rpcParameters(state) {
  const dates = resolveDates(state)

  return {
    p_start_date: dates.startDate,
    p_end_date: dates.endDate,
    p_app_key: state.app,
    p_platform_key: state.platform,
    p_country_key: state.country,
    p_driver_key: state.driver,
    p_agent_key: state.agent,
    p_priority: state.priority,
    p_channel: state.channel,
    p_time_zone: REPORT_TIME_ZONE
  }
}

async function loadFilteredData(state) {
  setFilterStatus('loading', 'Loading')
  const { data, error } = await supabase.rpc(
    'get_dashboard_filtered_data',
    rpcParameters(state)
  )

  if (error) throw error

  renderFilteredDashboard(data || {}, state)
  setFilterStatus('ready', 'Applied')
  updateUrl(state)

  window.dispatchEvent(new CustomEvent(
    'dashboard:filters-changed',
    { detail: { ...state } }
  ))

  return data
}

function waitForDashboard(timeout = 20000) {
  return new Promise(resolve => {
    const ready = () => {
      const board = document.querySelector('.dashboard-board')
      return Boolean(
        board &&
        board.getAttribute('aria-busy') === 'false' &&
        document.getElementById('ticketVolumeChart') &&
        document.getElementById('productivityChart') &&
        document.getElementById('appDistributionChart')
      )
    }

    if (ready()) {
      resolve()
      return
    }

    const observer = new MutationObserver(() => {
      if (!ready()) return
      observer.disconnect()
      window.clearTimeout(timer)
      resolve()
    })
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-busy']
    })

    const timer = window.setTimeout(() => {
      observer.disconnect()
      resolve()
    }, timeout)
  })
}

async function initializeGlobalDashboardFilters() {
  const {
    data: { user },
    error
  } = await supabase.auth.getUser()

  if (error || !user) return

  await waitForDashboard()
  let state = initialState()
  const form = buildFilterBar(state)
  ensureOperationalDimensionsSection()

  form.elements.range.addEventListener('change', event => {
    updateCustomDateVisibility(event.target.value)
  })

  form.addEventListener('submit', async event => {
    event.preventDefault()
    const nextState = readFormState(form)

    try {
      await loadFilteredData(nextState)
      state = nextState
    } catch (loadError) {
      console.error('Unable to apply dashboard filters:', loadError)
      setFilterStatus('error', 'Unavailable')
      alert(
        loadError?.message ||
        'The filtered dashboard data could not be loaded.'
      )
    }
  })

  document.getElementById('dashboardFilterReset')
    ?.addEventListener('click', async () => {
      state = {
        range: '30d',
        start: null,
        end: null,
        ...Object.fromEntries(FILTER_KEYS.map(key => [key, null]))
      }
      form.reset()
      form.elements.range.value = state.range
      updateCustomDateVisibility(state.range)

      try {
        await loadFilteredData(state)
      } catch (loadError) {
        console.error('Unable to reset dashboard filters:', loadError)
        setFilterStatus('error', 'Unavailable')
      }
    })

  window.__slDashboardFilters = Object.freeze({
    getState: () => ({ ...state }),
    refresh: () => loadFilteredData(state)
  })

  try {
    await loadFilteredData(state)
  } catch (loadError) {
    console.error('Unable to initialize dashboard filters:', loadError)
    setFilterStatus('error', 'Migration required')
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initializeGlobalDashboardFilters().catch(error => {
    console.error('Global dashboard filter initialization failed:', error)
  })
})
