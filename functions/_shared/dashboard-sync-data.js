import {
  PHASE_ONE_DASHBOARD_MAPPING,
  findPhaseOneColumnBySourceHeader
} from '../../config/dashboard-data-mapping.js'

const MAX_ROWS = 1000
const MAX_COLUMNS = 50

function normalizeHeader(value) {
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

  const shortMatch = text.match(
    /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/
  )

  if (shortMatch) {
    const month = Number(shortMatch[1])
    const day = Number(shortMatch[2])
    const year = Number(shortMatch[3])
    const date = new Date(Date.UTC(year, month - 1, day))

    return date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
      ? date.toISOString().slice(0, 10)
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

function normalizePercentage(value) {
  if (isBlank(value)) return null

  const text = String(value).trim()
  const hasPercentSign = text.includes('%')
  let number = Number(text.replace(/[\s,%]/g, ''))

  if (!Number.isFinite(number)) return null
  if (hasPercentSign || number > 1) number /= 100

  return number >= 0 && number <= 1
    ? number
    : null
}

function normalizeValue(value, type) {
  if (type === 'date') return normalizeDate(value)
  if (type === 'integer') return normalizeInteger(value)
  if (type === 'percentage') return normalizePercentage(value)
  return isBlank(value) ? null : value
}

export function extractSheetValues(payload) {
  if (Array.isArray(payload?.values) && payload.values.length > 0) {
    return {
      sheetName: payload.sheetName,
      headers: payload.values[0],
      rows: payload.values.slice(1)
    }
  }

  if (Array.isArray(payload?.headers) && Array.isArray(payload?.rows)) {
    return {
      sheetName: payload.sheetName,
      headers: payload.headers,
      rows: payload.rows
    }
  }

  throw new Error(
    'The request must include either values or headers and rows arrays.'
  )
}

export function validateSheetPayload(sheetData) {
  if (!Array.isArray(sheetData.headers)) {
    throw new Error('The spreadsheet header row is missing.')
  }

  if (!Array.isArray(sheetData.rows)) {
    throw new Error('The spreadsheet data rows are missing.')
  }

  if (sheetData.headers.length > MAX_COLUMNS) {
    throw new Error(`The spreadsheet exceeds ${MAX_COLUMNS} columns.`)
  }

  if (sheetData.rows.length > MAX_ROWS) {
    throw new Error(`The spreadsheet exceeds ${MAX_ROWS} rows.`)
  }

  const expectedName = normalizeHeader(
    PHASE_ONE_DASHBOARD_MAPPING.source.sheetName
  )
  const receivedName = normalizeHeader(sheetData.sheetName)

  if (receivedName && receivedName !== expectedName) {
    throw new Error(
      `Unexpected worksheet. Expected ${PHASE_ONE_DASHBOARD_MAPPING.source.sheetName.trim()}.`
    )
  }
}

export function buildColumnIndexes(headers) {
  const indexes = new Map()

  headers.forEach((header, index) => {
    const mapping = findPhaseOneColumnBySourceHeader(String(header ?? ''))
    if (!mapping) return

    if (indexes.has(mapping.targetColumn)) {
      throw new Error(
        `Duplicate spreadsheet header for ${mapping.targetColumn}.`
      )
    }

    indexes.set(mapping.targetColumn, index)
  })

  const missing = PHASE_ONE_DASHBOARD_MAPPING.columns
    .filter(column => column.required)
    .filter(column => !indexes.has(column.targetColumn))
    .map(column => column.sourceHeader.replace(/\s+/g, ' ').trim())

  if (missing.length > 0) {
    throw new Error(
      `Required spreadsheet headers are missing: ${missing.join(', ')}.`
    )
  }

  return indexes
}

function buildRawRow(headers, row) {
  const rawRow = {}

  headers.forEach((header, index) => {
    const fallback = `column_${index + 1}`
    const key = String(header || fallback).replace(/\s+/g, ' ').trim()
    rawRow[key || fallback] = row[index] ?? null
  })

  return rawRow
}

export function processRows(headers, rows, indexes, syncRunId) {
  const importedRecords = []
  const rawRecords = []
  const warnings = []
  let ignoredRows = 0
  let skippedRows = 0

  const metricColumns = PHASE_ONE_DASHBOARD_MAPPING.columns.filter(
    column => column.targetColumn !== 'report_date'
  )

  rows.forEach((row, rowIndex) => {
    if (!Array.isArray(row)) {
      skippedRows += 1
      warnings.push(`Row ${rowIndex + 2} is not an array.`)
      return
    }

    const rawDateValue = row[indexes.get('report_date')]
    const reportDate = normalizeDate(rawDateValue)
    const hasAnyMetricValue = metricColumns.some(column =>
      !isBlank(row[indexes.get(column.targetColumn)])
    )

    if (isBlank(rawDateValue) && !hasAnyMetricValue) {
      ignoredRows += 1
      return
    }

    rawRecords.push({
      sheet_name: PHASE_ONE_DASHBOARD_MAPPING.source.sheetName,
      report_date: reportDate,
      raw_data: buildRawRow(headers, row),
      imported_at: new Date().toISOString(),
      sync_run_id: syncRunId
    })

    if (reportDate && !hasAnyMetricValue) {
      ignoredRows += 1
      return
    }

    const record = {}
    const invalidFields = []

    PHASE_ONE_DASHBOARD_MAPPING.columns.forEach(column => {
      const sourceValue = row[indexes.get(column.targetColumn)]
      const normalizedValue = normalizeValue(sourceValue, column.valueType)
      record[column.targetColumn] = normalizedValue

      if (column.required && normalizedValue === null) {
        invalidFields.push(
          column.sourceHeader.replace(/\s+/g, ' ').trim()
        )
      }
    })

    if (invalidFields.length > 0) {
      skippedRows += 1
      warnings.push(
        `Row ${rowIndex + 2} was skipped because these fields are invalid or incomplete: ${invalidFields.join(', ')}.`
      )
      return
    }

    record.updated_at = new Date().toISOString()
    importedRecords.push(record)
  })

  return {
    importedRecords,
    rawRecords,
    warnings,
    ignoredRows,
    skippedRows
  }
}

export function getLatestReportDate(records) {
  return records.reduce(
    (latest, record) =>
      !latest || record.report_date > latest
        ? record.report_date
        : latest,
    null
  )
}
