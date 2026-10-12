import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PHASE_ONE_DASHBOARD_MAPPING
} from '../config/dashboard-data-mapping.js'
import {
  DISTRIBUTION_MAPPING
} from '../config/distribution-mapping.js'
import {
  getProductivityAgentBlocks,
  PRODUCTIVITY_MAPPING
} from '../config/productivity-mapping.js'
import {
  DRIVER_MAPPING
} from '../config/driver-mapping.js'
import {
  deduplicateMappedRecords,
  getMappedRecordBatches
} from '../functions/_shared/mapped-record-batches.js'
import {
  processMultiDatasetPayload,
  validateMultiDatasetPayload
} from '../functions/_shared/dashboard-sync-datasets.js'
import { onRequestPost } from '../functions/api/sync-dashboard.js'

function blankRow(length) {
  return Array.from({ length }, () => '')
}

function buildDailyVolumeHeaders() {
  const headers = blankRow(19)

  PHASE_ONE_DASHBOARD_MAPPING.columns.forEach((column, index) => {
    headers[index] = column.sourceHeader
  })

  DISTRIBUTION_MAPPING.columns.forEach(column => {
    headers[column.sourceIndex] = column.sourceHeader
  })

  return headers
}

function buildProductivityHeaders(agentNames = [
  'Amora', 'Ford', 'Gen', 'Arez', 'Tristan', 'Jerson', 'Jean', 'Arby'
]) {
  const agentHeaders = blankRow(25)
  const metricHeaders = blankRow(25)
  agentHeaders[0] = PRODUCTIVITY_MAPPING.source.dateColumn.sourceHeader

  agentNames.forEach((agentName, agentIndex) => {
    const startIndex = 1 + agentIndex * PRODUCTIVITY_MAPPING.agentBlockWidth
    agentHeaders[startIndex] = agentName
    PRODUCTIVITY_MAPPING.metrics.forEach((metric, metricIndex) => {
      metricHeaders[startIndex + metricIndex] = metric.sourceHeader
    })
  })

  return [agentHeaders, metricHeaders]
}

function buildDriverHeaders() {
  const sourceHeaders = blankRow(73)
  const displayHeaders = blankRow(73)
  displayHeaders[0] = DRIVER_MAPPING.source.dateColumn.sourceHeader

  DRIVER_MAPPING.columns.forEach(column => {
    sourceHeaders[column.sourceIndex] = column.sourceKey
    displayHeaders[column.sourceIndex] = column.sourceLabel
  })

  return [sourceHeaders, displayHeaders]
}

function buildIntegrityPayload() {
  const dailyHeaders = buildDailyVolumeHeaders()
  const dailyZeroRow = blankRow(19)
  dailyZeroRow[0] = '2026-06-01'
  dailyZeroRow[1] = 0
  dailyZeroRow[2] = 0
  dailyZeroRow[3] = 0
  dailyZeroRow[4] = 0
  dailyZeroRow[5] = 0
  DISTRIBUTION_MAPPING.columns.forEach(column => {
    dailyZeroRow[column.sourceIndex] = 0
  })

  const dailyNegativeRow = blankRow(19)
  dailyNegativeRow[0] = '2026-06-02'
  dailyNegativeRow[1] = 1
  dailyNegativeRow[2] = 2
  dailyNegativeRow[3] = 3
  dailyNegativeRow[4] = 0.5
  dailyNegativeRow[5] = 0.1
  dailyNegativeRow[DISTRIBUTION_MAPPING.columns[0].sourceIndex] = -1

  const dailyFutureTemplateRow = blankRow(19)
  dailyFutureTemplateRow[0] = '2099-12-31'

  const [agentHeaders, metricHeaders] = buildProductivityHeaders()
  const validAgentRow = blankRow(25)
  validAgentRow[0] = '2026-06-01'
  validAgentRow[1] = 0
  validAgentRow[2] = 0
  validAgentRow[3] = 0

  const negativeAgentRow = blankRow(25)
  negativeAgentRow[0] = '2026-06-02'
  negativeAgentRow[4] = -1

  const partialAgentRow = blankRow(25)
  partialAgentRow[0] = '2026-06-03'
  partialAgentRow[7] = 2
  partialAgentRow[8] = -1

  const missingAgentBlocksRow = blankRow(25)
  missingAgentBlocksRow[0] = '2099-12-31'

  const [driverSourceHeaders, driverDisplayHeaders] = buildDriverHeaders()
  const zeroDriverRow = blankRow(73)
  zeroDriverRow[0] = '2026-06-01'
  zeroDriverRow[DRIVER_MAPPING.columns[0].sourceIndex] = 0

  const negativeDriverRow = blankRow(73)
  negativeDriverRow[0] = '2026-06-02'
  negativeDriverRow[DRIVER_MAPPING.columns[1].sourceIndex] = -1

  const futureDriverTemplateRow = blankRow(73)
  futureDriverTemplateRow[0] = '2099-12-31'

  return {
    payloadVersion: 2,
    datasets: {
      dailyVolume: {
        sheetName: DISTRIBUTION_MAPPING.source.sheetName,
        columnCount: 19,
        headerRows: 1,
        dataStartRow: 2,
        values: [
          dailyHeaders,
          dailyZeroRow,
          dailyNegativeRow,
          dailyFutureTemplateRow
        ]
      },
      ticketProductivity: {
        sheetName: PRODUCTIVITY_MAPPING.source.sheetName,
        columnCount: 25,
        headerRows: 2,
        dataStartRow: 3,
        values: [
          agentHeaders,
          metricHeaders,
          validAgentRow,
          negativeAgentRow,
          partialAgentRow,
          missingAgentBlocksRow
        ]
      },
      dailyDrivers: {
        sheetName: DRIVER_MAPPING.source.sheetName,
        columnCount: 73,
        headerRows: 2,
        dataStartRow: 3,
        values: [
          driverSourceHeaders,
          driverDisplayHeaders,
          zeroDriverRow,
          negativeDriverRow,
          futureDriverTemplateRow
        ]
      }
    }
  }
}

