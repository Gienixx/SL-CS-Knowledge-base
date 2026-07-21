const clockFormatters = new Map()

function formatterFor(timeZone) {
  if (!clockFormatters.has(timeZone)) {
    clockFormatters.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    }))
  }

  return clockFormatters.get(timeZone)
}

function updateLiveClocks() {
  const now = new Date()

  document.querySelectorAll('time[data-time-zone]').forEach(element => {
    element.textContent = formatterFor(element.dataset.timeZone).format(now)
    element.dateTime = now.toISOString()
  })
}

function scheduleClockUpdate() {
  updateLiveClocks()
  window.setTimeout(scheduleClockUpdate, 1000 - (Date.now() % 1000))
}

document.addEventListener('DOMContentLoaded', scheduleClockUpdate)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) updateLiveClocks()
})
