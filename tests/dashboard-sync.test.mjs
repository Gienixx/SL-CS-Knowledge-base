import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PHASE_ONE_DASHBOARD_MAPPING
} from '../config/dashboard-data-mapping.js'
import {
  DISTRIBUTION_MAPPING
} from '../config/distribution-mapping.js'
import {
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

function buildProductivityHeaders() {
  const agentHeaders = blankRow(25)
  const metricHeaders = blankRow(25)
  agentHeaders[0] = PRODUCTIVITY_MAPPING.source.dateColumn.sourceHeader

  PRODUCTIVITY_MAPPING.agents.forEach(agent => {
    agentHeaders[agent.metrics[0].sourceIndex] = agent.sourceName
    agent.metrics.forEach(metric => {
      metricHeaders[metric.sourceIndex] = metric.sourceHeader
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
  const amora = PRODUCTIVITY_MAPPING.agents[0]
  validAgentRow[amora.metrics[0].sourceIndex] = 0
  validAgentRow[amora.metrics[1].sourceIndex] = 0
  validAgentRow[amora.metrics[2].sourceIndex] = 0

  const negativeAgentRow = blankRow(25)
  negativeAgentRow[0] = '2026-06-02'
  const ford = PRODUCTIVITY_MAPPING.agents[1]
  negativeAgentRow[ford.metrics[0].sourceIndex] = -1

  const partialAgentRow = blankRow(25)
  partialAgentRow[0] = '2026-06-03'
  const gen = PRODUCTIVITY_MAPPING.agents[2]
  partialAgentRow[gen.metrics[0].sourceIndex] = 2
  partialAgentRow[gen.metrics[1].sourceIndex] = -1

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
