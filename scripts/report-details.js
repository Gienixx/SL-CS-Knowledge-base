import { supabase } from './supabaseClient.js?v=8'
import {
  requiresFirstLoginPasswordChange
} from './first-login-policy.js?v=4'

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

const REPORTS = Object.freeze({
  'new-vs-solved': Object.freeze({
    title: 'New vs. Solved Tickets',
    subtitle: 'Compare incoming and completed ticket volume over the selected period.',
    chartTitle: 'New and solved ticket trend',
    chartSubtitle: 'Daily ticket totals for the selected date range',
    tableTitle: 'Daily ticket history',
    defaultRange: '30d',
    sheetTable: 'daily_ticket_metrics',
    kind: 'ticket-trend',
    supportsZendesk: true
  }),
  'new-tickets': Object.freeze({
    title: 'New Tickets',
    subtitle: 'Review incoming ticket volume over the selected period.',
    chartTitle: 'New ticket trend',
    chartSubtitle: 'Daily new-ticket totals',
    tableTitle: 'New ticket history',
    defaultRange: '30d',
    sheetTable: 'daily_ticket_metrics',
    kind: 'ticket-metric',
    metric: 'new_tickets',
    supportsZendesk: true
  }),
  'solved-tickets': Object.freeze({
    title: 'Solved Tickets',
    subtitle: 'Review completed ticket volume over the selected period.',
    chartTitle: 'Solved ticket trend',
    chartSubtitle: 'Daily solved-ticket totals',
    tableTitle: 'Solved ticket history',
    defaultRange: '30d',
    sheetTable: 'daily_ticket_metrics',
    kind: 'ticket-metric',
    metric: 'solved_tickets',
    supportsZendesk: true
  }),
  'unsolved-tickets': Object.freeze({
    title: 'Unsolved Tickets',
    subtitle: 'Review the open-ticket backlog for the selected period.',
    chartTitle: 'Unsolved ticket trend',
    chartSubtitle: 'Daily backlog snapshots from the Google Sheet',
    tableTitle: 'Unsolved ticket history',
    defaultRange: '30d',
    sheetTable: 'daily_ticket_metrics',
    kind: 'ticket-metric',
    metric: 'unsolved_tickets',
    supportsZendesk: true
  }),
  'one-touch-resolution': Object.freeze({
    title: 'One-Touch Resolution',
    subtitle: 'Review the daily percentage of tickets resolved in one interaction.',
    chartTitle: 'One-touch resolution trend',
    chartSubtitle: 'Daily Google Sheet resolution-rate snapshots',
    tableTitle: 'One-touch resolution history',
    defaultRange: '30d',
    sheetTable: 'daily_ticket_metrics',
    kind: 'ticket-rate',
    metric: 'one_touch_resolution',
    supportsZendesk: false
  }),
  'reopened-rate': Object.freeze({
    title: 'Reopened Rate',
    subtitle: 'Review tickets reopened after resolution over the selected period.',
    chartTitle: 'Reopened-rate trend',
    chartSubtitle: 'Daily Google Sheet rate or filtered Zendesk period result',
    tableTitle: 'Reopened ticket history',
    defaultRange: '30d',
    sheetTable: 'daily_ticket_metrics',
    kind: 'ticket-rate',
    metric: 'reopened_rate',
    supportsZendesk: true
  }),
  app: Object.freeze({
    title: 'Tickets by App',
    subtitle: 'Review ticket distribution across Eureka, SurveyPop, and SurveySpin.',
    chartTitle: 'App distribution',
    chartSubtitle: 'Ticket volume grouped by app',
    tableTitle: 'App distribution data',
    defaultRange: 'latest',
    sheetTable: 'daily_distribution_metrics',
    kind: 'distribution',
    dimension: 'app',
    supportsZendesk: true
  }),
  platform: Object.freeze({
    title: 'Tickets by Platform',
    subtitle: 'Review ticket distribution across Android, iOS, and Web.',
    chartTitle: 'Platform distribution',
    chartSubtitle: 'Ticket volume grouped by platform',
    tableTitle: 'Platform distribution data',
    defaultRange: 'latest',
    sheetTable: 'daily_distribution_metrics',
    kind: 'distribution',
    dimension: 'platform',
    supportsZendesk: true
  }),
  country: Object.freeze({
    title: 'Tickets by Country',
    subtitle: 'Review mapped ticket volume by customer country.',
    chartTitle: 'Country distribution',
    chartSubtitle: 'Ticket volume grouped by country',
    tableTitle: 'Country distribution data',
    defaultRange: 'latest',
    sheetTable: 'daily_distribution_metrics',
    kind: 'distribution',
    dimension: 'country',
    supportsZendesk: true
  }),
  concern: Object.freeze({
    title: 'Tickets by Concern',
    subtitle: 'Review the support-contact volume associated with each concern group.',
    chartTitle: 'Concern distribution',
    chartSubtitle: 'Ticket volume grouped by concern',
    tableTitle: 'Concern distribution data',
    defaultRange: 'latest',
    sheetTable: 'ticket_driver_metrics',
    kind: 'concern',
    supportsZendesk: true
  }),
  'agent-productivity': Object.freeze({
    title: 'Agent Productivity',
    subtitle: 'Review solved output and current workload by agent.',
    chartTitle: 'Solved tickets by agent',
    chartSubtitle: 'Agent productivity for the selected reporting period',
    tableTitle: 'Agent productivity data',
    defaultRange: 'latest',
    sheetTable: 'agent_productivity',
    kind: 'agent',
    supportsZendesk: true
  })
})

