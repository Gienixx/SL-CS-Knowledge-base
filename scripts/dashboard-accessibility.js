const LOADING_TEXT = /^(loading|retrieving|checking)/i
const UNAVAILABLE_TEXT = /^(unavailable|unable|data unavailable)/i

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
    setHidden(
      driverSummary,
      LOADING_TEXT.test(badgeText) || UNAVAILABLE_TEXT.test(badgeText)
    )
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

    setHidden(
      productivitySummary,
      LOADING_TEXT.test(badgeText) ||
        UNAVAILABLE_TEXT.test(badgeText) ||
        hasPlaceholder
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

function improveLinkedElement(element, label) {
  if (!element || element.getAttribute('role') !== 'link') return

  if (label && element.getAttribute('aria-label') !== label) {
    element.setAttribute('aria-label', label)
  }

  if (element instanceof SVGElement) {
    element.setAttribute('focusable', 'true')
  }
}

function enhanceDriverChart() {
  const legendRows = [...document.querySelectorAll('.driver-legend-row')]
  const slices = [...document.querySelectorAll('.driver-pie-slice')]
  const descriptions = []

  legendRows.forEach((row, index) => {
    const label = text(row.querySelector('.driver-legend-label'))
    const values = text(row.querySelector('.driver-legend-values'))
    if (!label) return

    const description = `${label}, ${values}`
    const actionLabel = `Open ${label} ticket driver details. ${values}`
    improveLinkedElement(row, actionLabel)
    improveLinkedElement(slices[index], actionLabel)
    descriptions.push(description)
  })

  const svg = document.querySelector('.driver-pie')
  const hasLinks = slices.some(slice => slice.getAttribute('role') === 'link')

  if (svg && hasLinks) {
    svg.setAttribute('role', 'group')
    svg.setAttribute(
      'aria-label',
      `Interactive ticket driver distribution. ${descriptions.join('. ')}`
    )
  }
}

function enhanceDistributionChart(type) {
  const container = document.getElementById(`${type}DistributionChart`)
  if (!container) return

  const legendRows = [...container.querySelectorAll(
    '.distribution-legend-row'
  )]
  const slices = [...container.querySelectorAll('.distribution-pie-slice')]
  const descriptions = []

  legendRows.forEach((row, index) => {
    const label = text(row.querySelector('.distribution-legend-label'))
    const values = text(row.querySelector('.distribution-legend-values'))
    if (!label) return

    const description = `${label}, ${values}`
    const actionLabel = `Open ${label} ${type} details. ${values}`
    improveLinkedElement(row, actionLabel)
    improveLinkedElement(slices[index], actionLabel)
    descriptions.push(description)
  })

  const svg = container.querySelector('.distribution-pie')
  const hasLinks = slices.some(slice => slice.getAttribute('role') === 'link')

  if (svg && hasLinks) {
    svg.setAttribute('role', 'group')
    svg.setAttribute(
      'aria-label',
      `Interactive ${type} ticket distribution. ${descriptions.join('. ')}`
    )
  }
}

function enhanceProductivityRows() {
  document.querySelectorAll('.productivity-row[role="link"]')
    .forEach(row => {
      const current = row.getAttribute('aria-label') || ''
      if (!/open agent details/i.test(current)) {
        row.setAttribute('aria-label', `${current}. Open agent details.`)
      }
    })
}

function improveTicketChartLabel() {
  const chart = document.getElementById('ticketVolumeChart')
  if (!chart) return

  const period = text(document.getElementById('chartPeriodBadge'))
  const latestDate = text(document.getElementById('latestReportDate'))
  const details = []

  if (period && !LOADING_TEXT.test(period)) details.push(period)
  if (latestDate && !LOADING_TEXT.test(latestDate)) {
    details.push(`through ${latestDate}`)
  }

  chart.setAttribute(
    'aria-label',
    `New and solved ticket volume${details.length ? ` for ${details.join(' ')}` : ''}.`
  )
}

function runAuditEnhancements() {
  updateLoadingVisibility()
  enhanceDriverChart()
  enhanceDistributionChart('app')
  enhanceDistributionChart('platform')
  enhanceDistributionChart('country')
  enhanceProductivityRows()
  improveTicketChartLabel()
}

const observer = new MutationObserver(runAuditEnhancements)
observer.observe(document.documentElement, {
  childList: true,
  characterData: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['class', 'role', 'data-status']
})

runAuditEnhancements()
document.addEventListener('DOMContentLoaded', runAuditEnhancements)
