(() => {
  const currentUrl = new URL(window.location.href)
  if (currentUrl.searchParams.get('report') !== 'agent-productivity') return

  const destination = new URL('./agent-analytics.html', currentUrl)
  destination.search = currentUrl.search
  destination.hash = currentUrl.hash
  destination.searchParams.delete('report')

  if (destination.searchParams.get('range') === 'latest') {
    destination.searchParams.set('range', '30d')
  }

  for (const key of ['app', 'platform', 'country', 'driver', 'priority', 'channel']) {
    destination.searchParams.delete(key)
  }

  window.location.replace(destination.toString())
})()
