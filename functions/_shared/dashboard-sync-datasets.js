import {
  PHASE_ONE_DASHBOARD_MAPPING
} from '../../config/dashboard-data-mapping.js'
import {
  DISTRIBUTION_MAPPING
} from '../../config/distribution-mapping.js'
import {
  PRODUCTIVITY_MAPPING
} from '../../config/productivity-mapping.js'
import {
  DRIVER_MAPPING,
  validateDriverMapping
} from '../../config/driver-mapping.js'
import {
  buildColumnIndexes,
  extractSheetValues,
  processRows,
  validateSheetPayload
} from './dashboard-sync-data.js'

const MAX_DATASET_ROWS = 1000
const MAX_DATASET_COLUMNS = 100
const REQUIRED_DATASET_KEYS = Object.freeze([
  'dailyVolume',
  'ticketProductivity',
  'dailyDrivers'
])

function normalizeText(value) {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().toLowerCase()
    : ''
}

function isBlank(value) {
  return value === null ||
    value === undefined ||
    (typeof value === 'string' && value.trim() === '')
}

function normalizeDate(value) {
  if (isBlank(value)) return null

  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(
      Date.UTC(1899, 11, 30) + Math.round(value * 86400000)
    )

    return Number.isNaN(date.getTime())
      ? null
      : date.toISOString().slice(0, 10)
  }

  const text = String(value).trim()
  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/)

  if (isoMatch) {
    const candidate = `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`
    const date = new Date(`${candidate}T00:00:00Z`)

    return !Number.isNaN(date.getTime()) &&
      date.toISOString().slice(0, 10) === candidate
      ? candidate
      : null
  }

  const parsedDate = new Date(text)

  return Number.isNaN(parsedDate.getTime())
    ? null
    : parsedDate.toISOString().slice(0, 10)
}

function normalizeInteger(value) {
  if (isBlank(value)) return null

  const number = typeof value === 'number'
    ? value
    : Number(String(value).replace(/[\s,]/g, ''))

  return Number.isFinite(number) &&
    Number.isInteger(number) &&
    number >= 0
    ? number
    : null
}

function normalizeNumber(value) {
  if (isBlank(value)) return null

  const number = typeof value === 'number'
    ? value
    : Number(String(value).replace(/[\s,]/g, ''))

  return Number.isFinite(number) && number >= 0
    ? number
    : null
}

function columnNumberToLetter(columnNumber) {
  let value = columnNumber
  let result = ''

  while (value > 0) {
    const remainder = (value - 1) % 26
    result = String.fromCharCode(65 + remainder) + result
    value = Math.floor((value - 1) / 26)
  }

  return result
}

function buildRawData(headerRows, row) {
  const rawData = {}
  const firstHeaderRow = headerRows[0] || []
  const secondHeaderRow = headerRows[1] || []
  let activeGroup = ''

  row.forEach((value, index) => {
    const firstHeader = String(firstHeaderRow[index] ?? '').trim()
    const secondHeader = String(secondHeaderRow[index] ?? '').trim()

    if (firstHeader) activeGroup = firstHeader

    const sourceColumn = columnNumberToLetter(index + 1)
    const parts = []

    if (index === 0) {
      parts.push(firstHeader || secondHeader || 'DATE')
    } else {
      if (activeGroup) parts.push(activeGroup)
      if (secondHeader) parts.push(secondHeader)
      if (!secondHeader && firstHeader) parts.push(firstHeader)
    }

    const key = parts.length > 0
      ? parts.join(' / ').replace(/\s+/g, ' ').trim()
      : `column_${sourceColumn}`

    rawData[key] = value ?? null
  })

  return rawData
}

function buildRawRecord(
  sheetName,
  headerRows,
  row,
  reportDate,
  syncRunId,
  importedAt
) {
  return {
    sheet_name: sheetName,
    report_date: reportDate,
    raw_data: buildRawData(headerRows, row),
    imported_at: importedAt,
    sync_run_id: syncRunId
  }
}

function getDataset(payload, datasetKey) {
  const dataset = payload?.datasets?.[datasetKey]

  if (!dataset || typeof dataset !== 'object') {
    throw new Error(`Missing required dataset: ${datasetKey}.`)
  }

  return dataset
}