function elements() {
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
  const number = Number(value)
  return Number.isFinite(number)
    ? new Intl.NumberFormat('en-US').format(number)
    : '—'
}

function formatPercentValue(value) {
  const number = Number(value)
  return Number.isFinite(number)
    ? `${new Intl.NumberFormat('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 1
      }).format(number)}%`
    : '—'
}

function formatMinutes(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  return `${new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 1
  }).format(number)} min`
}

function parseRequest() {
  const params = new URLSearchParams(window.location.search)
  const reportKey = normalize(params.get('report'))
  const config = REPORTS[reportKey]

  if (!config) {
    throw new Error('This report link is invalid. Return to the dashboard and open a chart again.')
  }

  const allowedRanges = new Set(['latest', '7d', '30d', '90d', 'mtd', 'custom'])
  const range = allowedRanges.has(params.get('range'))
    ? params.get('range')
    : config.defaultRange
  const state = {
    range,
    start: isIsoDate(params.get('start')) ? params.get('start') : '',
    end: isIsoDate(params.get('end')) ? params.get('end') : '',
    ...Object.fromEntries(FILTER_KEYS.map(key => [key, normalize(params.get(key))]))
  }

  if (!config.supportsZendesk) {
    FILTER_KEYS.forEach(key => {
      state[key] = ''
    })
  }

  return { reportKey, config, state }
}

function hasDetailedFilters(state) {
  return FILTER_KEYS.some(key => Boolean(state[key]))
}

