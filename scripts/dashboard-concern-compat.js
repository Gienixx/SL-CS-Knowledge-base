import { supabase } from './supabaseClient.js?v=8'

let agentDirectoryPromise = null

function normalizeIncomingConcernParameter() {
  const url = new URL(window.location.href)
  const concern = url.searchParams.get('concern')

  if (concern && !url.searchParams.has('driver')) {
    url.searchParams.set('driver', concern)
    url.searchParams.delete('concern')
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
  }
}

function exposeConcernParameter() {
  const url = new URL(window.location.href)
  const driver = url.searchParams.get('driver')

  if (!driver) return

  url.searchParams.set('concern', driver)
  url.searchParams.delete('driver')
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
}

function replaceConcernText(root) {
  if (!root) return

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes = []

  while (walker.nextNode()) nodes.push(walker.currentNode)

  for (const node of nodes) {
    const original = node.nodeValue
    const updated = original
      .replace(/\bTicket Drivers\b/g, 'Ticket Concerns')
      .replace(/\bTicket Driver\b/g, 'Ticket Concern')
      .replace(/\bDriver Groups\b/g, 'Concerns')
      .replace(/\bDriver Group\b/g, 'Concern')
      .replace(/\bLeading Driver\b/g, 'Leading Concern')
      .replace(/\bdriver groups\b/g, 'concerns')
      .replace(/\bdriver group\b/g, 'concern')
      .replace(/\bdriver:\s*/g, 'concern: ')

    if (updated !== original) node.nodeValue = updated
  }
}

function setTextIfChanged(element, value) {
  if (element && element.textContent !== value) {
    element.textContent = value
  }
}

function setAttributeIfChanged(element, name, value) {
  if (element && element.getAttribute(name) !== value) {
    element.setAttribute(name, value)
  }
}

function presentConcernUi() {
  const form = document.getElementById('dashboardFilterForm')
  const internalSelect = form?.elements?.driver

  if (internalSelect) {
    const label = internalSelect.closest('label')
    const caption = label?.querySelector('span')
    const allOption = internalSelect.querySelector('option[value=""]')

    setTextIfChanged(caption, 'Concern')
    setTextIfChanged(allOption, 'All concerns')
    setAttributeIfChanged(internalSelect, 'aria-label', 'Concern')
  }

  replaceConcernText(document.querySelector('.dashboard-global-filters'))

  const concernSection = document
    .getElementById('ticketDriverChart')
    ?.closest('.dashboard-section')
  replaceConcernText(concernSection)
}

function concernUiTargetsReady() {
  return Boolean(
    document.getElementById('dashboardFilterForm') &&
    document.getElementById('ticketDriverChart')
  )
}

function observeInitialConcernUi(timeout = 20000) {
  presentConcernUi()
  if (concernUiTargetsReady()) return

  const observer = new MutationObserver(() => {
    presentConcernUi()
    if (!concernUiTargetsReady()) return

    observer.disconnect()
    window.clearTimeout(timer)
  })

  observer.observe(document.body, {
    childList: true,
    subtree: true
  })

  const timer = window.setTimeout(() => {
    observer.disconnect()
    presentConcernUi()
  }, timeout)
}

function formatCount(value) {
  const number = Number(value)
  return Number.isFinite(number)
    ? new Intl.NumberFormat('en-US').format(number)
    : null
}

async function loadAgentDirectory() {
  if (!agentDirectoryPromise) {
    agentDirectoryPromise = supabase
      .from('zendesk_agent_directory')
      .select('agent_key, agent_name')
      .then(({ data, error }) => {
        if (error) throw error

        return new Map((Array.isArray(data) ? data : [])
          .filter(row => row?.agent_key && row?.agent_name)
          .map(row => [String(row.agent_key), String(row.agent_name)]))
      })
      .catch(error => {
        agentDirectoryPromise = null
        throw error
      })
  }

  return agentDirectoryPromise
}

function patchAgentFilterOptions(data, names) {
  const form = document.getElementById('dashboardFilterForm')
  const select = form?.elements?.agent
  const rows = Array.isArray(data?.options?.agent)
    ? data.options.agent
    : []

  for (const row of rows) {
    const resolvedName = names.get(String(row?.key || ''))
    if (!resolvedName) continue

    row.label = resolvedName
    const option = select?.querySelector(
      `option[value="${CSS.escape(String(row.key))}"]`
    )
    const ticketCount = formatCount(row.ticket_count)

    if (option) {
      option.textContent = ticketCount
        ? `${resolvedName} (${ticketCount})`
        : resolvedName
    }
  }
}

function patchAgentRows(data, names) {
  const rows = Array.isArray(data?.agents) ? data.agents : []
  const renderedRows = document.querySelectorAll('.global-filter-agent-row')

  rows.forEach((row, index) => {
    const resolvedName = names.get(String(row?.agent_key || ''))
    if (!resolvedName) return

    row.agent_name = resolvedName
    const renderedName = renderedRows[index]
      ?.querySelector('.global-filter-agent-name strong')
    setTextIfChanged(renderedName, resolvedName)
  })
}

function patchActiveAgentFilter(data, names) {
  const state = window.__slDashboardFilters?.getState?.()
  const agentKey = state?.agent
  const resolvedName = names.get(String(agentKey || ''))

  if (!resolvedName) return

  document.querySelectorAll('#dashboardActiveFilters span').forEach(chip => {
    if (chip.textContent?.startsWith('agent:')) {
      chip.textContent = `agent: ${resolvedName}`
    }
  })

  const row = (data?.options?.agent || []).find(option =>
    option?.key === agentKey
  )
  if (row) row.label = resolvedName
}

async function presentAgentNames(data) {
  const names = await loadAgentDirectory()
  if (names.size === 0) return

  patchAgentFilterOptions(data, names)
  patchAgentRows(data, names)
  patchActiveAgentFilter(data, names)
}

normalizeIncomingConcernParameter()

window.addEventListener('dashboard:filtered-data', event => {
  presentConcernUi()
  presentAgentNames(event.detail?.data).catch(error => {
    console.error('Unable to resolve Zendesk agent names:', error)
  })
})

window.addEventListener('dashboard:filters-changed', () => {
  exposeConcernParameter()
  presentConcernUi()
})

document.addEventListener('DOMContentLoaded', observeInitialConcernUi)