function validateDatasetEnvelope(dataset, expected) {
  if (!Array.isArray(dataset.values) || dataset.values.length === 0) {
    throw new Error(
      `${expected.datasetLabel} must include a non-empty values array.`
    )
  }

  if (dataset.values.length > MAX_DATASET_ROWS) {
    throw new Error(
      `${expected.datasetLabel} exceeds ${MAX_DATASET_ROWS} rows.`
    )
  }

  const receivedSheetName = normalizeText(dataset.sheetName)
  const expectedSheetName = normalizeText(expected.sheetName)

  if (receivedSheetName !== expectedSheetName) {
    throw new Error(
      `${expected.datasetLabel} uses an unexpected worksheet name.`
    )
  }

  if (
    dataset.columnCount !== undefined &&
    Number(dataset.columnCount) !== expected.columnCount
  ) {
    throw new Error(
      `${expected.datasetLabel} must contain ${expected.columnCount} columns.`
    )
  }

  if (
    dataset.headerRows !== undefined &&
    Number(dataset.headerRows) !== expected.headerRows
  ) {
    throw new Error(
      `${expected.datasetLabel} must contain ${expected.headerRows} header rows.`
    )
  }

  if (
    dataset.dataStartRow !== undefined &&
    Number(dataset.dataStartRow) !== expected.dataStartRow
  ) {
    throw new Error(
      `${expected.datasetLabel} data must begin on row ${expected.dataStartRow}.`
    )
  }

  dataset.values.forEach((row, rowIndex) => {
    if (!Array.isArray(row)) {
      throw new Error(
        `${expected.datasetLabel} row ${rowIndex + 1} is not an array.`
      )
    }

    if (row.length > MAX_DATASET_COLUMNS) {
      throw new Error(
        `${expected.datasetLabel} exceeds ${MAX_DATASET_COLUMNS} columns.`
      )
    }

    if (row.length !== expected.columnCount) {
      throw new Error(
        `${expected.datasetLabel} row ${rowIndex + 1} contains ` +
        `${row.length} columns instead of ${expected.columnCount}.`
      )
    }
  })
}

function assertHeader(actual, expected, description) {
  if (normalizeText(actual) !== normalizeText(expected)) {
    throw new Error(
      `${description} does not match the configured workbook mapping.`
    )
  }
}

function validateDistributionHeaders(dataset) {
  const headers = dataset.values[0]

  assertHeader(
    headers[DISTRIBUTION_MAPPING.source.dateColumn.sourceIndex],
    DISTRIBUTION_MAPPING.source.dateColumn.sourceHeader,
    'Daily Volume date header'
  )

  DISTRIBUTION_MAPPING.columns.forEach(column => {
    assertHeader(
      headers[column.sourceIndex],
      column.sourceHeader,
      `Daily Volume column ${column.sourceColumn}`
    )
  })
}

function validateProductivityHeaders(dataset) {
  const agentHeaderRow = dataset.values[0]
  const metricHeaderRow = dataset.values[1]

  assertHeader(
    agentHeaderRow[PRODUCTIVITY_MAPPING.source.dateColumn.sourceIndex],
    PRODUCTIVITY_MAPPING.source.dateColumn.sourceHeader,
    'Ticket Productivity date header'
  )

  PRODUCTIVITY_MAPPING.agents.forEach(agent => {
    const firstMetric = agent.metrics[0]
    const acceptedNames = [
      agent.sourceName,
      ...agent.sourceNameAliases
    ].map(normalizeText)

    if (!acceptedNames.includes(
      normalizeText(agentHeaderRow[firstMetric.sourceIndex])
    )) {
      throw new Error(
        `Ticket Productivity agent header ${agent.agentName} ` +
        'does not match the configured workbook mapping.'
      )
    }

    agent.metrics.forEach(metric => {
      assertHeader(
        metricHeaderRow[metric.sourceIndex],
        metric.sourceHeader,
        `Ticket Productivity column ${metric.sourceColumn}`
      )
    })
  })
}