function selectSource(config, state) {
  return config.supportsZendesk && hasDetailedFilters(state)
    ? 'zendesk'
    : 'google_sheet'
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

async function latestSheetDate(config) {
  let query = supabase
    .from(config.sheetTable)
    .select('report_date')
    .order('report_date', { ascending: false })
    .limit(1)

  if (config.kind === 'distribution') {
    query = query.eq('dimension_type', config.dimension)
  }

  const { data, error } = await query
  if (error) throw error
  return data?.[0]?.report_date || null
}

function resolveRange(state, anchorDate) {
  if (!anchorDate) throw new Error('No synchronized reporting date is available.')

  if (state.range === 'custom') {
    if (!isIsoDate(state.start) || !isIsoDate(state.end)) {
      throw new Error('Choose both a valid start date and end date.')
    }
    if (state.start > state.end) {
      throw new Error('The start date cannot be after the end date.')
    }
    return { startDate: state.start, endDate: state.end }
  }

  if (state.range === 'latest') {
    return { startDate: anchorDate, endDate: anchorDate }
  }

  if (state.range === 'mtd') {
    return { startDate: `${anchorDate.slice(0, 7)}-01`, endDate: anchorDate }
  }

  const days = Number.parseInt(state.range, 10) || 30
  return {
    startDate: addDays(anchorDate, -(days - 1)),
    endDate: anchorDate
  }
}

function rangeLabel(range) {
  if (range.startDate === range.endDate) return formatDate(range.startDate)
  return `${formatDate(range.startDate, true)} – ${formatDate(range.endDate)}`
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

async function loadZendesk(state, range) {
  const { data, error } = await supabase.rpc(
    'get_dashboard_filtered_data',
    rpcParameters(state, range)
  )

  if (error) throw error
  return data || {}
}

async function loadTicketSheet(range) {
  const { data, error } = await supabase
    .from('daily_ticket_metrics')
    .select('report_date, new_tickets, solved_tickets, unsolved_tickets, one_touch_resolution, reopened_rate')
    .gte('report_date', range.startDate)
    .lte('report_date', range.endDate)
    .order('report_date', { ascending: true })

  if (error) throw error
  return Array.isArray(data) ? data : []
}

async function loadDistributionSheet(config, range) {
  const { data, error } = await supabase
    .from('daily_distribution_metrics')
    .select('report_date, dimension_type, dimension_key, dimension_label, ticket_count')
    .eq('dimension_type', config.dimension)
    .gte('report_date', range.startDate)
    .lte('report_date', range.endDate)
    .order('report_date', { ascending: true })

  if (error) throw error
  return Array.isArray(data) ? data : []
}

async function loadConcernSheet(range) {
  const { data, error } = await supabase
    .from('ticket_driver_metrics')
    .select('report_date, driver_group_key, driver_group_label, ticket_count')
    .gte('report_date', range.startDate)
    .lte('report_date', range.endDate)
    .order('report_date', { ascending: true })

  if (error) throw error
  return Array.isArray(data) ? data : []
}

async function loadAgentSheet(range) {
  const { data, error } = await supabase
    .from('agent_productivity')
    .select('report_date, agent_key, agent_name, solved_tickets, open_tickets, aht_value')
    .gte('report_date', range.startDate)
    .lte('report_date', range.endDate)
    .order('report_date', { ascending: false })

  if (error) throw error
  return Array.isArray(data) ? data : []
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + (Number(row[key]) || 0), 0)
}

function average(rows, key) {
  const values = rows
    .map(row => Number(row[key]))
    .filter(Number.isFinite)
  if (values.length === 0) return null
  return values.reduce((total, value) => total + value, 0) / values.length
}

function aggregateRows(rows, keyField, labelField, valueField) {
  const groups = new Map()

  rows.forEach(row => {
    const key = String(row[keyField] || '').trim()
    if (!key) return
    const current = groups.get(key) || {
      key,
      label: row[labelField] || key,
      value: 0
    }
    current.value += Number(row[valueField]) || 0
    groups.set(key, current)
  })

  return [...groups.values()].sort((first, second) =>
    second.value - first.value || first.label.localeCompare(second.label)
  )
}

function ticketSheetModel(config, rows, range) {
  const latest = rows.at(-1)
  const tableRows = rows.map(row => ({
    report_date: row.report_date,
    new_tickets: Number(row.new_tickets) || 0,
    solved_tickets: Number(row.solved_tickets) || 0,
    unsolved_tickets: Number(row.unsolved_tickets) || 0,
    one_touch_resolution: (Number(row.one_touch_resolution) || 0) * 100,
    reopened_rate: (Number(row.reopened_rate) || 0) * 100
  }))

  if (config.kind === 'ticket-trend') {
    const newTotal = sum(rows, 'new_tickets')
    const solvedTotal = sum(rows, 'solved_tickets')
    return {
      summary: [
        ['New tickets', formatCount(newTotal), 'Total received'],
        ['Solved tickets', formatCount(solvedTotal), 'Total solved'],
        ['Net change', formatCount(newTotal - solvedTotal), 'New minus solved'],
        ['Latest backlog', formatCount(latest?.unsolved_tickets), 'Latest synchronized day']
      ],
      chart: {
        type: 'line',
        rows: tableRows,
        series: [
          { key: 'new_tickets', label: 'New tickets' },
          { key: 'solved_tickets', label: 'Solved tickets' }
        ]
      },
      breakdown: [],
      table: {
        columns: [
          ['report_date', 'Date', 'date'],
          ['new_tickets', 'New tickets', 'count'],
          ['solved_tickets', 'Solved tickets', 'count'],
          ['unsolved_tickets', 'Unsolved tickets', 'count']
        ],
        rows: tableRows
      }
    }
  }

  const metric = config.metric
  const isRate = config.kind === 'ticket-rate'
  const values = tableRows.map(row => ({
    report_date: row.report_date,
    value: row[metric]
  }))
  const summaryValue = metric === 'unsolved_tickets'
    ? latest?.unsolved_tickets
    : isRate
      ? average(tableRows, metric)
      : sum(rows, metric)
  const caption = metric === 'unsolved_tickets'
    ? 'Latest backlog snapshot'
    : isRate
      ? 'Average daily rate'
      : 'Selected-period total'

  return {
    summary: [
      [config.title, isRate ? formatPercentValue(summaryValue) : formatCount(summaryValue), caption],
      ['Reporting days', formatCount(rows.length), rangeLabel(range)]
    ],
    chart: {
      type: 'line',
      rows: values,
      series: [{ key: 'value', label: config.title }],
      percent: isRate
    },
    breakdown: [],
    table: {
      columns: [
        ['report_date', 'Date', 'date'],
        ['value', config.title, isRate ? 'percent' : 'count']
      ],
      rows: values
    }
  }
}

function distributionSheetModel(config, rows) {
  const breakdown = aggregateRows(
    rows,
    'dimension_key',
    'dimension_label',
    'ticket_count'
  )
  const total = breakdown.reduce((value, row) => value + row.value, 0)

  return {
    summary: [
      ['Mapped tickets', formatCount(total), 'Selected-period total'],
      ['Categories', formatCount(breakdown.length), config.title],
      ['Leading category', breakdown[0]?.label || '—', breakdown[0] ? formatCount(breakdown[0].value) : 'No data']
    ],
    chart: { type: 'bar', rows: breakdown },
    breakdown,
    table: {
      columns: [
        ['label', 'Category', 'text'],
        ['value', 'Tickets', 'count'],
        ['share', 'Share', 'percent']
      ],
      rows: breakdown.map(row => ({
        ...row,
        share: total > 0 ? (row.value / total) * 100 : 0
      }))
    }
  }
}

function concernSheetModel(rows) {
  const breakdown = aggregateRows(
    rows,
    'driver_group_key',
    'driver_group_label',
    'ticket_count'
  )
  const total = breakdown.reduce((value, row) => value + row.value, 0)

  return {
    summary: [
      ['Concern tickets', formatCount(total), 'Selected-period total'],
      ['Concern groups', formatCount(breakdown.length), 'Mapped groups'],
      ['Leading concern', breakdown[0]?.label || '—', breakdown[0] ? formatCount(breakdown[0].value) : 'No data']
    ],
    chart: { type: 'bar', rows: breakdown },
    breakdown,
    table: {
      columns: [
        ['label', 'Concern', 'text'],
        ['value', 'Tickets', 'count'],
        ['share', 'Share', 'percent']
      ],
      rows: breakdown.map(row => ({
        ...row,
        share: total > 0 ? (row.value / total) * 100 : 0
      }))
    }
  }
}

function agentSheetModel(rows) {
  const latestDate = rows[0]?.report_date
  const latestRows = rows
    .filter(row => row.report_date === latestDate)
    .map(row => ({
      agent_key: row.agent_key,
      agent_name: row.agent_name || row.agent_key,
      solved_tickets: Number(row.solved_tickets) || 0,
      open_tickets: Number(row.open_tickets) || 0,
      aht_value: Number(row.aht_value)
    }))
    .sort((first, second) =>
      second.solved_tickets - first.solved_tickets ||
      first.agent_name.localeCompare(second.agent_name)
    )
  const solved = sum(latestRows, 'solved_tickets')
  const open = sum(latestRows, 'open_tickets')
  const breakdown = latestRows.map(row => ({
    key: row.agent_key,
    label: row.agent_name,
    value: row.solved_tickets
  }))

  return {
    summary: [
      ['Team solved', formatCount(solved), latestDate ? formatDate(latestDate) : 'No date'],
      ['Open tickets', formatCount(open), 'Latest snapshot'],
      ['Agents reported', formatCount(latestRows.length), 'Latest snapshot']
    ],
    chart: { type: 'bar', rows: breakdown },
    breakdown,
    table: {
      columns: [
        ['agent_name', 'Agent', 'text'],
        ['solved_tickets', 'Solved', 'count'],
        ['open_tickets', 'Open', 'count'],
        ['aht_value', 'AHT', 'minutes']
      ],
      rows: latestRows
    }
  }
}

function zendeskModel(config, data) {
  const summary = data.summary || {}
  const trend = Array.isArray(data.trend) ? data.trend : []
  const breakdowns = data.breakdowns || {}

  if (config.kind === 'ticket-trend') {
    return {
      summary: [
        ['New tickets', formatCount(summary.tickets_created), 'Selected period'],
        ['Solved tickets', formatCount(summary.tickets_solved), 'Selected period'],
        ['Open backlog', formatCount(summary.backlog_open), 'As of period end'],
        ['Reopened tickets', formatCount(summary.reopened_tickets), 'Selected period']
      ],
      chart: {
        type: 'line',
        rows: trend,
        series: [
          { key: 'tickets_created', label: 'New tickets' },
          { key: 'tickets_solved', label: 'Solved tickets' }
        ]
      },
      breakdown: [],
      table: {
        columns: [
          ['report_date', 'Date', 'date'],
          ['tickets_created', 'New tickets', 'count'],
          ['tickets_solved', 'Solved tickets', 'count']
        ],
        rows: trend
      }
    }
  }

  if (config.kind === 'ticket-metric') {
    const mapping = {
      new_tickets: ['tickets_created', 'tickets_created'],
      solved_tickets: ['tickets_solved', 'tickets_solved'],
      unsolved_tickets: ['backlog_open', null]
    }
    const [summaryKey, trendKey] = mapping[config.metric]
    const chartRows = trendKey
      ? trend.map(row => ({ report_date: row.report_date, value: row[trendKey] }))
      : []

    return {
      summary: [
        [config.title, formatCount(summary[summaryKey]), config.metric === 'unsolved_tickets' ? 'As of period end' : 'Selected period'],
        ['Date range', formatCount(trend.length), 'Reporting days']
      ],
      chart: trendKey
        ? { type: 'line', rows: chartRows, series: [{ key: 'value', label: config.title }] }
        : { type: 'empty', message: 'Zendesk currently returns the selected end-of-period backlog, but not a daily backlog series.' },
      breakdown: [],
      table: {
        columns: trendKey
          ? [['report_date', 'Date', 'date'], ['value', config.title, 'count']]
          : [['metric', 'Metric', 'text'], ['value', 'Value', 'count']],
        rows: trendKey
          ? chartRows
          : [{ metric: config.title, value: summary[summaryKey] }]
      }
    }
  }

  if (config.kind === 'ticket-rate') {
    const solved = Number(summary.tickets_solved) || 0
    const reopened = Number(summary.reopened_tickets) || 0
    const rate = solved > 0 ? (reopened / solved) * 100 : 0

    return {
      summary: [
        ['Reopened rate', formatPercentValue(rate), 'Reopened divided by solved'],
        ['Reopened tickets', formatCount(reopened), 'Selected period'],
        ['Solved tickets', formatCount(solved), 'Selected period']
      ],
      chart: { type: 'empty', message: 'The filtered Zendesk result currently provides a period reopened rate rather than a daily reopened-rate series.' },
      breakdown: [],
      table: {
        columns: [['metric', 'Metric', 'text'], ['value', 'Value', 'text']],
        rows: [
          { metric: 'Reopened rate', value: formatPercentValue(rate) },
          { metric: 'Reopened tickets', value: formatCount(reopened) },
          { metric: 'Solved tickets', value: formatCount(solved) }
        ]
      }
    }
  }

  if (config.kind === 'agent') {
    const rows = (data.agents || []).map(row => ({
      agent_key: row.agent_key,
      agent_name: row.agent_name || row.agent_key,
      solved_tickets: Number(row.solved_tickets) || 0,
      open_tickets: Number(row.open_tickets) || 0
    }))
    const breakdown = rows.map(row => ({
      key: row.agent_key,
      label: row.agent_name,
      value: row.solved_tickets
    }))

    return {
      summary: [
        ['Team solved', formatCount(sum(rows, 'solved_tickets')), 'Selected period'],
        ['Open tickets', formatCount(sum(rows, 'open_tickets')), 'As of period end'],
        ['Agents', formatCount(rows.length), 'Matching filters']
      ],
      chart: { type: 'bar', rows: breakdown },
      breakdown,
      table: {
        columns: [
          ['agent_name', 'Agent', 'text'],
          ['solved_tickets', 'Solved', 'count'],
          ['open_tickets', 'Open', 'count']
        ],
        rows
      }
    }
  }

  const breakdownKey = config.kind === 'concern' ? 'driver' : config.dimension
  const rows = (breakdowns[breakdownKey] || []).map(row => ({
    key: row.key,
    label: row.label || row.key,
    value: Number(row.ticket_count) || 0
  }))
  const total = rows.reduce((value, row) => value + row.value, 0)

  return {
    summary: [
      ['Tickets', formatCount(total), 'Matching filters'],
      ['Categories', formatCount(rows.length), config.title],
      ['Leading category', rows[0]?.label || '—', rows[0] ? formatCount(rows[0].value) : 'No data']
    ],
    chart: { type: 'bar', rows },
    breakdown: rows,
    table: {
      columns: [
        ['label', config.kind === 'concern' ? 'Concern' : 'Category', 'text'],
        ['value', 'Tickets', 'count'],
        ['share', 'Share', 'percent']
      ],
      rows: rows.map(row => ({
        ...row,
        share: total > 0 ? (row.value / total) * 100 : 0
      }))
    }
  }
}

async function loadModel(config, state, source, range) {
  if (source === 'zendesk') {
    return zendeskModel(config, await loadZendesk(state, range))
  }

  if (config.kind === 'ticket-trend' || config.kind === 'ticket-metric' || config.kind === 'ticket-rate') {
    return ticketSheetModel(config, await loadTicketSheet(range), range)
  }
  if (config.kind === 'distribution') {
    return distributionSheetModel(config, await loadDistributionSheet(config, range))
  }
  if (config.kind === 'concern') {
    return concernSheetModel(await loadConcernSheet(range))
  }
  return agentSheetModel(await loadAgentSheet(range))
}

function setPageCopy(ui, config) {
  document.title = `${config.title} | SocialLoop CS Base`
  ui.title.textContent = config.title
  ui.subtitle.textContent = config.subtitle
  ui.chartTitle.textContent = config.chartTitle
  ui.chartSubtitle.textContent = config.chartSubtitle
  ui.tableTitle.textContent = config.tableTitle
}

function setSource(ui, source) {
  ui.source.dataset.source = source === 'zendesk' ? 'zendesk' : 'google_sheet'
  ui.source.textContent = source === 'zendesk'
    ? 'Source: Zendesk filtered data'
    : 'Source: Google Sheet daily snapshot'
}

function renderActiveFilters(ui, state, range, source) {
  ui.activeFilters.replaceChildren()
  const chips = [rangeLabel(range)]

  FILTER_KEYS.forEach(key => {
    if (state[key]) chips.push(`${key}: ${state[key]}`)
  })
  chips.push(source === 'zendesk' ? 'Zendesk' : 'Google Sheet')

  chips.forEach(text => {
    const chip = document.createElement('span')
    chip.textContent = text
    ui.activeFilters.appendChild(chip)
  })
}

function renderSummary(ui, rows) {
  ui.summary.replaceChildren()

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
    ui.summary.appendChild(card)
  })
}

function svgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name)
  Object.entries(attributes).forEach(([key, value]) => {
    element.setAttribute(key, String(value))
  })
  return element
}

function renderLineChart(ui, chart) {
  ui.chart.replaceChildren()
  const rows = chart.rows || []

  if (rows.length === 0) {
    renderEmptyChart(ui, 'No daily records match the selected date range.')
    return
  }

  const scroll = document.createElement('div')
  scroll.className = 'report-chart-scroll'
  const svg = svgElement('svg', {
    class: 'report-chart-svg',
    viewBox: '0 0 900 340',
    role: 'img',
    'aria-label': 'Detailed report trend chart'
  })
  const dimensions = {
    left: 62,
    top: 24,
    plotWidth: 806,
    plotHeight: 250
  }
  const values = rows.flatMap(row =>
    chart.series.map(series => Number(row[series.key]) || 0)
  )
  const maximum = Math.max(1, ...values)
  const niceMaximum = Math.ceil(maximum / 5) * 5 || 1

  for (let tick = 0; tick <= 5; tick += 1) {
    const ratio = tick / 5
    const y = dimensions.top + ratio * dimensions.plotHeight
    const value = niceMaximum * (1 - ratio)
    svg.appendChild(svgElement('line', {
      x1: dimensions.left,
      y1: y,
      x2: dimensions.left + dimensions.plotWidth,
      y2: y,
      class: 'report-chart-grid'
    }))
    const label = svgElement('text', {
      x: dimensions.left - 10,
      y: y + 4,
      'text-anchor': 'end',
      class: 'report-chart-label'
    })
    label.textContent = chart.percent
      ? formatPercentValue(value)
      : formatCount(Math.round(value))
    svg.appendChild(label)
  }

  svg.appendChild(svgElement('line', {
    x1: dimensions.left,
    y1: dimensions.top,
    x2: dimensions.left,
    y2: dimensions.top + dimensions.plotHeight,
    class: 'report-chart-axis'
  }))
  svg.appendChild(svgElement('line', {
    x1: dimensions.left,
    y1: dimensions.top + dimensions.plotHeight,
    x2: dimensions.left + dimensions.plotWidth,
    y2: dimensions.top + dimensions.plotHeight,
    class: 'report-chart-axis'
  }))

  chart.series.forEach((series, seriesIndex) => {
    const points = rows.map((row, index) => {
      const x = rows.length === 1
        ? dimensions.left + dimensions.plotWidth / 2
        : dimensions.left + (index / (rows.length - 1)) * dimensions.plotWidth
      const value = Number(row[series.key]) || 0
      const y = dimensions.top + dimensions.plotHeight -
        (value / niceMaximum) * dimensions.plotHeight
      return { x, y, value, row }
    })
    const path = points.map((point, index) =>
      `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`
    ).join(' ')
    svg.appendChild(svgElement('path', {
      d: path,
      class: seriesIndex === 0
        ? 'report-chart-line-primary'
        : 'report-chart-line-secondary'
    }))

    points.forEach(point => {
      const circle = svgElement('circle', {
        cx: point.x,
        cy: point.y,
        r: 3.5,
        class: seriesIndex === 0
          ? 'report-chart-point-primary'
          : 'report-chart-point-secondary'
      })
      const title = svgElement('title')
      title.textContent = `${formatDate(point.row.report_date)} — ${series.label}: ${chart.percent ? formatPercentValue(point.value) : formatCount(point.value)}`
      circle.appendChild(title)
      svg.appendChild(circle)
    })
  })

  const labelCount = Math.min(7, rows.length)
  const indexes = new Set()
  for (let index = 0; index < labelCount; index += 1) {
    indexes.add(labelCount === 1
      ? 0
      : Math.round((index / (labelCount - 1)) * (rows.length - 1)))
  }
  indexes.forEach(index => {
    const x = rows.length === 1
      ? dimensions.left + dimensions.plotWidth / 2
      : dimensions.left + (index / (rows.length - 1)) * dimensions.plotWidth
    const label = svgElement('text', {
      x,
      y: dimensions.top + dimensions.plotHeight + 28,
      'text-anchor': 'middle',
      class: 'report-chart-label'
    })
    label.textContent = formatDate(rows[index].report_date, true)
    svg.appendChild(label)
  })

  scroll.appendChild(svg)
  ui.chart.appendChild(scroll)
}

