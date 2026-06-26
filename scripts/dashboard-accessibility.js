import { supabase } from './supabaseClient.js?v=8'

const LOADING_TEXT = /^(loading|retrieving|checking)/i
const UNAVAILABLE_TEXT = /^(unavailable|unable|data unavailable)/i

function detailUrl(view, parameter, key) {
  return `./data-details.html?view=${encodeURIComponent(view)}` +
    `&${encodeURIComponent(parameter)}=${encodeURIComponent(key)}`
}

function activateOnKeyboard(element, url) {
  if (!element || !url || element.dataset.detailEnhanced === 'true') {
    return
  }

  element.dataset.detailEnhanced = 'true'
  element.setAttribute('role', 'link')
  element.setAttribute('tabindex', '0')

  if (element instanceof SVGElement) {
    element.setAttribute('focusable', 'true')
  }

  element.addEventListener('click', () => {
    window.location.href = url
  })

  element.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    window.location.href = url
  })
}

function text(element) {
  return element?.textContent?.trim() || ''
}

function setHidden(element, hidden) {
  if (!element) return
  element.hidden = hidden
  element.setAttribute('aria-hidden', hidden ? 'true' : 'false')
}

function updateLoadingVisibility() {
  const kpiGrid = document.querySelector('.kpi-grid')
  const dashboardStatus = document.getElementById('dashboardDataStatus')

  if (kpiGrid && dashboardStatus) {
    const status = dashboardStatus.dataset.status

    if (status === 'empty') {
      document.querySelectorAll('.kpi-grid .metric-value > span:last-child')
        .forEach(value => {
          if (text(value) === '—') value.textContent = 'No data'
        })
    }

    setHidden(kpiGrid, status !== 'ready' && status !== 'empty')
  }

  const driverSummary = document.querySelector('.driver-summary-grid')
  const driverBadge = document.getElementById('driverDateBadge')
  const driverChart = document.getElementById('ticketDriverChart')

  if (driverSummary && driverBadge) {
    const badgeText = text(driverBadge)
    const loading = LOADING_TEXT.test(badgeText)
    const unavailable = UNAVAILABLE_TEXT.test(badgeText)
    setHidden(driverSummary, loading || unavailable)
  }

  if (driverChart) {
    const stateText = text(driverChart.querySelector('.driver-state'))
    driverChart.setAttribute(
      'aria-busy',
      LOADING_TEXT.test(stateText) ? 'true' : 'false'
    )
  }

  const productivitySummary = document.querySelector(
    '.productivity-summary-grid'
  )
  const productivityBadge = document.getElementById('productivityDateBadge')
  const productivityChart = document.getElementById('productivityChart')

  if (productivitySummary && productivityBadge) {
    const badgeText = text(productivityBadge)
    const values = [...productivitySummary.querySelectorAll('strong')]
    const hasPlaceholder = values.some(value => text(value) === '—')
    const loading = LOADING_TEXT.test(badgeText)
    const unavailable = UNAVAILABLE_TEXT.test(badgeText)
    setHidden(
      productivitySummary,
      loading || unavailable || hasPlaceholder
    )
  }

  if (productivityChart) {
    const stateText = text(
      productivityChart.querySelector('.productivity-state')
    )
    productivityChart.setAttribute(
      'aria-busy',
      LOADING_TEXT.test(stateText) ? 'true' : 'false'
    )
  }

  document.querySelectorAll('.distribution-chart').forEach(chart => {
    const stateText = text(chart.querySelector('.distribution-state'))
    chart.setAttribute(
      'aria-busy',
      LOADING_TEXT.test(stateText) ? 'true' : 'false'
    )
  })
}

function installLoadingObserver() {
  const observer = new MutationObserver(updateLoadingVisibility)
  observer.observe(document.documentElement, {
    childList: true,
    characterData: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-status']
  })
  updateLoadingVisibility()
}

async function latestRows(tableName, columns) {
  const latest = await supabase
    .from(tableName)
    .select('report_date')
    .order('report_date', { ascending: false })
    .limit(1)

  if (latest.error) throw latest.error

  const latestDate = latest.data?.[0]?.report_date
  if (!latestDate) return []

  const result = await supabase
    .from(tableName)
    .select(columns)
    .eq('report_date', latestDate)

  if (result.error) throw result.error
  return Array.isArray(result.data) ? result.data : []
}

function waitForSettledDashboard(timeout = 15000) {
  return new Promise(resolve => {
    const board = document.querySelector('.dashboard-board')

    if (!board || board.getAttribute('aria-busy') === 'false') {
      resolve()
      return
    }

    const observer = new MutationObserver(() => {
      if (board.getAttribute('aria-busy') !== 'false') return
      window.clearTimeout(timeoutId)
      observer.disconnect()
      resolve()
    })

    observer.observe(board, {
      attributes: true,
      attributeFilter: ['aria-busy']
    })

    const timeoutId = window.setTimeout(() => {
      observer.disconnect()
      resolve()
    }, timeout)
  })
}