function validateDriverHeaders(dataset) {
  const sourceKeyRow = dataset.values[0]
  const displayLabelRow = dataset.values[1]
  const mappingErrors = validateDriverMapping()

  if (mappingErrors.length > 0) {
    throw new Error(
      `Ticket driver mapping is invalid: ${mappingErrors.join(' ')}`
    )
  }

  assertHeader(
    displayLabelRow[DRIVER_MAPPING.source.dateColumn.sourceIndex],
    DRIVER_MAPPING.source.dateColumn.sourceHeader,
    'Daily Drivers date header'
  )

  DRIVER_MAPPING.columns.forEach(column => {
    assertHeader(
      sourceKeyRow[column.sourceIndex],
      column.sourceKey,
      `Daily Drivers key in column ${column.sourceColumn}`
    )
    assertHeader(
      displayLabelRow[column.sourceIndex],
      column.sourceLabel,
      `Daily Drivers label in column ${column.sourceColumn}`
    )
  })
}

export function isMultiDatasetPayload(payload) {
  return payload?.payloadVersion === 2 &&
    payload?.datasets &&
    typeof payload.datasets === 'object'
}

export function validateMultiDatasetPayload(payload) {
  if (!isMultiDatasetPayload(payload)) {
    throw new Error(
      'The multi-dataset request must use payloadVersion 2.'
    )
  }

  REQUIRED_DATASET_KEYS.forEach(datasetKey => {
    getDataset(payload, datasetKey)
  })

  const dailyVolume = getDataset(payload, 'dailyVolume')
  const ticketProductivity = getDataset(
    payload,
    'ticketProductivity'
  )
  const dailyDrivers = getDataset(payload, 'dailyDrivers')

  validateDatasetEnvelope(dailyVolume, {
    datasetLabel: 'Daily Volume',
    sheetName: DISTRIBUTION_MAPPING.source.sheetName,
    columnCount: 19,
    headerRows: 1,
    dataStartRow: 2
  })
  validateDatasetEnvelope(ticketProductivity, {
    datasetLabel: 'Ticket Productivity',
    sheetName: PRODUCTIVITY_MAPPING.source.sheetName,
    columnCount: 25,
    headerRows: 2,
    dataStartRow: 3
  })
  validateDatasetEnvelope(dailyDrivers, {
    datasetLabel: 'Daily Drivers',
    sheetName: DRIVER_MAPPING.source.sheetName,
    columnCount: 73,
    headerRows: 2,
    dataStartRow: 3
  })

  validateDistributionHeaders(dailyVolume)
  validateProductivityHeaders(ticketProductivity)
  validateDriverHeaders(dailyDrivers)
}

function processDistributionDataset(dataset, importedAt) {
  const rows = dataset.values.slice(1)
  const importedRecords = []
  const warnings = []
  let ignoredRows = 0
  let skippedRecords = 0

  rows.forEach((row, rowIndex) => {
    const sourceRowNumber = rowIndex + 2
    const rawDate = row[
      DISTRIBUTION_MAPPING.source.dateColumn.sourceIndex
    ]
    const reportDate = normalizeDate(rawDate)
    const hasAnyValue = DISTRIBUTION_MAPPING.columns.some(
      column => !isBlank(row[column.sourceIndex])
    )

    if (isBlank(rawDate) && !hasAnyValue) {
      ignoredRows += 1
      return
    }

    if (!reportDate) {
      skippedRecords += 1
      warnings.push(
        `Daily Volume row ${sourceRowNumber} has an invalid date.`
      )
      return
    }

    if (!hasAnyValue) {
      ignoredRows += 1
      return
    }

    DISTRIBUTION_MAPPING.columns.forEach(column => {
      const sourceValue = row[column.sourceIndex]

      if (isBlank(sourceValue)) {
        skippedRecords += 1
        warnings.push(
          `Daily Volume row ${sourceRowNumber}, column ` +
          `${column.sourceColumn} is blank and was not imported.`
        )
        return
      }

      const ticketCount = normalizeInteger(sourceValue)

      if (ticketCount === null) {
        skippedRecords += 1
        warnings.push(
          `Daily Volume row ${sourceRowNumber}, column ` +
          `${column.sourceColumn} is not a valid non-negative integer.`
        )
        return
      }

      importedRecords.push({
        report_date: reportDate,
        dimension_type: column.dimensionType,
        dimension_key: column.dimensionKey,
        dimension_label: column.dimensionLabel,
        ticket_count: ticketCount,
        updated_at: importedAt
      })
    })
  })

  return {
    importedRecords,
    rawRecords: [],
    warnings,
    ignoredRows,
    skippedRecords
  }
}