test('deduplicateMappedRecords keeps the last record for each logical key', () => {
  const records = [
    { report_date: '2026-06-01', agent_key: 'amora', solved_tickets: 1 },
    { report_date: '2026-06-01', agent_key: 'ford', solved_tickets: 2 },
    { report_date: '2026-06-01', agent_key: 'amora', solved_tickets: 3 }
  ]

  const result = deduplicateMappedRecords(
    records,
    ['report_date', 'agent_key']
  )

  assert.equal(result.length, 2)
  assert.equal(
    result.find(row => row.agent_key === 'amora').solved_tickets,
    3
  )
})

test('getMappedRecordBatches collapses duplicate distribution keys', () => {
  const records = [
    {
      report_date: '2026-06-01',
      dimension_type: 'app',
      dimension_key: 'eureka',
      ticket_count: 10
    },
    {
      report_date: '2026-06-01',
      dimension_type: 'app',
      dimension_key: 'eureka',
      ticket_count: 12
    }
  ]

  const batches = getMappedRecordBatches(records)
  assert.equal(batches.length, 1)
  assert.equal(batches[0].length, 1)
  assert.equal(batches[0][0].ticket_count, 12)
})

test('multi-dataset processing handles Step 10 integrity edge cases', () => {
  const payload = buildIntegrityPayload()

  assert.doesNotThrow(() => validateMultiDatasetPayload(payload))
  const result = processMultiDatasetPayload(payload, 'integrity-test-run')

  assert.equal(result.dailyMetrics.importedRecords.length, 2)
  assert.equal(result.dailyMetrics.importedRecords[0].new_tickets, 0)
  assert.equal(result.distributions.importedRecords.length, 13)
  assert.equal(result.distributions.importedRecords[0].ticket_count, 0)

  assert.equal(result.productivity.importedRecords.length, 1)
  assert.equal(result.productivity.importedRecords[0].solved_tickets, 0)
  assert.equal(result.productivity.importedRecords[0].open_tickets, 0)
  assert.equal(result.productivity.importedRecords[0].aht_value, 0)

  assert.equal(result.drivers.importedRecords.length, 1)
  assert.equal(result.drivers.importedRecords[0].ticket_count, 0)

  const allImportedRecords = [
    ...result.dailyMetrics.importedRecords,
    ...result.distributions.importedRecords,
    ...result.productivity.importedRecords,
    ...result.drivers.importedRecords
  ]

  assert.equal(
    allImportedRecords.some(row => row.report_date === '2099-12-31'),
    false
  )
  assert.equal(result.productivity.skippedRecords, 2)
  assert.equal(result.drivers.skippedRecords, 1)
  assert.ok(
    result.warnings.some(warning =>
      warning.includes('not a valid non-negative integer')
    )
  )
})

