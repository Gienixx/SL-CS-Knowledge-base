import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

async function absent(path) {
  await assert.rejects(access(new URL(`../${path}`, import.meta.url)))
}

test('active reporting is synchronized Google Sheet-only', async () => {
  const paths = [
    'dashboard.html', 'report-details.html', 'agent-analytics.html',
    'response-times.html', 'reporting-operations.html',
    'scripts/sheet-reporting.js', 'scripts/report-details.js',
    'scripts/agent-analytics.js', 'scripts/response-times.js',
    'scripts/reporting-operations.js', 'scripts/reporting-operations-entry.js',
    'functions/api/sync-dashboard.js'
  ]
  const contents = (await Promise.all(paths.map(read))).join('\n')
  assert.match(contents, /Google Sheet/)
  assert.doesNotMatch(contents, /sync-zendesk|zendesk_agent|ticket_events|ticket_dimension_profiles/i)
})

test('the workbook script targets the current synchronization endpoint', async () => {
  const script = await read('apps-script/dashboard-sync.gs')
  assert.match(script, /syncAllDashboardData/)
  assert.match(script, /\/api\/sync-dashboard/)
  assert.match(script, /Daily Volume/)
  assert.match(script, /Ticket Productivity/)
  assert.match(script, /Daily Drivers/)
})

test('the workbook installs the requested Eastern-time daily sync triggers', async () => {
  const script = await read('apps-script/dashboard-trigger-migration.gs')

  assert.match(script, /DASHBOARD_SYNC_TRIGGER_TIMEZONE = 'America\/New_York'/)
  assert.match(script, /handler: 'syncDashboardAt9AmEastern'/)
  assert.match(script, /hour: 9/)
  assert.match(script, /handler: 'syncDashboardAtNoonEastern'/)
  assert.match(script, /hour: 12/)
  assert.match(script, /function migrateDashboardSyncTriggers\(\)/)
  assert.match(script, /\.everyDays\(1\)/)
  assert.match(script, /\.nearMinute\(schedule\.minute\)/)
  assert.match(script, /retiredTriggerCount === 0/)
  assert.match(script, /syncDashboardAt9Pm/)
  assert.match(script, /syncDashboardAtMidnight/)
})

test('trigger migration removes managed duplicates and is repeatable', async () => {
  const script = await read('apps-script/dashboard-trigger-migration.gs')
  let nextId = 1
  const triggers = [
    makeTrigger('syncDashboardAt9AmEastern'),
    makeTrigger('syncDashboardAt9AmEastern'),
    makeTrigger('syncDashboardAtMidnight'),
    makeTrigger('unrelatedHandler')
  ]

  function makeTrigger(handler) {
    const id = `trigger-${nextId++}`
    return {
      id,
      handler,
      getHandlerFunction: () => handler,
      getUniqueId: () => id,
      getEventType: () => 'CLOCK',
      getTriggerSource: () => 'CLOCK'
    }
  }

  const context = {
    console: { log() {}, error() {} },
    LockService: {
      getScriptLock: () => ({ waitLock() {}, releaseLock() {} })
    },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: trigger => {
        const index = triggers.findIndex(candidate => candidate.id === trigger.id)
        if (index !== -1) triggers.splice(index, 1)
      },
      newTrigger: handler => {
        const schedule = { handler }
        const builder = {
          timeBased: () => builder,
          atHour: hour => { schedule.hour = hour; return builder },
          nearMinute: minute => { schedule.minute = minute; return builder },
          everyDays: days => { schedule.days = days; return builder },
          inTimezone: timezone => { schedule.timezone = timezone; return builder },
          create: () => {
            const trigger = makeTrigger(handler)
            trigger.schedule = schedule
            triggers.push(trigger)
            return trigger
          }
        }
        return builder
      }
    }
  }

  runInNewContext(script, context)
  const first = context.migrateDashboardSyncTriggers()
  const second = context.migrateDashboardSyncTriggers()
  const managed = triggers.filter(trigger => [
    'syncDashboardAt9AmEastern', 'syncDashboardAtNoonEastern',
    'syncDashboardAt9Pm', 'syncDashboardAtMidnight',
    'syncAllDashboardData', 'syncDashboardData'
  ].includes(trigger.handler))

  assert.equal(first.valid, true)
  assert.equal(first.removedTriggers.length, 2)
  assert.equal(first.createdTriggers.length, 1)
  assert.equal(second.valid, true)
  assert.equal(second.removedTriggers.length, 0)
  assert.equal(second.createdTriggers.length, 0)
  assert.deepEqual(
    managed.map(trigger => trigger.handler).sort(),
    ['syncDashboardAt9AmEastern', 'syncDashboardAtNoonEastern']
  )
  assert.equal(triggers.find(trigger => trigger.handler === 'syncDashboardAtNoonEastern').schedule.timezone,
    'America/New_York')
})