function processProductivityDataset(dataset, syncRunId, importedAt) {
  const headerRows = dataset.values.slice(0, 2)
  const rows = dataset.values.slice(2)
  const importedRecords = []
  const rawRecords = []
  const warnings = []
  let ignoredRows = 0
  let skippedRecords = 0

  rows.forEach((row, rowIndex) => {
    const sourceRowNumber = rowIndex + 3
    const rawDate = row[
      PRODUCTIVITY_MAPPING.source.dateColumn.sourceIndex
    ]
    const reportDate = normalizeDate(rawDate)
    const hasAnyMetricValue = PRODUCTIVITY_MAPPING.agents.some(
      agent => agent.metrics.some(
        metric => !isBlank(row[metric.sourceIndex])
      )
    )

    if (isBlank(rawDate) && !hasAnyMetricValue) {
      ignoredRows += 1
      return
    }

    rawRecords.push(buildRawRecord(
      PRODUCTIVITY_MAPPING.source.sheetName,
      headerRows,
      row,
      reportDate,
      syncRunId,
      importedAt
    ))

    if (!reportDate) {
      skippedRecords += 1
      warnings.push(
        `Ticket Productivity row ${sourceRowNumber} has an invalid date.`
      )
      return
    }

    if (!hasAnyMetricValue) {
      ignoredRows += 1
      return
    }

    PRODUCTIVITY_MAPPING.agents.forEach(agent => {
      const valuesByTarget = new Map(
        agent.metrics.map(metric => [
          metric.targetColumn,
          row[metric.sourceIndex]
        ])
      )
      const allBlank = agent.metrics.every(
        metric => isBlank(row[metric.sourceIndex])
      )

      if (allBlank) return

      const solvedTickets = normalizeInteger(
        valuesByTarget.get('solved_tickets')
      )
      const openTickets = normalizeInteger(
        valuesByTarget.get('open_tickets')
      )
      const ahtValue = normalizeNumber(
        valuesByTarget.get('aht_value')
      )
      const invalidFields = []

      if (solvedTickets === null) {
        invalidFields.push('Solved Ticket')
      }

      if (
        !isBlank(valuesByTarget.get('open_tickets')) &&
        openTickets === null
      ) {
        invalidFields.push('Open Tickets')
      }

      if (
        !isBlank(valuesByTarget.get('aht_value')) &&
        ahtValue === null
      ) {
        invalidFields.push('AHT')
      }

      if (invalidFields.length > 0) {
        skippedRecords += 1
        warnings.push(
          `Ticket Productivity row ${sourceRowNumber}, ` +
          `${agent.agentName} was skipped because these fields are ` +
          `invalid: ${invalidFields.join(', ')}.`
        )
        return
      }

      importedRecords.push({
        report_date: reportDate,
        agent_key: agent.agentKey,
        agent_name: agent.agentName,
        solved_tickets: solvedTickets,
        open_tickets: openTickets,
        aht_value: ahtValue,
        aht_unit: PRODUCTIVITY_MAPPING.defaults.ahtUnit,
        updated_at: importedAt
      })
    })
  })

  return {
    importedRecords,
    rawRecords,
    warnings,
    ignoredRows,
    skippedRecords
  }
}

function processDriverDataset(dataset, syncRunId, importedAt) {
  const headerRows = dataset.values.slice(0, 2)
  const rows = dataset.values.slice(2)
  const importedRecords = []
  const rawRecords = []
  const warnings = []
  let ignoredRows = 0
  let skippedRecords = 0

  rows.forEach((row, rowIndex) => {
    const sourceRowNumber = rowIndex + 3
    const rawDate = row[
      DRIVER_MAPPING.source.dateColumn.sourceIndex
    ]
    const reportDate = normalizeDate(rawDate)
    const hasAnyDriverValue = DRIVER_MAPPING.columns.some(
      column => !isBlank(row[column.sourceIndex])
    )

    if (isBlank(rawDate) && !hasAnyDriverValue) {
      ignoredRows += 1
      return
    }

    rawRecords.push(buildRawRecord(
      DRIVER_MAPPING.source.sheetName,
      headerRows,
      row,
      reportDate,
      syncRunId,
      importedAt
    ))

    if (!reportDate) {
      skippedRecords += 1
      warnings.push(
        `Daily Drivers row ${sourceRowNumber} has an invalid date.`
      )
      return
    }

    if (!hasAnyDriverValue) {
      ignoredRows += 1
      return
    }

    DRIVER_MAPPING.columns.forEach(column => {
      const sourceValue = row[column.sourceIndex]

      if (isBlank(sourceValue)) return

      const ticketCount = normalizeInteger(sourceValue)

      if (ticketCount === null) {
        skippedRecords += 1
        warnings.push(
          `Daily Drivers row ${sourceRowNumber}, column ` +
          `${column.sourceColumn} is not a valid non-negative integer.`
        )
        return
      }

      importedRecords.push({
        report_date: reportDate,
        driver_group_key: column.groupKey,
        driver_group_label: column.groupLabel,
        driver_key: column.driverKey,
        driver_label: column.driverLabel,
        ticket_count: ticketCount,
        source_column: column.sourceColumn,
        updated_at: importedAt
      })
    })
  })

  return {
    importedRecords,
    rawRecords,
    warnings,
    ignoredRows,
    skippedRecords
  }
}

