function ensureLatestDayDateStyles() {
  if (document.getElementById('dashboardLatestDateStyles')) return

  const stylesheet = document.createElement('link')
  stylesheet.id = 'dashboardLatestDateStyles'
  stylesheet.rel = 'stylesheet'
  stylesheet.href = './dashboard-latest-date.css?v=1'
  document.head.appendChild(stylesheet)
}

function syncLatestDayDate(source, target) {
  const value = source?.textContent?.trim()
  target.textContent = value || 'Loading...'
}

function installLatestDayDateSection() {
  const summaryContent = document.querySelector(
    '.phase-one-summary .section-content'
  )
  const sourceDate = document.getElementById('latestReportDate')

  if (!summaryContent || !sourceDate) return false

  let section = document.getElementById('latestDayDataDateSection')

  if (!section) {
    section = document.createElement('aside')
    section.id = 'latestDayDataDateSection'
    section.className = 'latest-day-data-date'
    section.setAttribute('aria-label', 'Current data date')
    section.innerHTML = `
      <span class="latest-day-data-date-label">Current data date</span>
      <strong id="latestDayDataDate">Loading...</strong>
    `

    const statusBar = summaryContent.querySelector('.dashboard-status-bar')

    if (statusBar) {
      statusBar.insertAdjacentElement('afterend', section)
    } else {
      summaryContent.prepend(section)
    }
  }

  const targetDate = document.getElementById('latestDayDataDate')
  syncLatestDayDate(sourceDate, targetDate)

  if (!sourceDate.dataset.latestDayDateObserved) {
    const observer = new MutationObserver(() => {
      syncLatestDayDate(sourceDate, targetDate)
    })

    observer.observe(sourceDate, {
      childList: true,
      characterData: true,
      subtree: true
    })
    sourceDate.dataset.latestDayDateObserved = 'true'
  }

  return true
}

function initializeLatestDayDateSection() {
  ensureLatestDayDateStyles()

  if (installLatestDayDateSection()) return

  const board = document.querySelector('.dashboard-board')
  if (!board) return

  const observer = new MutationObserver(() => {
    if (installLatestDayDateSection()) {
      observer.disconnect()
    }
  })

  observer.observe(board, {
    childList: true,
    subtree: true
  })
}

document.addEventListener(
  'DOMContentLoaded',
  initializeLatestDayDateSection
)