test('Eastern trigger timezone follows daylight-saving transitions', () => {
  const localClock = instant => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hour12: true,
      timeZoneName: 'shortOffset'
    }).formatToParts(new Date(instant))
    return Object.fromEntries(parts.map(part => [part.type, part.value]))
  }

  const beforeDst = localClock('2026-03-07T14:00:00Z')
  const afterDst = localClock('2026-03-09T13:00:00Z')
  assert.equal(beforeDst.hour, '9')
  assert.equal(beforeDst.dayPeriod, 'AM')
  assert.equal(beforeDst.timeZoneName, 'GMT-5')
  assert.equal(afterDst.hour, '9')
  assert.equal(afterDst.dayPeriod, 'AM')
  assert.equal(afterDst.timeZoneName, 'GMT-4')
})

test('Reporting Operations exposes a computed stale-sync alert after 30 hours', async () => {
  const migration = await read(
    'supabase/migrations-legacy/2026070402_reporting_operations.sql'
  )
  assert.match(migration, /computed:stale_sync/)
  assert.match(migration, /latest successful Google Sheet synchronization completed more than 30 hours ago/)
  assert.match(migration, /completed_at < now\(\) - interval '30 hours'/)
})

test('Apps Script logs failures that happen before endpoint contact', async () => {
  const syncScript = await read('apps-script/dashboard-sync.gs')
  const triggerScript = await read('apps-script/dashboard-trigger-migration.gs')
  const errorLogs = []
  let endpointCalls = 0
  const sourceTabs = [
    'Daily Volume', 'Ticket Productivity', 'Daily Drivers'
  ].map(name => ({ getName: () => name, getMaxColumns: () => 73 }))
  const context = {
    console: {
      log() {},
      error: message => errorLogs.push(JSON.parse(message))
    },
    LockService: {
      getScriptLock: () => ({ waitLock() {}, releaseLock() {} })
    },
    SpreadsheetApp: {
      getActive: () => ({ getSheets: () => sourceTabs })
    },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: () => null })
    },
    UrlFetchApp: {
      fetch: () => { endpointCalls += 1; throw new Error('unexpected fetch') }
    }
  }

  runInNewContext(syncScript + '\n' + triggerScript, context)
  assert.throws(() => context.syncDashboardAt9AmEastern(), /Set DASHBOARD_SYNC_URL/)
  assert.equal(endpointCalls, 0)
  assert.ok(errorLogs.some(log =>
    log.event === 'dashboard_sync_failed' &&
    log.stage === 'validate_script_properties'
  ))
  assert.ok(errorLogs.some(log =>
    log.event === 'dashboard_sync_trigger_failed' &&
    log.handler === 'syncDashboardAt9AmEastern'
  ))
})

test('retired V3 and Zendesk synchronization routes are removed', async () => {
  for (const path of [
    'functions/api/sync-dashboard-v3.js',
    'functions/_shared/dashboard-sync-contract-v3.js',
    'functions/api/sync-zendesk.js',
    'functions/api/sync-zendesk-events.js',
    'functions/api/sync-zendesk-sla.js'
  ]) await absent(path)
})

test('current database operations and verification files are present', async () => {
  const paths = [
    'supabase/migrations-legacy/2026070301_google_sheet_reporting_contract.sql',
    'supabase/migrations-legacy/2026070302_sheet_only_reporting_schema.sql',
    'supabase/migrations-legacy/2026070303_sheet_only_dashboard_rpc.sql',
    'supabase/migrations-legacy/2026070304_sheet_only_agent_rpc.sql',
    'supabase/migrations-legacy/2026070401_dashboard_features.sql',
    'supabase/migrations-legacy/2026070402_reporting_operations.sql',
    'supabase/migrations-legacy/2026070403_sync_history_visibility_fix.sql',
    'supabase/migrations-legacy/2026070607_reporting_operations_admin_access.sql',
    'supabase/verification/google_sheet_contract_check.sql',
    'supabase/verification/sheet_only_reporting_check.sql',
    'supabase/verification/reporting_acceptance_check.sql',
    'supabase/verification/sync_history_visibility_check.sql',
    'supabase/verification/reporting_operations_admin_access_check.sql'
  ]
  for (const path of paths) assert.ok((await read(path)).trim().length > 0, `${path} should not be empty`)
})