export function processMultiDatasetPayload(payload, syncRunId) {
  const importedAt = new Date().toISOString()
  const dailyVolumeDataset = getDataset(payload, 'dailyVolume')
  const productivityDataset = getDataset(
    payload,
    'ticketProductivity'
  )
  const driverDataset = getDataset(payload, 'dailyDrivers')

  const dailySheetData = extractSheetValues(dailyVolumeDataset)
  validateSheetPayload(dailySheetData)
  const dailyIndexes = buildColumnIndexes(dailySheetData.headers)
  const dailyMetrics = processRows(
    dailySheetData.headers,
    dailySheetData.rows,
    dailyIndexes,
    syncRunId
  )
  const distributions = processDistributionDataset(
    dailyVolumeDataset,
    importedAt
  )
  const productivity = processProductivityDataset(
    productivityDataset,
    syncRunId,
    importedAt
  )
  const drivers = processDriverDataset(
    driverDataset,
    syncRunId,
    importedAt
  )

  return {
    dailyMetrics,
    distributions,
    productivity,
    drivers,
    rawRecords: [
      ...dailyMetrics.rawRecords,
      ...productivity.rawRecords,
      ...drivers.rawRecords
    ],
    warnings: [
      ...dailyMetrics.warnings,
      ...distributions.warnings,
      ...productivity.warnings,
      ...drivers.warnings
    ]
  }
}

export function getMultiDatasetSummary(result) {
  const rowsImported =
    result.dailyMetrics.importedRecords.length +
    result.distributions.importedRecords.length +
    result.productivity.importedRecords.length +
    result.drivers.importedRecords.length

  return {
    rowsImported,
    rowsSkipped:
      result.dailyMetrics.skippedRows +
      result.distributions.skippedRecords +
      result.productivity.skippedRecords +
      result.drivers.skippedRecords,
    rowsIgnored:
      Math.max(
        result.dailyMetrics.ignoredRows,
        result.distributions.ignoredRows
      ) +
      result.productivity.ignoredRows +
      result.drivers.ignoredRows,
    datasets: {
      dailyVolume: {
        metricRowsImported:
          result.dailyMetrics.importedRecords.length,
        distributionRecordsImported:
          result.distributions.importedRecords.length,
        rowsSkipped:
          result.dailyMetrics.skippedRows +
          result.distributions.skippedRecords,
        rowsIgnored: Math.max(
          result.dailyMetrics.ignoredRows,
          result.distributions.ignoredRows
        )
      },
      ticketProductivity: {
        recordsImported: result.productivity.importedRecords.length,
        recordsSkipped: result.productivity.skippedRecords,
        rowsIgnored: result.productivity.ignoredRows
      },
      dailyDrivers: {
        recordsImported: result.drivers.importedRecords.length,
        recordsSkipped: result.drivers.skippedRecords,
        rowsIgnored: result.drivers.ignoredRows
      }
    }
  }
}

export const MULTI_DATASET_DESTINATIONS = Object.freeze({
  dailyMetrics: Object.freeze({
    tableName: PHASE_ONE_DASHBOARD_MAPPING.destination.tableName,
    conflictColumns: Object.freeze([
      PHASE_ONE_DASHBOARD_MAPPING.destination.conflictColumn
    ])
  }),
  distributions: DISTRIBUTION_MAPPING.destination,
  productivity: PRODUCTIVITY_MAPPING.destination,
  drivers: DRIVER_MAPPING.destination
})
