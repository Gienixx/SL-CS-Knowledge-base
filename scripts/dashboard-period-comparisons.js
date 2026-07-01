import { supabase } from './supabaseClient.js?v=8'

const METRIC_CARDS = Object.freeze({
  tickets_created: {
    valueId: 'newTicketsValue',
    impact: 'neutral'
  },
  tickets_solved: {
    valueId: 'solvedTicketsValue',
    impact: 'higher'
  },
  backlog_open: {
    valueId: 'unsolvedTicketsValue',
    impact: 'lower'
  },
  backlog_over_24h: {
    valueId: 'oneTouchResolutionValue',
    impact: 'lower'
  },
  reopened_tickets: {
    valueId: 'reopenedRateValue',
    impact: 'lower'
  }
})

const METRIC_KEYS = Object.freeze([
  'tickets_created',
  'tickets_solved',
  'backlog_open',
  'backlog_over_24h',
  'backlog_over_48h',
  'first_response_minutes',
  'resolution_minutes',
  'reopened_tickets'
])

let comparisonRequest = 0
let inFlightSignature = null
let lastSuccessfulSignature = null

function parseDate(value) {
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isNaN(date.getTime()) ? null : date
}

function dateString(date) {
  return date.toISOString().slice(0, 10)
}

function addDays(value, amount) {
  const date = parseDate(value)
  if (!date) return null
  date.setUTCDate(date.getUTCDate() + amount)
  return dateString(date)
}

function addMonths(value, amount) {
  const date = parseDate(value)
  if (!date) return null
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() + amount)
  return dateString(date)
}

function firstDayOfMonth(value) {
  return `${String(value).slice(0, 7)}-01`
}

function lastDayOfMonth(value) {
  const nextMonth = addMonths(firstDayOfMonth(value), 1)
  return nextMonth ? addDays(nextMonth, -1) : null
}

function daysInclusive(startDate, endDate) {
  const start = parseDate(startDate)
  const end = parseDate(endDate)
  if (!start || !end) return 0
  return Math.floor((end - start) / 86400000) + 1
}

function isFullCalendarMonth(range) {
  return Boolean(
    range?.startDate &&
    range?.endDate &&
    range.startDate === firstDayOfMonth(range.startDate) &&
    range.endDate === lastDayOfMonth(range.startDate)
  )
}

function resolvePreviousRange(state, currentRange) {
  const startDate = currentRange?.startDate
  const endDate = currentRange?.endDate
  const timeZone = currentRange?.timeZone || 'America/New_York'

  if (!startDate || !endDate) return null

  if (state?.range === 'custom' && isFullCalendarMonth(currentRange)) {
    const previousStart = addMonths(startDate, -1)
    return {
      startDate: previousStart,
      endDate: addDays(startDate, -1),
      days: daysInclusive(previousStart, addDays(startDate, -1)),
      timeZone,
      periodKind: 'month'
    }
  }

  if (state?.range === 'mtd') {
    const previousStart = addMonths(firstDayOfMonth(startDate), -1)
    const previousMonthEnd = addDays(firstDayOfMonth(startDate), -1)
    const elapsedDays = daysInclusive(startDate, endDate) - 1
    const matchingEnd = addDays(previousStart, Math.max(0, elapsedDays))
    const previousEnd = matchingEnd > previousMonthEnd
      ? previousMonthEnd
      : matchingEnd

    return {
      startDate: previousStart,
      endDate: previousEnd,
      days: daysInclusive(previousStart, previousEnd),
      timeZone,
      periodKind: 'mtd'
    }
  }

  const days = daysInclusive(startDate, endDate)
  const previousEnd = addDays(startDate, -1)
  const previousStart = addDays(previousEnd, -(days - 1))

  return {
    startDate: previousStart,
    endDate: previousEnd,
    days,
    timeZone,
    periodKind: 'previous_period'
  }
}

function formatNumber(value) {
  const number = Number(value)
  return Number.isFinite(number)
    ? new Intl.NumberFormat('en-US', {
        maximumFractionDigits: 1
      }).format(number)
    : '—'
}

function formatPercent(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return null

  return `${new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 1,
    minimumFractionDigits: 0
  }).format(Math.abs(number))}%`
}

function formatDate(value) {
  if (!value) return 'unknown date'
  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return String(value)

  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(date)
}

