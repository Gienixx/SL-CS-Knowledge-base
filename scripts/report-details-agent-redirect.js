(() => {
  const url = new URL(window.location.href)
  if (url.searchParams.get('report') !== 'agent-productivity') return

  url.pathname = url.pathname.replace(/report-details\.html$/, 'agent-analytics.html')
  url.searchParams.delete('report')

  if (url.searchParams.get('range') === 'latest') {
    url.searchParams.set('range', '30d')
  }

  for (const key of ['app', 'platform', 'country', 'driver', 'priority', 'channel']) {
    url.searchParams.delete(key)
  }

  window.location.replace(url.toString())
})()
