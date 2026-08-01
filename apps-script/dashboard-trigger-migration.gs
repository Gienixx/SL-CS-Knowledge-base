const DASHBOARD_SYNC_TRIGGER_TIMEZONE = 'Asia/Manila'

const DASHBOARD_SYNC_TRIGGER_SCHEDULES = Object.freeze([
  Object.freeze({
    handler: 'syncDashboardAt9Pm',
    hour: 21,
    minute: 0,
    approximateTime: '9:00 PM Manila'
  }),
  Object.freeze({
    handler: 'syncDashboardAtMidnight',
    hour: 0,
    minute: 0,
    approximateTime: '12:00 AM Manila'
  })
])

const RETIRED_DASHBOARD_SYNC_HANDLERS = Object.freeze([
  'syncAllDashboardData',
  'syncDashboardData'
])

function syncDashboardAt9Pm() {
  return syncAllDashboardData()
}

function syncDashboardAtMidnight() {
  return syncAllDashboardData()
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
    const removedTriggers = []

    ScriptApp.getProjectTriggers().forEach(function (trigger) {
      const handler = trigger.getHandlerFunction()

      if (managedHandlers.indexOf(handler) === -1) {
        return
      }

      removedTriggers.push({
        handler: handler,
        triggerId: trigger.getUniqueId()
      })
      ScriptApp.deleteTrigger(trigger)
    })

    const createdTriggers = DASHBOARD_SYNC_TRIGGER_SCHEDULES.map(
      function (schedule) {
        const trigger = ScriptApp
          .newTrigger(schedule.handler)
          .timeBased()
          .atHour(schedule.hour)
          .nearMinute(schedule.minute)
          .everyDays(1)
          .inTimezone(DASHBOARD_SYNC_TRIGGER_TIMEZONE)
          .create()

        return {
          handler: schedule.handler,
          approximateTime: schedule.approximateTime,
          timezone: DASHBOARD_SYNC_TRIGGER_TIMEZONE,
          triggerId: trigger.getUniqueId()
        }
      }
    )

    const result = inspectDashboardSyncTriggers()
    result.removedTriggers = removedTriggers
    result.createdTriggers = createdTriggers

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