function rangeLabel(range) {
  if (!range?.startDate || !range?.endDate) return 'previous period'
  if (range.startDate === range.endDate) return formatDate(range.startDate)
  return `${formatDate(range.startDate)} – ${formatDate(range.endDate)}`
}

function ensureComparisonElement(valueId) {
  const value = document.getElementById(valueId)
  const card = value?.closest('.metric-card')
  if (!card) return null

  let element = card.querySelector('.metric-comparison')
  if (!element) {
    element = document.createElement('div')
    element.className = 'metric-comparison'
    element.dataset.status = 'idle'
    element.setAttribute('aria-live', 'polite')
    card.appendChild(element)
  }

  return element
}

function comparisonImpact(metricConfig, direction) {
  if (!['increase', 'decrease'].includes(direction)) return 'neutral'
  if (metricConfig.impact === 'neutral') return 'neutral'

  const favorable = metricConfig.impact === 'higher'
    ? direction === 'increase'
    : direction === 'decrease'

  return favorable ? 'favorable' : 'unfavorable'
}

function numericMetric(summary, key) {
  const value = Number(summary?.[key])
  return Number.isFinite(value) ? value : null
}

function compareMetric(currentValue, previousValue) {
  if (currentValue === null || previousValue === null) {
    return {
      current: currentValue,
      previous: previousValue,
      absoluteChange: null,
      percentChange: null,
      direction: 'missing',
      zeroBaseline: previousValue === 0
    }
  }

  const absoluteChange = currentValue - previousValue
  const percentChange = previousValue === 0
    ? null
    : Math.round((absoluteChange / Math.abs(previousValue)) * 1000) / 10

  let direction = 'flat'
  if (previousValue === 0 && currentValue > 0) direction = 'new'
  else if (currentValue > previousValue) direction = 'increase'
  else if (currentValue < previousValue) direction = 'decrease'

  return {
    current: currentValue,
    previous: previousValue,
    absoluteChange,
    percentChange,
    direction,
    zeroBaseline: previousValue === 0
  }
}

function buildComparisonPayload(detail, previousData, previousRange) {
  const currentRange = detail?.data?.range || {}
  const currentSummary = detail?.data?.summary || {}
  const previousSummary = previousData?.summary || {}
  const metrics = Object.fromEntries(
    METRIC_KEYS.map(key => [
      key,
      compareMetric(
        numericMetric(currentSummary, key),
        numericMetric(previousSummary, key)
      )
    ])
  )

  return {
    periodKind: previousRange.periodKind,
    currentRange: {
      startDate: currentRange.startDate,
      endDate: currentRange.endDate,
      days: daysInclusive(currentRange.startDate, currentRange.endDate),
      timeZone: currentRange.timeZone || previousRange.timeZone
    },
    previousRange: {
      startDate: previousRange.startDate,
      endDate: previousRange.endDate,
      days: previousRange.days,
      timeZone: previousRange.timeZone
    },
    metrics
  }
}

function comparisonCopy(metric) {
  if (!metric || metric.direction === 'missing') {
    return {
      symbol: '—',
      text: 'No prior data'
    }
  }

  if (metric.zeroBaseline) {
    if (Number(metric.current) === 0) {
      return {
        symbol: '•',
        text: `No change · prev ${formatNumber(metric.previous)}`
      }
    }

    return {
      symbol: '↑',
      text: `New · prev ${formatNumber(metric.previous)}`
    }
  }

  if (metric.direction === 'flat') {
    return {
      symbol: '•',
      text: `0% · prev ${formatNumber(metric.previous)}`
    }
  }

  const percentage = formatPercent(metric.percentChange)
  const symbol = metric.direction === 'increase' ? '↑' : '↓'

  return {
    symbol,
    text: `${percentage || '—'} · prev ${formatNumber(metric.previous)}`
  }
}

function comparisonErrorPresentation(error) {
  const code = String(error?.code || '').toUpperCase()
  const message = String(error?.message || '')
  const detail = [code, message].filter(Boolean).join(': ')
  const normalized = `${code} ${message}`.toLowerCase()

  if (
    ['PGRST202', 'PGRST204', 'PGRST205'].includes(code) ||
    normalized.includes('schema cache') ||
    normalized.includes('could not find the function')
  ) {
    return {
      label: 'Reload Supabase schema',
      detail: detail || 'The filtered dashboard RPC is missing from the PostgREST schema cache.'
    }
  }

  if (code === '42501' || normalized.includes('permission denied')) {
    return {
      label: 'Comparison permission denied',
      detail: detail || 'The authenticated role cannot execute the filtered dashboard RPC.'
    }
  }

  if (code === '57014' || normalized.includes('statement timeout')) {
    return {
      label: 'Comparison timed out',
      detail: detail || 'The prior-period aggregation exceeded the database timeout.'
    }
  }

  return {
    label: 'Comparison unavailable',
    detail: detail || 'The prior-period dashboard request failed.'
  }
}