function buildDriverMap(rows) {
  const labels = new Map()
  rows.forEach(row => {
    const label = String(row.driver_group_label || '').trim()
    const key = String(row.driver_group_key || '').trim()
    if (label && key && !labels.has(label)) labels.set(label, key)
  })
  return labels
}

async function enhanceDriverNavigation() {
  const rows = await latestRows(
    'ticket_driver_metrics',
    'driver_group_key, driver_group_label'
  )
  const labelMap = buildDriverMap(rows)
  const legendRows = [...document.querySelectorAll('.driver-legend-row')]
  const slices = [...document.querySelectorAll('.driver-pie-slice')]
  const labels = []

  legendRows.forEach((row, index) => {
    const label = text(row.querySelector('.driver-legend-label'))
    const key = labelMap.get(label)
    if (!key) return

    const url = detailUrl('driver', 'group', key)
    const values = text(row.querySelector('.driver-legend-values'))
    const accessibleLabel = `Open ${label} ticket driver details. ${values}`
    row.setAttribute('aria-label', accessibleLabel)
    activateOnKeyboard(row, url)

    const slice = slices[index]
    if (slice) {
      slice.setAttribute('aria-label', accessibleLabel)
      activateOnKeyboard(slice, url)
    }

    labels.push(`${label}, ${values}`)
  })

  const svg = document.querySelector('.driver-pie')
  if (svg) {
    svg.setAttribute('role', 'group')
    svg.setAttribute(
      'aria-label',
      `Interactive ticket driver distribution. ${labels.join('. ')}`
    )
  }
}

async function enhanceDistributionNavigation() {
  const rows = await latestRows(
    'daily_distribution_metrics',
    'dimension_type, dimension_key, dimension_label'
  )

  for (const type of ['app', 'platform', 'country']) {
    const container = document.getElementById(`${type}DistributionChart`)
    if (!container) continue

    const labelMap = new Map()
    rows.filter(row => row.dimension_type === type).forEach(row => {
      const label = String(row.dimension_label || '').trim()
      const key = String(row.dimension_key || '').trim()
      if (label && key) labelMap.set(label, key)
    })

    const legendRows = [...container.querySelectorAll(
      '.distribution-legend-row'
    )]
    const slices = [...container.querySelectorAll(
      '.distribution-pie-slice'
    )]
    const labels = []

    legendRows.forEach((row, index) => {
      const label = text(row.querySelector('.distribution-legend-label'))
      const key = labelMap.get(label)
      if (!key) return

      const url = detailUrl(type, 'value', key)
      const values = text(row.querySelector('.distribution-legend-values'))
      const accessibleLabel =
        `Open ${label} ${type} details. ${values}`
      row.setAttribute('aria-label', accessibleLabel)
      activateOnKeyboard(row, url)

      const slice = slices[index]
      if (slice) {
        slice.setAttribute('aria-label', accessibleLabel)
        activateOnKeyboard(slice, url)
      }

      labels.push(`${label}, ${values}`)
    })

    const svg = container.querySelector('.distribution-pie')
    if (svg) {
      svg.setAttribute('role', 'group')
      svg.setAttribute(
        'aria-label',
        `Interactive ${type} ticket distribution. ${labels.join('. ')}`
      )
    }
  }
}

async function enhanceProductivityNavigation() {
  const rows = await latestRows(
    'agent_productivity',
    'agent_key, agent_name'
  )
  const agentMap = new Map()

  rows.forEach(row => {
    const name = String(row.agent_name || '').trim()
    const key = String(row.agent_key || '').trim()
    if (name && key) agentMap.set(name, key)
  })

  document.querySelectorAll('.productivity-row').forEach(row => {
    const name = text(row.querySelector('.productivity-agent-name'))
    const key = agentMap.get(name)
    if (!key) return

    const url = detailUrl('agent', 'agent', key)
    const existingLabel = row.getAttribute('aria-label') || name
    row.setAttribute('aria-label', `${existingLabel}. Open agent details.`)
    activateOnKeyboard(row, url)
  })
}

function improveTicketChartLabel() {
  const chart = document.getElementById('ticketVolumeChart')
  if (!chart) return

  const period = text(document.getElementById('chartPeriodBadge'))
  const latestDate = text(document.getElementById('latestReportDate'))
  const suffix = [period, latestDate]
    .filter(value => value && !LOADING_TEXT.test(value))
    .join(', through ')

  chart.setAttribute(
    'aria-label',
    `New and solved ticket volume${suffix ? ` for ${suffix}` : ''}.`
  )
}

async function initializeAccessibilityEnhancements() {
  await waitForSettledDashboard()
  improveTicketChartLabel()

  const results = await Promise.allSettled([
    enhanceDriverNavigation(),
    enhanceDistributionNavigation(),
    enhanceProductivityNavigation()
  ])

  results.forEach(result => {
    if (result.status === 'rejected') {
      console.error('Dashboard accessibility enhancement failed:', result.reason)
    }
  })

  updateLoadingVisibility()
}

installLoadingObserver()

document.addEventListener('DOMContentLoaded', () => {
  initializeAccessibilityEnhancements()
})
