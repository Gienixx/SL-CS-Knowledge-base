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
  const agentHeaders = blankRow(28)
  const metricHeaders = blankRow(28)
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
  const validAgentRow = blankRow(28)
  validAgentRow[0] = '2026-06-01'
  validAgentRow[1] = 0
  validAgentRow[2] = 0
  validAgentRow[3] = 0

  const negativeAgentRow = blankRow(28)
  negativeAgentRow[0] = '2026-06-02'
  negativeAgentRow[4] = -1

  const partialAgentRow = blankRow(28)
  partialAgentRow[0] = '2026-06-03'
  partialAgentRow[7] = 2
  partialAgentRow[8] = -1

  const missingAgentBlocksRow = blankRow(28)
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
        columnCount: 28,
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

test('Ticket Productivity imports Automated and the ninth agent Jean at Z-AB', () => {
  const payload = buildIntegrityPayload()
  const dataset = payload.datasets.ticketProductivity
  const names = [
    'Automated', 'Amora', 'Ford', 'Gen', 'Arby',
    'Arez', 'Tristan', 'Jerson', 'Jean'
  ]
  const [agentHeaders, metricHeaders] = buildProductivityHeaders(names)
  const row = blankRow(28)
  row[0] = '2026-09-18'
  names.forEach((_name, index) => {
    const startIndex = 1 + index * 3
    row[startIndex] = index + 1
    row[startIndex + 1] = index + 2
    row[startIndex + 2] = index + 3.5
  })
  dataset.values = [agentHeaders, metricHeaders, row]

  assert.doesNotThrow(() => validateMultiDatasetPayload(payload))
  const blocks = getProductivityAgentBlocks(dataset)
  assert.deepEqual(
    blocks.map(block => block.agentName),
    names
  )
  assert.deepEqual(
    blocks[8].metrics.map(metric => metric.sourceColumn),
    ['Z', 'AA', 'AB']
  )
  const result = processMultiDatasetPayload(payload, 'nine-agents')
  assert.equal(result.productivity.importedRecords.length, 9)
  const keys = result.productivity.importedRecords.map(record => record.agent_key)
  assert.deepEqual(keys, [
    'automated', 'amora', 'ford', 'gen', 'arby',
    'arez', 'tristan', 'jerson', 'jean'
  ])
  const jean = result.productivity.importedRecords.find(record =>
    record.agent_key === 'jean'
  )
  assert.equal(jean.solved_tickets, 9)
  assert.equal(jean.open_tickets, 10)
  assert.equal(jean.aht_value, 11.5)
})

