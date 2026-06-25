import { supabase } from './supabaseClient.js?v=8'

const LINK_STYLE_ID = 'dashboardDrilldownStyles'
const COMPLETION_TIMEOUT_MS = 20000

const DISTRIBUTION_ORDER = Object.freeze({
  app: Object.freeze(['eureka', 'survey_pop', 'survey_spin']),
  platform: Object.freeze(['ios', 'android', 'web']),
  country: Object.freeze(['au', 'ca', 'fr', 'de', 'gb', 'us', 'unknown'])
})

const DISTRIBUTION_CONTAINERS = Object.freeze({
  app: 'appDistributionChart',
  platform: 'platformDistributionChart',
  country: 'countryDistributionChart'
})

function ensureDrilldownStyles() {
  if (document.getElementById(LINK_STYLE_ID)) return

  const style = document.createElement('style')
  style.id = LINK_STYLE_ID
  style.textContent = `
    .dashboard-detail-link {
      cursor: pointer;
    }

    .dashboard-detail-link:focus-visible {
      outline: 3px solid rgba(56, 47, 144, 0.34);
      outline-offset: 3px;
    }

    .productivity-row.dashboard-detail-link,
    .driver-legend-row.dashboard-detail-link,
    .distribution-legend-row.dashboard-detail-link {
      transition: border-color 160ms ease, background-color 160ms ease,
        box-shadow 160ms ease, transform 160ms ease;
    }

    .productivity-row.dashboard-detail-link:hover,
    .productivity-row.dashboard-detail-link:focus-visible,
    .driver-legend-row.dashboard-detail-link:hover,
    .driver-legend-row.dashboard-detail-link:focus-visible,
    .distribution-legend-row.dashboard-detail-link:hover,
    .distribution-legend-row.dashboard-detail-link:focus-visible {
      border-color: rgba(56, 47, 144, 0.28);
      background-color: #f7f6fc;
      box-shadow: 0 8px 18px rgba(29, 26, 52, 0.08);
      transform: translateY(-1px);
    }

    .driver-pie-slice.dashboard-detail-link:focus-visible,
    .distribution-pie-slice.dashboard-detail-link:focus-visible {
      outline: none;
      filter: drop-shadow(0 0 5px rgba(56, 47, 144, 0.55));
    }

    @media (prefers-reduced-motion: reduce) {
      .productivity-row.dashboard-detail-link,
      .driver-legend-row.dashboard-detail-link,
      .distribution-legend-row.dashboard-detail-link {
        transition: none;
      }
    }
  `
  document.head.appendChild(style)
}

function buildDetailUrl(view, key) {
  const parameterName = view === 'driver'
    ? 'group'
    : view === 'agent'
      ? 'agent'
      : 'value'
  const params = new URLSearchParams({
    view,
    [parameterName]: key
  })

  return `./data-details.html?${params.toString()}`
}

function makeDetailLink(element, view, key, label) {
  if (!element || !key) return false

  const url = buildDetailUrl(view, key)

  if (element.dataset.detailHref === url) return true

  element.dataset.detailHref = url
  element.classList.add('dashboard-detail-link')
  element.setAttribute('role', 'link')
  element.setAttribute('tabindex', '0')
  element.setAttribute('aria-label', label)

  const openDetail = () => {
    window.location.href = url
  }

  element.addEventListener('click', openDetail)
  element.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    openDetail()
  })

  return true
}

async function getLatestRows(tableName, selectColumns) {
  const latest = await supabase
    .from(tableName)
    .select('report_date')
    .order('report_date', { ascending: false })
    .limit(1)

  if (latest.error) throw latest.error

  const reportDate = latest.data?.[0]?.report_date
  if (!reportDate) return []

  const result = await supabase
    .from(tableName)
    .select(selectColumns)
    .eq('report_date', reportDate)

  if (result.error) throw result.error
  return Array.isArray(result.data) ? result.data : []
}

function prepareAgentRows(rows) {
  return [...rows].sort((first, second) => {
    const solvedDifference =
      (Number(second.solved_tickets) || 0) -
      (Number(first.solved_tickets) || 0)

    return solvedDifference ||
      String(first.agent_name).localeCompare(String(second.agent_name))
  })
}

function prepareDriverRows(rows) {
  const groups = new Map()

  rows.forEach(row => {
    const key = String(row.driver_group_key || '').trim()
    const tickets = Number(row.ticket_count)

    if (!key || !Number.isFinite(tickets) || tickets < 0) return

    const current = groups.get(key) || {
      key,
      label: row.driver_group_label || key,
      tickets: 0
    }

    current.tickets += tickets
    groups.set(key, current)
  })

  return [...groups.values()].sort((first, second) =>
    second.tickets - first.tickets ||
      String(first.label).localeCompare(String(second.label))
  )
}