function renderLoading() {
  for (const config of Object.values(METRIC_CARDS)) {
    const element = ensureComparisonElement(config.valueId)
    if (!element) continue

    element.dataset.status = 'loading'
    element.dataset.impact = 'neutral'
    element.textContent = 'Comparing with prior period…'
    element.removeAttribute('title')
  }
}

function renderUnavailable(message = 'Comparison unavailable', detail = '') {
  for (const config of Object.values(METRIC_CARDS)) {
    const element = ensureComparisonElement(config.valueId)
    if (!element) continue

    element.dataset.status = 'error'
    element.dataset.impact = 'neutral'
    element.textContent = message
    if (detail) {
      element.title = detail
      element.setAttribute('aria-label', `${message}: ${detail}`)
    } else {
      element.removeAttribute('title')
      element.setAttribute('aria-label', message)
    }
  }
}

function renderComparisons(payload) {
  const previousRangeLabel = rangeLabel(payload?.previousRange)

  for (const [metricKey, config] of Object.entries(METRIC_CARDS)) {
    const element = ensureComparisonElement(config.valueId)
    if (!element) continue

    const metric = payload?.metrics?.[metricKey]
    const copy = comparisonCopy(metric)
    const impact = comparisonImpact(config, metric?.direction)

    element.dataset.status = metric?.direction === 'missing' ? 'empty' : 'ready'
    element.dataset.direction = metric?.direction || 'missing'
    element.dataset.impact = impact
    element.textContent = `${copy.symbol} ${copy.text}`
    element.title = `Compared with ${previousRangeLabel}`
    element.setAttribute(
      'aria-label',
      `${copy.text}, compared with ${previousRangeLabel}`
    )
  }
}

function previousRpcParameters(state, previousRange) {
  return {
    p_start_date: previousRange.startDate,
    p_end_date: previousRange.endDate,
    p_app_key: state?.app || null,
    p_platform_key: state?.platform || null,
    p_country_key: state?.country || null,
    p_driver_key: state?.driver || null,
    p_agent_key: state?.agent || null,
    p_priority: state?.priority || null,
    p_channel: state?.channel || null,
    p_time_zone: previousRange.timeZone || 'America/New_York'
  }
}

function comparisonSignature(detail, previousRange) {
  return JSON.stringify({
    state: detail?.state || {},
    currentRange: detail?.data?.range || {},
    currentSummary: detail?.data?.summary || {},
    previousRange
  })
}

async function loadPeriodComparison(detail) {
  const previousRange = resolvePreviousRange(detail?.state, detail?.data?.range)

  if (!previousRange?.startDate || !previousRange?.endDate) {
    renderUnavailable('Comparison unavailable')
    return null
  }

  const signature = comparisonSignature(detail, previousRange)
  if (signature === lastSuccessfulSignature || signature === inFlightSignature) {
    return null
  }

  const requestId = ++comparisonRequest
  inFlightSignature = signature
  renderLoading()

  try {
    const { data, error } = await supabase.rpc(
      'get_dashboard_filtered_data',
      previousRpcParameters(detail?.state, previousRange)
    )

    if (requestId !== comparisonRequest) return null
    if (error) throw error

    const payload = buildComparisonPayload(detail, data || {}, previousRange)
    renderComparisons(payload)
    lastSuccessfulSignature = signature

    window.dispatchEvent(new CustomEvent(
      'dashboard:period-comparison',
      { detail: payload }
    ))

    return payload
  } finally {
    if (inFlightSignature === signature) inFlightSignature = null
  }
}

window.addEventListener('dashboard:filtered-data', event => {
  loadPeriodComparison(event.detail).catch(error => {
    console.error('Unable to load dashboard period comparison:', error)
    const presentation = comparisonErrorPresentation(error)
    renderUnavailable(presentation.label, presentation.detail)
  })
})

window.__slDashboardPeriodComparisons = Object.freeze({
  refresh: () => window.__slDashboardFilters?.refresh?.()
})
