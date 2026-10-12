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
const DASHBOARD_SYNC_TRIGGER_INSTALLATION_PROPERTY =
  'DASHBOARD_SYNC_TRIGGER_INSTALLATION'

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
    const removedTriggers = []

    // Apps Script trigger objects do not expose their configured hour,
    // minute, recurrence, or timezone. Reinstall every managed handler so an
    // old trigger with the right name but wrong schedule cannot be retained.
    ScriptApp.getProjectTriggers().forEach(function (trigger) {
      const handler = trigger.getHandlerFunction()
      if (managedHandlers.indexOf(handler) === -1) return

      removedTriggers.push({
        handler: handler,
        triggerId: trigger.getUniqueId()
      })
      ScriptApp.deleteTrigger(trigger)
    })

    const createdTriggers = []
    DASHBOARD_SYNC_TRIGGER_SCHEDULES.forEach(function (schedule) {
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

    PropertiesService.getScriptProperties().setProperty(
      DASHBOARD_SYNC_TRIGGER_INSTALLATION_PROPERTY,
      JSON.stringify({
        timezone: DASHBOARD_SYNC_TRIGGER_TIMEZONE,
        schedules: DASHBOARD_SYNC_TRIGGER_SCHEDULES.map(
          function (schedule) {
            const installed = createdTriggers.find(function (trigger) {
              return trigger.handler === schedule.handler
            })
            return {
              handler: schedule.handler,
              hour: schedule.hour,
              minute: schedule.minute,
              triggerId: installed ? installed.triggerId : null
            }
          }
        )
      })
    )

    const result = inspectDashboardSyncTriggers()
    result.removedTriggers = removedTriggers
    result.createdTriggers = createdTriggers

    if (!result.valid) {
      throw new Error(
        'Dashboard sync triggers could not be verified after reinstall.'
      )
    }

    console.log(JSON.stringify(result, null, 2))
    return result
  } finally {
    lock.releaseLock()
  }
}

function inspectDashboardSyncTriggers() {
  let installation = null
  try {
    installation = JSON.parse(
      PropertiesService.getScriptProperties().getProperty(
        DASHBOARD_SYNC_TRIGGER_INSTALLATION_PROPERTY
      ) || 'null'
    )
  } catch (error) {
    installation = null
  }

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
      const matching = matchingTriggers.filter(function (trigger) {
        return trigger.handler === schedule.handler
      })
      const count = matching.length
      const soleTrigger = matching[0]
      const installedSchedule = Array.isArray(installation?.schedules)
        ? installation.schedules.find(function (installed) {
          return installed.handler === schedule.handler
        })
        : null
      const installedHere = Boolean(
        installation &&
        installation.timezone === DASHBOARD_SYNC_TRIGGER_TIMEZONE &&
        installedSchedule &&
        installedSchedule.hour === schedule.hour &&
        installedSchedule.minute === schedule.minute &&
        installedSchedule.triggerId &&
        count === 1 &&
        soleTrigger.triggerId === installedSchedule.triggerId
      )
      const isClockTrigger = Boolean(
        soleTrigger &&
        soleTrigger.eventType === 'CLOCK' &&
        soleTrigger.source === 'CLOCK'
      )

      return {
        handler: schedule.handler,
        approximateTime: schedule.approximateTime,
        timezone: DASHBOARD_SYNC_TRIGGER_TIMEZONE,
        triggerCount: count,
        eventType: soleTrigger ? soleTrigger.eventType : null,
        source: soleTrigger ? soleTrigger.source : null,
        scheduleMetadataAvailable: false,
        verifiedByReinstall: installedHere,
        valid: count === 1 && isClockTrigger && installedHere
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
    scheduleMetadataAvailable: false,
    verificationMethod: installation
      ? 'current trigger IDs match the schedule installation record'
      : 'unverified; run migrateDashboardSyncTriggers to reinstall safely',
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
