import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  getPhase3Step9ExpectedDictionaryRows,
  PHASE3_STEP9_CONTRACT_KEY,
  PHASE3_STEP9_TABS,
  validatePhase3Step9ContractDefinition
} from '../config/phase3-step9-sheet-contract.js'
import {
  isPhase3Step9Payload,
  processPhase3Step9Payload
} from '../functions/_shared/dashboard-sync-contract-v3.js'

const headers = tabKey =>
  PHASE3_STEP9_TABS[tabKey].columns.map(column => column.name)

function isoDate(day) {
  return `2026-06-${String(day).padStart(2, '0')}`
}

function buildPayload(days = 7) {
  const dailyRows = []
  const productivityRows = []
  const dimensionRows = []

  for (let offset = 0; offset < days; offset += 1) {
    const reportDate = isoDate(20 + offset)
    productivityRows.push(
      [
        reportDate, 'agent_one', 'Agent One',
        4, 2, 5, 50, 5, 25, 5, 4, 160, 40, 1, 3, 8
      ],
      [
        reportDate, 'agent_two', 'Agent Two',
        6, 3, 7, 84, 7, 42, 6, 6, 300, 50, 1, 5, 8
      ]
    )

    dailyRows.push([
      reportDate,
      12,
      10,
      5,
      8 / 10,
      2 / 10,
      12,
      67,
      5.5,
      10,
      460,
      45,
      2,
      8
    ])

    for (const [agentKey, agentName, handled] of [
      ['agent_one', 'Agent One', 5],
      ['agent_two', 'Agent Two', 7]
    ]) {
      for (const dimensionType of [
        'app', 'platform', 'country', 'concern', 'priority', 'channel'
      ]) {
        dimensionRows.push([
          reportDate,
          agentKey,
          agentName,
          dimensionType,
          'unknown',
          'Unknown',
          handled
        ])
      }
    }
  }

  const dictionaryRows = getPhase3Step9ExpectedDictionaryRows().map(row => [
    row.tab_name,
    row.column_name,
    row.data_type,
    row.required,
    row.definition,
    row.validation_rule
  ])

  return {
    payloadVersion: 3,
    contractKey: PHASE3_STEP9_CONTRACT_KEY,
    datasets: {
      dailyTicketMetrics: {
        sheetName: PHASE3_STEP9_TABS.dailyTicketMetrics.sheetName,
        values: [headers('dailyTicketMetrics'), ...dailyRows]
      },
      ticketProductivity: {
        sheetName: PHASE3_STEP9_TABS.ticketProductivity.sheetName,
        values: [headers('ticketProductivity'), ...productivityRows]
      },
      agentDimensionMetrics: {
        sheetName: PHASE3_STEP9_TABS.agentDimensionMetrics.sheetName,
        values: [headers('agentDimensionMetrics'), ...dimensionRows]
      },
      dataDictionary: {
        sheetName: PHASE3_STEP9_TABS.dataDictionary.sheetName,
        values: [headers('dataDictionary'), ...dictionaryRows]
      },
      syncMetadata: {
        sheetName: PHASE3_STEP9_TABS.syncMetadata.sheetName,
        values: [[...headers('syncMetadata')], [
          3,
          '2026-06-27T13:00:00-04:00',
          'America/New_York',
          isoDate(20),
          isoDate(20 + days - 1),
          days,
          'phase3-step9-test'
        ]]
      }
    }
  }
}

test('Step 9 contract definition is internally consistent', () => {
  assert.deepEqual(validatePhase3Step9ContractDefinition(), [])
})

test('seven reconciled days are production ready', () => {
  const payload = buildPayload(7)
  assert.equal(isPhase3Step9Payload(payload), true)

  const result = processPhase3Step9Payload(
    payload,
    '00000000-0000-0000-0000-000000000001'
  )

  assert.equal(result.dailyMetrics.length, 7)
  assert.equal(result.productivity.length, 14)
  assert.equal(result.agentDimensions.length, 84)
  assert.equal(result.readiness.longestConsecutiveDays, 7)
  assert.equal(result.readiness.readyForProduction, true)
  assert.equal(result.syncMetadata.ready_for_production, true)
  assert.equal(result.warnings.length, 0)
})

test('a shorter test window imports but is not production ready', () => {
  const result = processPhase3Step9Payload(buildPayload(3), 'run-3')
  assert.equal(result.readiness.readyForProduction, false)
  assert.match(result.warnings[0], /seven consecutive test days/i)
})

test('daily totals must reconcile to agent totals', () => {
  const payload = buildPayload(7)
  payload.datasets.dailyTicketMetrics.values[1][2] = 11

  assert.throws(
    () => processPhase3Step9Payload(payload, 'run-mismatch'),
    /solved_tickets does not reconcile/
  )
})

test('agent_key must remain stable for one agent name', () => {
  const payload = buildPayload(7)
  payload.datasets.ticketProductivity.values[2][2] = 'Different Person'

  assert.throws(
    () => processPhase3Step9Payload(payload, 'run-agent'),
    /maps to more than one agent_name/
  )
})

test('the data dictionary must document every contract column', () => {
  const payload = buildPayload(7)
  payload.datasets.dataDictionary.values.pop()

  assert.throws(
    () => processPhase3Step9Payload(payload, 'run-dictionary'),
    /Data Dictionary is missing/
  )
})

test('dimension totals reconcile to handled tickets', () => {
  const payload = buildPayload(7)
  payload.datasets.agentDimensionMetrics.values[1][6] = 4

  assert.throws(
    () => processPhase3Step9Payload(payload, 'run-dimension'),
    /ticket_count does not reconcile/
  )
})

test('Step 9 endpoint, migration, and Apps Script use the versioned contract', async () => {
  const [endpoint, migration, appsScript] = await Promise.all([
    readFile(
      new URL('../functions/api/sync-dashboard-v3.js', import.meta.url),
      'utf8'
    ),
    readFile(
      new URL(
        '../supabase/migrations/2026070301_phase3_step9_google_sheet_reporting_contract.sql',
        import.meta.url
      ),
      'utf8'
    ),
    readFile(
      new URL(
        '../apps-script/phase3-step9-reporting-contract.gs',
        import.meta.url
      ),
      'utf8'
    )
  ])

  assert.match(endpoint, /processPhase3Step9Payload/)
  assert.match(endpoint, /SHEET_SYNC_SECRET/)
  assert.match(endpoint, /PHASE3_STEP9_DESTINATIONS\.syncMetadata/)
  assert.match(migration, /add column if not exists handled_tickets/)
  assert.match(migration, /create table if not exists public\.agent_dimension_metrics/)
  assert.match(migration, /create table if not exists public\.reporting_data_dictionary/)
  assert.match(migration, /create table if not exists public\.sheet_sync_metadata/)
  assert.match(appsScript, /setupPhase3Step9Tabs/)
  assert.match(appsScript, /syncPhase3Step9Dashboard/)
  assert.match(appsScript, /America\/New_York/)
})
