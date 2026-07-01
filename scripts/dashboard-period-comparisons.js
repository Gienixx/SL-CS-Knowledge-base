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

let comparisonRequest = 0

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
      detail: detail || 'The comparison RPC is missing from the PostgREST schema cache.'
    }
  }

  if (code === '42501' || normalized.includes('permission denied')) {
    return {
      label: 'Comparison permission denied',
      detail: detail || 'The authenticated role cannot execute the comparison RPC.'
    }
  }

  return {
    label: 'Comparison unavailable',
    detail: detail || 'The comparison RPC request failed.'
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

function comparisonParameters(state, data) {
  const range = data?.range || {}

  return {
    p_start_date: range.startDate,
    p_end_date: range.endDate,
    p_app_key: state?.app || null,
    p_platform_key: state?.platform || null,
    p_country_key: state?.country || null,
    p_driver_key: state?.driver || null,
    p_agent_key: state?.agent || null,
    p_priority: state?.priority || null,
    p_channel: state?.channel || null,
    p_time_zone: range.timeZone || 'America/New_York',
    p_period_kind: state?.range || 'auto'
  }
}

async function loadPeriodComparison(detail) {
  const requestId = ++comparisonRequest
  const parameters = comparisonParameters(detail?.state, detail?.data)

  if (!parameters.p_start_date || !parameters.p_end_date) {
    renderUnavailable('Comparison unavailable')
    return null
  }

  renderLoading()

  const { data, error } = await supabase.rpc(
    'get_dashboard_period_comparison',
    parameters
  )

  if (requestId !== comparisonRequest) return null
  if (error) throw error

  renderComparisons(data || {})
  window.dispatchEvent(new CustomEvent(
    'dashboard:period-comparison',
    { detail: data || {} }
  ))

  return data
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
