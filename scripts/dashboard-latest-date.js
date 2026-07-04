function ensureLatestDayDateStyles() {
  if (document.getElementById('dashboardLatestDateStyles')) return

  const stylesheet = document.createElement('link')
  stylesheet.id = 'dashboardLatestDateStyles'
  stylesheet.rel = 'stylesheet'
  stylesheet.href = './styles/dashboard-latest-date.css?v=2'
  document.head.appendChild(stylesheet)
}

function syncLatestDayDate(source, target) {
  const value = source?.textContent?.trim()
  target.textContent = value || 'Loading...'
}

function installLatestDayDateSection() {
  const kpiGrid = document.querySelector('.phase-one-summary .kpi-grid')
  const sourceDate = document.getElementById('latestReportDate')

  if (!kpiGrid || !sourceDate) return false

  let section = document.getElementById('latestDayDataDateSection')

  if (!section) {
    section = document.createElement('section')
    section.id = 'latestDayDataDateSection'
    section.className = 'metric-card latest-day-data-date-card'
    section.setAttribute('aria-label', 'Current data date')
    section.innerHTML = `
      <h2>Current Data Date</h2>
      <div class="latest-day-data-date-value">
        <strong id="latestDayDataDate">Loading...</strong>
      </div>
      <p class="metric-caption">Latest synchronized reporting date</p>
    `

    kpiGrid.prepend(section)
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