function renderBreakdownRows(container, rows) {
  container.replaceChildren()
  const maximum = Math.max(1, ...rows.map(row => Number(row.value) || 0))

  if (rows.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'report-chart-empty'
    empty.textContent = 'No categories match the selected filters.'
    container.appendChild(empty)
    return
  }

  rows.forEach(row => {
    const item = document.createElement('div')
    item.className = 'report-breakdown-row'
    const label = document.createElement('span')
    label.className = 'report-breakdown-label'
    label.textContent = row.label || row.key
    const track = document.createElement('span')
    track.className = 'report-breakdown-track'
    const bar = document.createElement('span')
    bar.className = 'report-breakdown-bar'
    bar.style.width = `${Math.max(0, Math.min(100, ((Number(row.value) || 0) / maximum) * 100))}%`
    track.appendChild(bar)
    const value = document.createElement('strong')
    value.className = 'report-breakdown-value'
    value.textContent = formatCount(row.value)
    item.append(label, track, value)
    container.appendChild(item)
  })
}

function renderEmptyChart(ui, message) {
  ui.chart.replaceChildren()
  const empty = document.createElement('div')
  empty.className = 'report-chart-empty'
  empty.textContent = message
  ui.chart.appendChild(empty)
}

function renderChart(ui, chart) {
  if (chart.type === 'line') {
    renderLineChart(ui, chart)
    return
  }
  if (chart.type === 'bar') {
    renderBreakdownRows(ui.chart, chart.rows || [])
    return
  }
  renderEmptyChart(ui, chart.message || 'No chart is available for this selection.')
}

