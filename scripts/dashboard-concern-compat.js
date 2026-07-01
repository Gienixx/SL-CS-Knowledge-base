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

normalizeIncomingConcernParameter()

window.addEventListener('dashboard:filtered-data', presentConcernUi)

window.addEventListener('dashboard:filters-changed', () => {
  exposeConcernParameter()
  presentConcernUi()
})

document.addEventListener('DOMContentLoaded', observeInitialConcernUi)
