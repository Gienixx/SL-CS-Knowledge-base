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
})()