function renderBreakdown(ui, rows, config) {
  if (!Array.isArray(rows) || rows.length === 0) {
    ui.breakdownSection.hidden = true
    ui.breakdown.replaceChildren()
    return
  }

  ui.breakdownSection.hidden = false
  ui.breakdownTitle.textContent = config.kind === 'agent'
    ? 'Agent ranking'
    : config.kind === 'concern'
      ? 'Concern breakdown'
      : 'Category breakdown'
  ui.breakdownSubtitle.textContent = 'Values are sorted from highest to lowest.'
  renderBreakdownRows(ui.breakdown, rows)
}

function formatCell(value, type) {
  if (type === 'date') return formatDate(value)
  if (type === 'count') return formatCount(value)
  if (type === 'percent') return formatPercentValue(value)
  if (type === 'minutes') return formatMinutes(value)
  return value === null || value === undefined || value === '' ? '—' : String(value)
}

function renderTable(ui, table) {
  ui.tableHead.replaceChildren()
  ui.tableBody.replaceChildren()
  const headerRow = document.createElement('tr')

  table.columns.forEach(([, label]) => {
    const th = document.createElement('th')
    th.scope = 'col'
    th.textContent = label
    headerRow.appendChild(th)
  })
  ui.tableHead.appendChild(headerRow)

  table.rows.forEach(row => {
    const tr = document.createElement('tr')
    table.columns.forEach(([key, , type]) => {
      const td = document.createElement('td')
      td.textContent = formatCell(row[key], type)
      tr.appendChild(td)
    })
    ui.tableBody.appendChild(tr)
  })

  ui.tableMeta.textContent = `${formatCount(table.rows.length)} record${table.rows.length === 1 ? '' : 's'}`
  ui.tableCaption.textContent = table.rows.length
    ? 'Detailed data for the selected report filters.'
    : 'No detailed data matches the selected report filters.'
}