test('Ticket Productivity derives reordered and changed agent blocks from headers', () => {
  const payload = buildIntegrityPayload()
  const dataset = payload.datasets.ticketProductivity
  const [agentHeaders, metricHeaders] = buildProductivityHeaders([
    'New Support Agent', 'Amora'
  ])
  const row = blankRow(28)
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
  const row = blankRow(28)
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

test('agent renames preserve identity and registered new agents can be imported', async () => {
  const payload = buildIntegrityPayload()
  const originalFetch = globalThis.fetch
  const productivityRows = []
  const identityRows = []
  const analyticsWrites = []
  const syncRunUpdates = []
  let nextSyncRun = 0

  globalThis.fetch = async (url, options = {}) => {
    const parsedUrl = new URL(String(url))
    const path = parsedUrl.pathname
    const method = options.method || 'GET'

    if (path.endsWith('/rest/v1/sheet_sync_runs') && method === 'POST') {
      nextSyncRun += 1
      return new Response(JSON.stringify([{ id: `sync-${nextSyncRun}` }]), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    if (path.endsWith('/rest/v1/sheet_sync_runs') && method === 'PATCH') {
      syncRunUpdates.push(JSON.parse(options.body))
      return new Response(null, { status: 204 })
    }

    if (path.endsWith('/rest/v1/agent_identity_map') && method === 'GET') {
      return new Response(JSON.stringify(identityRows), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    if (path.endsWith('/rest/v1/agent_productivity') && method === 'GET') {
      const dateFilter = parsedUrl.searchParams.get('report_date') || ''
      const requestedDates = dateFilter.startsWith('in.(')
        ? new Set(dateFilter.slice(4, -1).split(','))
        : new Set()
      const rows = productivityRows.filter(row =>
        requestedDates.has(row.report_date)
      )
      const range = options.headers?.Range || '0-499'
      const [start, end] = range.split('-').map(Number)
      return new Response(JSON.stringify(rows.slice(start, end + 1)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    if (method === 'POST' && !path.endsWith('/rest/v1/sheet_sync_runs')) {
      const records = JSON.parse(options.body || '[]')
      analyticsWrites.push({ path, records })
      if (path.endsWith('/rest/v1/agent_productivity')) {
        records.forEach(record => {
          const existingIndex = productivityRows.findIndex(existing =>
            existing.report_date === record.report_date &&
            existing.agent_key === record.agent_key
          )
          if (existingIndex === -1) {
            productivityRows.push(record)
          } else {
            productivityRows[existingIndex] = {
              ...productivityRows[existingIndex],
              ...record
            }
          }

          const mappedIdentity = identityRows.find(identity =>
            identity.agent_key === record.agent_key
          )
          if (mappedIdentity) {
            mappedIdentity.agent_name = record.agent_name
          } else {
            identityRows.push({
              agent_key: record.agent_key,
              agent_name: record.agent_name,
              dashboard_sync_approved: false
            })
          }
        })
      }
      return new Response(null, { status: 204 })
    }

    throw new Error(`Unexpected Supabase request: ${method} ${parsedUrl}`)
  }

  const sendSync = async () => onRequestPost({
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

  try {
    const firstResponse = await sendSync()
    assert.equal(firstResponse.status, 200)
    assert.equal(productivityRows.length, 1)
    assert.equal(productivityRows[0].agent_key, 'amora')
    const writesAfterFirstImport = analyticsWrites.length

    payload.datasets.ticketProductivity.values[0][1] = 'Renamed Agent'
    const renamedResponse = await sendSync()
    const renamedResult = await renamedResponse.json()

    assert.equal(renamedResponse.status, 409)
    assert.match(renamedResult.error, /new agent identity on report date 2026-06-01/)
    assert.match(renamedResult.error, /may represent an agent rename/)
    assert.equal(analyticsWrites.length, writesAfterFirstImport)
    assert.deepEqual(
      productivityRows.map(row => [row.report_date, row.agent_key]),
      [['2026-06-01', 'amora']]
    )
    assert.equal(syncRunUpdates.at(-1).status, 'failed')
    assert.equal(syncRunUpdates.at(-1).rows_imported, 0)

    // Reconcile the verified rename by changing the display name on the
    // existing stable identity-map row. The next replay reuses the old key.
    identityRows[0].agent_name = 'Renamed Agent'
    const writesBeforeReconciledReplay = analyticsWrites.length
    const reconciledResponse = await sendSync()
    assert.equal(reconciledResponse.status, 200)
    assert.ok(analyticsWrites.length > writesBeforeReconciledReplay)
    assert.deepEqual(
      productivityRows.map(row => [
        row.report_date,
        row.agent_key,
        row.agent_name
      ]),
      [['2026-06-01', 'amora', 'Renamed Agent']]
    )

    // A genuinely new agent must be registered and explicitly approved
    // before its first import onto a date that already has team history.
    identityRows.push({
      agent_key: 'new_support_agent',
      agent_name: 'New Support Agent',
      dashboard_sync_approved: true
    })
    const [agentHeaders, metricHeaders] = buildProductivityHeaders([
      'Renamed Agent', 'New Support Agent'
    ])
    const row = blankRow(28)
    row[0] = '2026-06-01'
    row[1] = 8
    row[2] = 2
    row[3] = 5.25
    row[4] = 4
    row[5] = 1
    row[6] = 6.5
    payload.datasets.ticketProductivity.values = [
      agentHeaders,
      metricHeaders,
      row
    ]

    const registeredAgentResponse = await sendSync()
    assert.equal(registeredAgentResponse.status, 200)
    assert.deepEqual(
      productivityRows
        .filter(productivityRow => productivityRow.report_date === '2026-06-01')
        .map(productivityRow => productivityRow.agent_key)
        .sort(),
      ['amora', 'new_support_agent']
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a partial dataset write is marked failed and a replay recovers without duplicate analytics rows', async () => {
  const payload = buildIntegrityPayload()
  const originalFetch = globalThis.fetch
  const analyticsRows = new Map()
  const rawImports = []
  const syncRunUpdates = []
  const upsertRequests = []
  let nextSyncRun = 0
  let failDriversOnce = true

  const upsert = (tableName, records, conflictColumns) => {
    if (!analyticsRows.has(tableName)) analyticsRows.set(tableName, new Map())
    const table = analyticsRows.get(tableName)

    for (const record of records) {
      const key = JSON.stringify(conflictColumns.map(column => record[column]))
      table.set(key, { ...(table.get(key) || {}), ...record })
    }
  }

  globalThis.fetch = async (url, options = {}) => {
    const parsedUrl = new URL(String(url))
    const tableName = parsedUrl.pathname.split('/').at(-1)
    const method = options.method || 'GET'

    if (tableName === 'sheet_sync_runs' && method === 'POST') {
      nextSyncRun += 1
      return new Response(JSON.stringify([{ id: `recovery-${nextSyncRun}` }]), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    if (tableName === 'sheet_sync_runs' && method === 'PATCH') {
      syncRunUpdates.push(JSON.parse(options.body))
      return new Response(null, { status: 204 })
    }

    if (tableName === 'agent_identity_map' && method === 'GET') {
      return new Response('[]', { status: 200 })
    }

    if (tableName === 'agent_productivity' && method === 'GET') {
      return new Response(JSON.stringify([
        ...(analyticsRows.get('agent_productivity')?.values() || [])
      ]), { status: 200 })
    }

    if (tableName === 'raw_sheet_imports' && method === 'POST') {
      rawImports.push(...JSON.parse(options.body))
      return new Response(null, { status: 204 })
    }

    if (method === 'POST') {
      if (tableName === 'ticket_driver_metrics' && failDriversOnce) {
        failDriversOnce = false
        return new Response('isolated test failure', { status: 504 })
      }

      const records = JSON.parse(options.body)
      const conflictColumns = parsedUrl.searchParams.get('on_conflict').split(',')
      upsertRequests.push({
        tableName,
        prefer: options.headers?.Prefer,
        records
      })
      upsert(tableName, records, conflictColumns)
      return new Response(null, { status: 204 })
    }

    throw new Error(`Unexpected Supabase request: ${method} ${parsedUrl}`)
  }

  const sendSync = () => onRequestPost({
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

  try {
    const failedResponse = await sendSync()
    assert.equal(failedResponse.status, 500)
    assert.match((await failedResponse.json()).error, /status 504/)
    assert.deepEqual(syncRunUpdates.map(update => update.status), ['failed'])

    const countsAfterPartialWrite = Object.fromEntries(
      [...analyticsRows].map(([tableName, rows]) => [tableName, rows.size])
    )
    assert.ok(Object.keys(countsAfterPartialWrite).length >= 3)
    assert.ok(Object.values(countsAfterPartialWrite).every(count => count > 0))

    const recoveredResponse = await sendSync()
    assert.equal(recoveredResponse.status, 200)
    assert.deepEqual(syncRunUpdates.map(update => update.status), [
      'failed', 'success'
    ])

    const countsAfterRecovery = Object.fromEntries(
      [...analyticsRows].map(([tableName, rows]) => [tableName, rows.size])
    )
    Object.entries(countsAfterPartialWrite).forEach(([tableName, count]) => {
      assert.equal(countsAfterRecovery[tableName], count)
    })
    assert.ok(countsAfterRecovery.ticket_driver_metrics > 0)
    assert.ok([...analyticsRows.values()].every(rows =>
      [...rows.values()].every(row => row.report_date)
    ))
    assert.ok(upsertRequests.every(request =>
      request.prefer === 'resolution=merge-duplicates,return=minimal'
    ))
    assert.equal(rawImports.length > 0, true)
    assert.ok(rawImports.every(record => record.sync_run_id))
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