test('Ticket Productivity derives reordered and changed agent blocks from headers', () => {
  const payload = buildIntegrityPayload()
  const dataset = payload.datasets.ticketProductivity
  const [agentHeaders, metricHeaders] = buildProductivityHeaders([
    'New Support Agent', 'Amora'
  ])
  const row = blankRow(25)
  row[0] = '2026-06-05'
  row[1] = 4
  row[2] = 2
  row[3] = 6.5
  row[4] = 7
  row[5] = 3
  row[6] = 5.25
  dataset.values = [agentHeaders, metricHeaders, row]

  assert.doesNotThrow(() => validateMultiDatasetPayload(payload))
  const blocks = getProductivityAgentBlocks(dataset)
  assert.deepEqual(
    blocks.map(block => [block.agentKey, block.agentName]),
    [['new_support_agent', 'New Support Agent'], ['amora', 'Amora']]
  )

  const result = processMultiDatasetPayload(payload, 'dynamic-agent-test')
  assert.deepEqual(
    result.productivity.importedRecords.map(record => [
      record.agent_key,
      record.solved_tickets,
      record.open_tickets,
      record.aht_value
    ]),
    [['new_support_agent', 4, 2, 6.5], ['amora', 7, 3, 5.25]]
  )
})

test('Ticket Productivity rejects a shifted agent header instead of mis-mapping it', () => {
  const payload = buildIntegrityPayload()
  const headers = payload.datasets.ticketProductivity.values[0]
  headers[2] = headers[1]
  headers[1] = ''

  assert.throws(
    () => validateMultiDatasetPayload(payload),
    /agent header at column C is inside a metric block/
  )
})

test('Ticket Productivity rejects missing or malformed metric headers before import', () => {
  const payload = buildIntegrityPayload()
  payload.datasets.ticketProductivity.values[1][2] = 'Solved Tickets'

  assert.throws(
    () => validateMultiDatasetPayload(payload),
    /Amora column C must be Open Tickets/
  )

  const missingAgentPayload = buildIntegrityPayload()
  missingAgentPayload.datasets.ticketProductivity.values[0][1] = ''

  assert.throws(
    () => validateMultiDatasetPayload(missingAgentPayload),
    /metric block at column B is missing its agent header/
  )
})

test('Ticket Productivity rejects data under unnamed blocks rather than dropping it', () => {
  const payload = buildIntegrityPayload()
  const dataset = payload.datasets.ticketProductivity
  const [agentHeaders, metricHeaders] = buildProductivityHeaders(['Amora'])
  const row = blankRow(25)
  row[0] = '2026-06-05'
  row[1] = 1
  row[4] = 2
  dataset.values = [agentHeaders, metricHeaders, row]

  assert.throws(
    () => validateMultiDatasetPayload(payload),
    /data under the unnamed block at column E/
  )
})

test('malformed workbook headers are recorded as failed and write no analytics rows', async () => {
  const payload = buildIntegrityPayload()
  payload.datasets.ticketProductivity.values[1][2] = 'Solved Tickets'
  const originalFetch = globalThis.fetch
  const requests = []

  globalThis.fetch = async (url, options = {}) => {
    requests.push({
      url: String(url),
      method: options.method,
      body: options.body ? JSON.parse(options.body) : null
    })
    if (String(url).endsWith('/rest/v1/sheet_sync_runs')) {
      return new Response(JSON.stringify([{ id: 'sync-test-id' }]), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    return new Response(null, { status: 204 })
  }

  try {
    const response = await onRequestPost({
      request: new Request('https://example.test/api/sync-dashboard', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-secret',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      }),
      env: {
        SHEET_SYNC_SECRET: 'test-secret',
        SUPABASE_URL: 'https://project.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'test-service-role'
      }
    })
    const result = await response.json()

    assert.equal(response.status, 400)
    assert.match(result.error, /Amora column C must be Open Tickets/)
    assert.deepEqual(
      requests.map(request => request.method + ' ' + request.url.split('/').pop()),
      ['POST sheet_sync_runs', 'PATCH sheet_sync_runs?id=eq.sync-test-id']
    )
    assert.equal(requests[1].body.status, 'failed')
    assert.match(requests[1].body.error_message, /Amora column C must be Open Tickets/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('unauthorized synchronization requests are rejected before database writes', async () => {
  const originalFetch = globalThis.fetch
  let databaseRequests = 0
  globalThis.fetch = async () => {
    databaseRequests += 1
    throw new Error('unauthorized requests must not access Supabase')
  }

  try {
    const response = await onRequestPost({
      request: new Request('https://example.test/api/sync-dashboard', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer wrong-secret',
          'Content-Type': 'application/json'
        },
        body: '{}'
      }),
      env: {
        SHEET_SYNC_SECRET: 'test-secret',
        SUPABASE_URL: 'https://project.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'test-service-role'
      }
    })

    assert.equal(response.status, 401)
    assert.equal(databaseRequests, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})
