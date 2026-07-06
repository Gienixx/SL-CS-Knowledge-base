const DASHBOARD_SYNC_TRIGGER = Object.freeze({
  currentHandler: 'syncAllDashboardData',
  legacyHandler: 'syncDashboardData',
  timezone: 'America/New_York',
  hour: 9,
  minute: 0
})

function migrateDashboardSyncTrigger() {
  const lock = LockService.getScriptLock()
  lock.waitLock(30000)

  try {
    const removedTriggers = []

    ScriptApp.getProjectTriggers().forEach(trigger => {
      const handler = trigger.getHandlerFunction()

      if (
        handler !== DASHBOARD_SYNC_TRIGGER.currentHandler &&
        handler !== DASHBOARD_SYNC_TRIGGER.legacyHandler
      ) {
        return
      }

      removedTriggers.push({
        handler,
        triggerId: trigger.getUniqueId()
      })
      ScriptApp.deleteTrigger(trigger)
    })

    const createdTrigger = ScriptApp
      .newTrigger(DASHBOARD_SYNC_TRIGGER.currentHandler)
      .timeBased()
      .atHour(DASHBOARD_SYNC_TRIGGER.hour)
      .nearMinute(DASHBOARD_SYNC_TRIGGER.minute)
      .everyDays(1)
      .inTimezone(DASHBOARD_SYNC_TRIGGER.timezone)
      .create()

    const result = inspectDashboardSyncTriggers()
    result.removedTriggers = removedTriggers
    result.createdTriggerId = createdTrigger.getUniqueId()

    console.log(JSON.stringify(result, null, 2))
    return result
  } finally {
    lock.releaseLock()
  }
}

function inspectDashboardSyncTriggers() {
  const matchingTriggers = ScriptApp.getProjectTriggers()
    .filter(trigger => {
      const handler = trigger.getHandlerFunction()
      return (
        handler === DASHBOARD_SYNC_TRIGGER.currentHandler ||
        handler === DASHBOARD_SYNC_TRIGGER.legacyHandler
      )
    })
    .map(trigger => ({
      handler: trigger.getHandlerFunction(),
      eventType: String(trigger.getEventType()),
      source: String(trigger.getTriggerSource()),
      triggerId: trigger.getUniqueId()
    }))

  const currentTriggerCount = matchingTriggers.filter(
    trigger => trigger.handler === DASHBOARD_SYNC_TRIGGER.currentHandler
  ).length
  const legacyTriggerCount = matchingTriggers.filter(
    trigger => trigger.handler === DASHBOARD_SYNC_TRIGGER.legacyHandler
  ).length

  const result = {
    valid: currentTriggerCount === 1 && legacyTriggerCount === 0,
    expected: {
      handler: DASHBOARD_SYNC_TRIGGER.currentHandler,
      frequency: 'daily',
      approximateTime: '9:00 AM Eastern',
      timezone: DASHBOARD_SYNC_TRIGGER.timezone
    },
    currentTriggerCount,
    legacyTriggerCount,
    matchingTriggers
  }

  console.log(JSON.stringify(result, null, 2))
  return result
}

function testDashboardSyncV2Now() {
  if (typeof syncAllDashboardData !== 'function') {
    throw new Error(
      'syncAllDashboardData is not defined in this Apps Script project.'
    )
  }

  const result = syncAllDashboardData()
  console.log(JSON.stringify(result || null, null, 2))
  return result
}
