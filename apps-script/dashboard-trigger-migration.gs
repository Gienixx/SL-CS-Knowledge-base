const DASHBOARD_SYNC_TRIGGER_TIMEZONE = 'America/New_York'

const DASHBOARD_SYNC_TRIGGER_SCHEDULES = Object.freeze([
  Object.freeze({
    handler: 'syncDashboardAt9AmEastern',
    hour: 9,
    minute: 0,
    approximateTime: '9:00 AM America/New_York'
  }),
  Object.freeze({
    handler: 'syncDashboardAtNoonEastern',
    hour: 12,
    minute: 0,
    approximateTime: '12:00 PM America/New_York'
  })
])

const RETIRED_DASHBOARD_SYNC_HANDLERS = Object.freeze([
  'syncDashboardAt9Pm',
  'syncDashboardAtMidnight',
  'syncAllDashboardData',
  'syncDashboardData'
])

function syncDashboardAt9AmEastern() {
  return runDashboardSyncTrigger_('syncDashboardAt9AmEastern')
}

function syncDashboardAtNoonEastern() {
  return runDashboardSyncTrigger_('syncDashboardAtNoonEastern')
}

function runDashboardSyncTrigger_(handler) {
  try {
    return syncAllDashboardData()
  } catch (error) {
    console.error(JSON.stringify({
      event: 'dashboard_sync_trigger_failed',
      handler: handler,
      timestamp: new Date().toISOString(),
      error: String(error && error.message ? error.message : error)
    }))
    throw error
  }
}

function getManagedDashboardSyncHandlers_() {
  return DASHBOARD_SYNC_TRIGGER_SCHEDULES
    .map(function (schedule) {
      return schedule.handler
    })
    .concat(RETIRED_DASHBOARD_SYNC_HANDLERS)
}

function migrateDashboardSyncTriggers() {
  const lock = LockService.getScriptLock()
  lock.waitLock(30000)

  try {
    const managedHandlers = getManagedDashboardSyncHandlers_()
    const retainedHandlers = {}
    const removedTriggers = []

    ScriptApp.getProjectTriggers().forEach(function (trigger) {
      const handler = trigger.getHandlerFunction()
      if (managedHandlers.indexOf(handler) === -1) return

      const isDesired = DASHBOARD_SYNC_TRIGGER_SCHEDULES.some(
        function (schedule) {
          return schedule.handler === handler
        }
      )

      if (isDesired && !retainedHandlers[handler]) {
        retainedHandlers[handler] = true
        return
      }

      removedTriggers.push({
        handler: handler,
        triggerId: trigger.getUniqueId()
      })
      ScriptApp.deleteTrigger(trigger)
    })

    const createdTriggers = []
    DASHBOARD_SYNC_TRIGGER_SCHEDULES.forEach(function (schedule) {
      if (retainedHandlers[schedule.handler]) return

      const trigger = ScriptApp
        .newTrigger(schedule.handler)
        .timeBased()
        .atHour(schedule.hour)
        .nearMinute(schedule.minute)
        .everyDays(1)
        .inTimezone(DASHBOARD_SYNC_TRIGGER_TIMEZONE)
        .create()

      createdTriggers.push({
        handler: schedule.handler,
        approximateTime: schedule.approximateTime,
        timezone: DASHBOARD_SYNC_TRIGGER_TIMEZONE,
        triggerId: trigger.getUniqueId()
      })
    })

    const result = inspectDashboardSyncTriggers()
    result.removedTriggers = removedTriggers
    result.createdTriggers = createdTriggers

    if (!result.valid) {
      throw new Error(
        'Dashboard sync triggers are incomplete or duplicated after installation.'
      )
    }

    console.log(JSON.stringify(result, null, 2))
    return result
  } finally {
    lock.releaseLock()
  }
}

function inspectDashboardSyncTriggers() {
  const managedHandlers = getManagedDashboardSyncHandlers_()
  const matchingTriggers = ScriptApp.getProjectTriggers()
    .filter(function (trigger) {
      return managedHandlers.indexOf(trigger.getHandlerFunction()) !== -1
    })
    .map(function (trigger) {
      return {
        handler: trigger.getHandlerFunction(),
        eventType: String(trigger.getEventType()),
        source: String(trigger.getTriggerSource()),
        triggerId: trigger.getUniqueId()
      }
    })

  const scheduleChecks = DASHBOARD_SYNC_TRIGGER_SCHEDULES.map(
    function (schedule) {
      const count = matchingTriggers.filter(function (trigger) {
        return trigger.handler === schedule.handler
      }).length

      return {
        handler: schedule.handler,
        approximateTime: schedule.approximateTime,
        timezone: DASHBOARD_SYNC_TRIGGER_TIMEZONE,
        triggerCount: count,
        valid: count === 1
      }
    }
  )

  const retiredTriggerCount = matchingTriggers.filter(function (trigger) {
    return RETIRED_DASHBOARD_SYNC_HANDLERS.indexOf(trigger.handler) !== -1
  }).length

  const result = {
    valid: scheduleChecks.every(function (schedule) {
      return schedule.valid
    }) && retiredTriggerCount === 0,
    expected: {
      frequency: 'daily',
      timezone: DASHBOARD_SYNC_TRIGGER_TIMEZONE,
      schedules: DASHBOARD_SYNC_TRIGGER_SCHEDULES
    },
    scheduleChecks: scheduleChecks,
    retiredTriggerCount: retiredTriggerCount,
    matchingTriggers: matchingTriggers
  }

  console.log(JSON.stringify(result, null, 2))
  return result
}