function populateSelect(select, rows, selected) {
  if (!select) return
  const first = select.options[0]
  select.replaceChildren(first)

  ;(rows || []).forEach(row => {
    const option = document.createElement('option')
    option.value = row.key
    option.textContent = row.label || row.key
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

function populateOptions(ui, options, state) {
  FILTER_KEYS.forEach(key => {
    const select = ui.form.elements[key]
    populateSelect(select, options?.[key] || [], state[key])
  })
}

async function loadOptions(range, state) {
  try {
    const blankState = {
      ...state,
      ...Object.fromEntries(FILTER_KEYS.map(key => [key, '']))
    }
    const data = await loadZendesk(blankState, range)
    return data.options || {}
  } catch (error) {
    console.warn('Unable to load Zendesk filter options:', error)
    return {}
  }
}

function initializeFilterForm(ui, request, range) {
  const { config, state, reportKey } = request
  ui.range.value = state.range
  ui.start.value = state.start
  ui.end.value = state.end
  FILTER_KEYS.forEach(key => {
    ui.form.elements[key].value = state[key] || ''
  })

  if (!config.supportsZendesk) {
    document.querySelectorAll('[data-dimension-filter]').forEach(field => {
      field.hidden = true
    })
  }

  const updateCustomDates = () => {
    const custom = ui.range.value === 'custom'
    document.querySelectorAll('[data-custom-date]').forEach(field => {
      field.hidden = !custom
    })
    ui.start.required = custom
    ui.end.required = custom
  }

  updateCustomDates()
  ui.range.addEventListener('change', updateCustomDates)

  ui.form.addEventListener('submit', event => {
    event.preventDefault()
    const data = new FormData(ui.form)
    const nextState = {
      range: String(data.get('range') || config.defaultRange),
      start: String(data.get('start') || ''),
      end: String(data.get('end') || ''),
      ...Object.fromEntries(FILTER_KEYS.map(key => [key, normalize(data.get(key))]))
    }

    if (nextState.range === 'custom') {
      if (!isIsoDate(nextState.start) || !isIsoDate(nextState.end)) {
        ui.validation.textContent = 'Choose both a valid start date and end date.'
        return
      }
      if (nextState.start > nextState.end) {
        ui.validation.textContent = 'The start date cannot be after the end date.'
        return
      }
    }

    const params = new URLSearchParams({
      report: reportKey,
      range: nextState.range
    })
    if (nextState.range === 'custom') {
      params.set('start', nextState.start)
      params.set('end', nextState.end)
    }
    if (config.supportsZendesk) {
      FILTER_KEYS.forEach(key => {
        if (nextState[key]) params.set(key, nextState[key])
      })
    }

    window.location.assign(`./report-details.html?${params.toString()}`)
  })

  ui.reset.addEventListener('click', () => {
    const params = new URLSearchParams({
      report: reportKey,
      range: config.defaultRange
    })
    window.location.assign(`./report-details.html?${params.toString()}`)
  })

  ui.rangeSummary.textContent = rangeLabel(range)
}

function showError(ui, error) {
  ui.page.setAttribute('aria-busy', 'false')
  ui.content.hidden = true
  ui.status.hidden = false
  ui.status.innerHTML = ''
  const heading = document.createElement('h2')
  heading.textContent = 'Report unavailable'
  const paragraph = document.createElement('p')
  paragraph.textContent = error?.message || 'The report could not be loaded.'
  ui.status.append(heading, paragraph)
  ui.source.dataset.source = 'error'
  ui.source.textContent = 'Source unavailable'
}

async function initialize() {
  const ui = elements()
  ui.logout.addEventListener('click', async event => {
    event.preventDefault()
    await supabase.auth.signOut()
    window.location.href = './login.html'
  })

  try {
    const request = parseRequest()
    setPageCopy(ui, request.config)

    const user = await requireApprovedUser()
    if (!user) return

    const source = selectSource(request.config, request.state)
    const anchorDate = source === 'zendesk'
      ? todayInEastern()
      : await latestSheetDate(request.config)
    const range = resolveRange(request.state, anchorDate)

    initializeFilterForm(ui, request, range)
    setSource(ui, source)
    renderActiveFilters(ui, request.state, range, source)

    const model = await loadModel(
      request.config,
      request.state,
      source,
      range
    )

    renderSummary(ui, model.summary)
    renderChart(ui, model.chart)
    renderBreakdown(ui, model.breakdown, request.config)
    renderTable(ui, model.table)
    ui.dataBadge.textContent = rangeLabel(range)

    const options = source === 'zendesk'
      ? (await loadZendesk(request.state, range)).options || {}
      : await loadOptions(range, request.state)
    populateOptions(ui, options, request.state)

    ui.status.hidden = true
    ui.content.hidden = false
    ui.page.setAttribute('aria-busy', 'false')
  } catch (error) {
    console.error('Unable to initialize report details:', error)
    showError(ui, error)
  }
}

initialize()
