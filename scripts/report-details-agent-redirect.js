(() => {
  const currentUrl = new URL(window.location.href)
  const disabledFilterKeys = [
    'app',
    'platform',
    'country',
    'driver',
    'agent',
    'priority',
    'channel',
    'source'
  ]
  let changed = false

  disabledFilterKeys.forEach(key => {
    if (currentUrl.searchParams.has(key)) {
      currentUrl.searchParams.delete(key)
      changed = true
    }
  })

  if (changed) {
    window.history.replaceState({}, '', currentUrl.toString())
  }

  const style = document.createElement('style')
  style.textContent = '[data-dimension-filter], #reportSourceBadge { display: none !important; }'
  document.head.appendChild(style)

  document.write('<script type="module" src="./scripts/reporting-source-cutover.js?v=1"><\\/script>')

  window.addEventListener('DOMContentLoaded', () => {
    const filterCopy = document.querySelector('.report-filter-heading p')
    if (filterCopy) {
      filterCopy.textContent = 'All report values use the synchronized Google Sheet dataset.'
    }

    const loadingCopy = document.querySelector('#reportStatus p')
    if (loadingCopy) {
      loadingCopy.textContent = 'Checking access and retrieving the requested Google Sheet reporting data.'
    }

    const footer = document.querySelector('.footer-note')
    if (footer) {
      footer.textContent = 'All dashboard and report-detail values use the synchronized Google Sheet snapshot.'
    }
  })
})()