function prepareDistributionRows(rows, type) {
  const order = DISTRIBUTION_ORDER[type] || []
  const indexes = new Map(order.map((key, index) => [key, index]))

  return rows
    .filter(row => row.dimension_type === type)
    .sort((first, second) => {
      const firstIndex = indexes.has(first.dimension_key)
        ? indexes.get(first.dimension_key)
        : Number.MAX_SAFE_INTEGER
      const secondIndex = indexes.has(second.dimension_key)
        ? indexes.get(second.dimension_key)
        : Number.MAX_SAFE_INTEGER

      return firstIndex - secondIndex ||
        String(first.dimension_label).localeCompare(
          String(second.dimension_label)
        )
    })
}

async function loadModels() {
  const [agentRows, driverRows, distributionRows] = await Promise.all([
    getLatestRows(
      'agent_productivity',
      'agent_key, agent_name, solved_tickets'
    ),
    getLatestRows(
      'ticket_driver_metrics',
      'driver_group_key, driver_group_label, ticket_count'
    ),
    getLatestRows(
      'daily_distribution_metrics',
      'dimension_type, dimension_key, dimension_label, ticket_count'
    )
  ])

  return {
    agents: prepareAgentRows(agentRows),
    drivers: prepareDriverRows(driverRows),
    distributions: {
      app: prepareDistributionRows(distributionRows, 'app'),
      platform: prepareDistributionRows(distributionRows, 'platform'),
      country: prepareDistributionRows(distributionRows, 'country')
    }
  }
}

function applyAgentLinks(rows) {
  const elements = [...document.querySelectorAll('.productivity-row')]

  elements.forEach((element, index) => {
    const row = rows[index]
    if (!row) return

    const name = row.agent_name || row.agent_key
    makeDetailLink(
      element,
      'agent',
      row.agent_key,
      `Open productivity details for ${name}`
    )
  })

  return elements.length >= rows.length
}

function applyDriverLinks(rows) {
  const legendRows = [...document.querySelectorAll('.driver-legend-row')]
  const pieSlices = [...document.querySelectorAll('.driver-pie-slice')]
  const positiveRows = rows.filter(row => row.tickets > 0)

  legendRows.forEach((element, index) => {
    const row = rows[index]
    if (!row) return

    makeDetailLink(
      element,
      'driver',
      row.key,
      `Open ticket driver details for ${row.label}`
    )
  })

  pieSlices.forEach((element, index) => {
    const row = positiveRows[index]
    if (!row) return

    makeDetailLink(
      element,
      'driver',
      row.key,
      `Open ticket driver details for ${row.label}`
    )
  })

  return legendRows.length >= rows.length &&
    pieSlices.length >= positiveRows.length
}

function applyDistributionLinks(type, rows) {
  const container = document.getElementById(DISTRIBUTION_CONTAINERS[type])
  if (!container) return rows.length === 0

  const legendRows = [...container.querySelectorAll('.distribution-legend-row')]
  const pieSlices = [...container.querySelectorAll('.distribution-pie-slice')]
  const positiveRows = rows.filter(row => (Number(row.ticket_count) || 0) > 0)

  legendRows.forEach((element, index) => {
    const row = rows[index]
    if (!row) return

    const label = row.dimension_label || row.dimension_key
    makeDetailLink(
      element,
      type,
      row.dimension_key,
      `Open ${type} ticket details for ${label}`
    )
  })

  pieSlices.forEach((element, index) => {
    const row = positiveRows[index]
    if (!row) return

    const label = row.dimension_label || row.dimension_key
    makeDetailLink(
      element,
      type,
      row.dimension_key,
      `Open ${type} ticket details for ${label}`
    )
  })

  return legendRows.length >= rows.length &&
    pieSlices.length >= positiveRows.length
}

function applyAllLinks(models) {
  return [
    applyAgentLinks(models.agents),
    applyDriverLinks(models.drivers),
    applyDistributionLinks('app', models.distributions.app),
    applyDistributionLinks('platform', models.distributions.platform),
    applyDistributionLinks('country', models.distributions.country)
  ].every(Boolean)
}

async function initializeDrilldowns() {
  ensureDrilldownStyles()

  const {
    data: { user },
    error: userError
  } = await supabase.auth.getUser()

  if (userError || !user) return

  const models = await loadModels()
  const board = document.querySelector('.dashboard-board')
  if (!board) return

  if (applyAllLinks(models)) return

  const observer = new MutationObserver(() => {
    if (!applyAllLinks(models)) return
    observer.disconnect()
    window.clearTimeout(timeoutId)
  })
  const timeoutId = window.setTimeout(() => {
    observer.disconnect()
    applyAllLinks(models)
  }, COMPLETION_TIMEOUT_MS)

  observer.observe(board, {
    childList: true,
    subtree: true
  })
}

document.addEventListener('DOMContentLoaded', () => {
  initializeDrilldowns().catch(error => {
    console.error('Unable to initialize dashboard drill-down links:', error)
  })
})
