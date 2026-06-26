import { supabase } from './supabaseClient.js?v=8'

const DATASETS = Object.freeze([
  Object.freeze({
    table: 'daily_ticket_metrics',
    label: 'Daily ticket metrics'
  }),
  Object.freeze({
    table: 'daily_distribution_metrics',
    label: 'App, platform, and country distributions'
  }),
  Object.freeze({
    table: 'agent_productivity',
    label: 'Agent productivity'
  }),
  Object.freeze({
    table: 'ticket_driver_metrics',
    label: 'Ticket drivers'
  })
])

function formatReportDate(value) {
  if (!value) return 'No data'

  const date = new Date(`${value}T00:00:00Z`)

  if (Number.isNaN(date.getTime())) {
    return String(value)
  }

  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(date)
}

async function getLatestDatasetDate(dataset) {
  const { data, error } = await supabase
    .from(dataset.table)
    .select('report_date')
    .order('report_date', { ascending: false })
    .limit(1)

  if (error) {
    return {
      ...dataset,
      date: null,
      error
    }
  }

  return {
    ...dataset,
    date: data?.[0]?.report_date || null,
    error: null
  }
}

function setDashboardStatus(status, text) {
  const statusElement = document.getElementById('dashboardDataStatus')

  if (!statusElement) return

  statusElement.dataset.status = status
  statusElement.textContent = text
}

function getOrCreateNotice() {
  let notice = document.getElementById('dashboardConsistencyNotice')

  if (notice) return notice

  const board = document.querySelector('.dashboard-board')

  if (!board) return null

  notice = document.createElement('section')
  notice.id = 'dashboardConsistencyNotice'
  notice.className = 'dashboard-consistency-notice'
  notice.setAttribute('role', 'status')
  notice.setAttribute('aria-live', 'polite')
  notice.hidden = true
  board.before(notice)

  return notice
}

function hideNotice() {
  const notice = document.getElementById('dashboardConsistencyNotice')

  if (!notice) return

  notice.hidden = true
  notice.replaceChildren()
}

function renderNotice(title, message, rows) {
  const notice = getOrCreateNotice()

  if (!notice) return

  notice.replaceChildren()
  notice.hidden = false

  const icon = document.createElement('span')
  icon.className = 'dashboard-consistency-icon'
  icon.setAttribute('aria-hidden', 'true')
  icon.textContent = '!'

  const copy = document.createElement('div')
  copy.className = 'dashboard-consistency-copy'

  const heading = document.createElement('strong')
  heading.textContent = title

  const description = document.createElement('p')
  description.textContent = message

  copy.append(heading, description)

  if (Array.isArray(rows) && rows.length > 0) {
    const list = document.createElement('ul')
    list.className = 'dashboard-consistency-list'

    rows.forEach(row => {
      const item = document.createElement('li')
      const label = document.createElement('span')
      label.textContent = row.label
      const date = document.createElement('strong')
      date.textContent = row.error
        ? 'Check unavailable'
        : formatReportDate(row.date)
      item.append(label, date)
      list.appendChild(item)
    })

    copy.appendChild(list)
  }

  notice.append(icon, copy)
}

function evaluateConsistency(results) {
  const failed = results.filter(result => result.error)

  if (failed.length > 0) {
    setDashboardStatus('warning', 'Date check unavailable')
    renderNotice(
      'Dashboard date verification is incomplete',
      'One or more reporting tables could not be checked. The visible dashboard data may still be available, but synchronization consistency could not be confirmed.',
      failed
    )
    return
  }

  const datedResults = results.filter(result => result.date)

  if (datedResults.length === 0) {
    setDashboardStatus('empty', 'No imported data')
    hideNotice()
    return
  }

  const newestDate = datedResults
    .map(result => result.date)
    .sort()
    .at(-1)
  const incomplete = results.filter(result => result.date !== newestDate)

  if (incomplete.length === 0) {
    setDashboardStatus('ready', 'All data current')
    hideNotice()
    return
  }

  setDashboardStatus('warning', 'Partial sync')
  renderNotice(
    'Some dashboard sections are not current',
    `The newest reporting date is ${formatReportDate(newestDate)}. The datasets listed below have not been updated through that date.`,
    incomplete
  )
}

function waitForDashboardReady(timeout = 15000) {
  return new Promise(resolve => {
    const isReady = () => {
      const board = document.querySelector('.dashboard-board')
      const status = document.getElementById('dashboardDataStatus')

      return Boolean(
        board &&
        status &&
        board.getAttribute('aria-busy') === 'false'
      )
    }

    if (isReady()) {
      resolve()
      return
    }

    const observer = new MutationObserver(() => {
      if (!isReady()) return
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

async function initializeDataConsistencyCheck() {
  const {
    data: { user },
    error: userError
  } = await supabase.auth.getUser()

  if (userError || !user) return

  const results = await Promise.all(
    DATASETS.map(getLatestDatasetDate)
  )

  await waitForDashboardReady()
  evaluateConsistency(results)
}

document.addEventListener('DOMContentLoaded', () => {
  initializeDataConsistencyCheck().catch(error => {
    console.error('Unable to verify dashboard reporting dates:', error)
  })
})
