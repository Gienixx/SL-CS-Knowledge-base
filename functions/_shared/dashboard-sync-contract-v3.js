import {
  getPhase3Step9ExpectedDictionaryRows,
  PHASE3_STEP9_ALLOWED_DIMENSION_TYPES,
  PHASE3_STEP9_CONTRACT_KEY,
  PHASE3_STEP9_CONTRACT_VERSION,
  PHASE3_STEP9_REQUIRED_DATASET_KEYS,
  PHASE3_STEP9_TABS,
  validatePhase3Step9ContractDefinition
} from '../../config/phase3-step9-sheet-contract.js'

const MAX_ROWS_PER_DATASET = 10000
const AGENT_KEY_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/
const DIMENSION_KEY_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/
const EPSILON = 0.01

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function normalizeHeader(value) {
  return normalizeText(value).toLowerCase()
}

function isBlank(value) {
  return value === null ||
    value === undefined ||
    (typeof value === 'string' && value.trim() === '')
}

function normalizeDate(value, label) {
  const text = normalizeText(value)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error(`${label} must use YYYY-MM-DD.`)
  }

  const date = new Date(`${text}T00:00:00Z`)
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== text
  ) {
    throw new Error(`${label} is not a valid date.`)
  }

  return text
}

function normalizeDateTime(value, label) {
  const text = normalizeText(value)
  const date = new Date(text)
  if (!text || Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be an ISO-8601 date and time.`)
  }
  return date.toISOString()
}

function normalizeInteger(value, label) {
  if (isBlank(value)) throw new Error(`${label} is required.`)
  const number = typeof value === 'number'
    ? value
    : Number(String(value).replace(/[\s,]/g, ''))

  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${label} must be a non-negative integer.`)
  }

  return number
}

function normalizeNumber(value, label) {
  if (isBlank(value)) throw new Error(`${label} is required.`)
  const number = typeof value === 'number'
    ? value
    : Number(String(value).replace(/[\s,]/g, ''))

  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${label} must be a non-negative number.`)
  }

  return number
}

function normalizeRate(value, label) {
  const number = normalizeNumber(value, label)
  if (number > 1) {
    throw new Error(`${label} must be a decimal from 0 through 1.`)
  }
  return number
}

function normalizeBoolean(value, label) {
  if (value === true || value === false) return value
  const text = normalizeHeader(value)
  if (['true', 'yes', '1'].includes(text)) return true
  if (['false', 'no', '0'].includes(text)) return false
  throw new Error(`${label} must be TRUE or FALSE.`)
}

function makeRowObject(headers, row) {
  return Object.fromEntries(
    headers.map((header, index) => [header, row[index]])
  )
}

function isBlankRow(row) {
  return row.every(isBlank)
}

function getDataset(payload, datasetKey) {
  const dataset = payload?.datasets?.[datasetKey]
  if (!dataset || typeof dataset !== 'object') {
    throw new Error(`Missing required dataset: ${datasetKey}.`)
  }
  return dataset
}

function validateDataset(dataset, tab) {
  if (normalizeHeader(dataset.sheetName) !== normalizeHeader(tab.sheetName)) {
    throw new Error(
      `${tab.datasetKey} must use the worksheet name ${tab.sheetName}.`
    )
  }

  if (!Array.isArray(dataset.values) || dataset.values.length === 0) {
    throw new Error(`${tab.sheetName} must include a header row.`)
  }

  if (dataset.values.length > MAX_ROWS_PER_DATASET + 1) {
    throw new Error(
      `${tab.sheetName} exceeds ${MAX_ROWS_PER_DATASET} data rows.`
    )
  }

  const expectedHeaders = tab.columns.map(definition => definition.name)
  const receivedHeaders = dataset.values[0].map(normalizeHeader)

  if (receivedHeaders.length !== expectedHeaders.length) {
    throw new Error(
      `${tab.sheetName} must contain ${expectedHeaders.length} columns.`
    )
  }

  expectedHeaders.forEach((header, index) => {
    if (receivedHeaders[index] !== normalizeHeader(header)) {
      throw new Error(
        `${tab.sheetName} column ${index + 1} must be ${header}.`
      )
    }
  })

  dataset.values.slice(1).forEach((row, index) => {
    if (!Array.isArray(row)) {
      throw new Error(`${tab.sheetName} row ${index + 2} is not an array.`)
    }
    if (row.length !== expectedHeaders.length) {
      throw new Error(
        `${tab.sheetName} row ${index + 2} must contain ` +
        `${expectedHeaders.length} columns.`
      )
    }
  })
}

function buildRawRecord(
  tab,
  headers,
  row,
  reportDate,
  syncRunId,
  importedAt
) {
  return {
    sheet_name: tab.sheetName,
    report_date: reportDate,
    raw_data: makeRowObject(headers, row),
    imported_at: importedAt,
    sync_run_id: syncRunId
  }
}

function assertUnique(records, keyFields, label) {
  const seen = new Set()
  records.forEach((record, index) => {
    const key = JSON.stringify(keyFields.map(field => record[field]))
    if (seen.has(key)) {
      throw new Error(`${label} contains a duplicate logical key at row ${index + 2}.`)
    }
    seen.add(key)
  })
}

function processDailyTicketMetrics(dataset, syncRunId, importedAt) {
  const tab = PHASE3_STEP9_TABS.dailyTicketMetrics
  const headers = tab.columns.map(definition => definition.name)
  const records = []
  const rawRecords = []

  dataset.values.slice(1).forEach((row, index) => {
    if (isBlankRow(row)) return
    const rowNumber = index + 2
    const source = makeRowObject(headers, row)
    const reportDate = normalizeDate(
      source.report_date,
      `${tab.sheetName} row ${rowNumber} report_date`
    )
    const record = {
      report_date: reportDate,
      new_tickets: normalizeInteger(source.new_tickets, `${tab.sheetName} row ${rowNumber} new_tickets`),
      solved_tickets: normalizeInteger(source.solved_tickets, `${tab.sheetName} row ${rowNumber} solved_tickets`),
      unsolved_tickets: normalizeInteger(source.unsolved_tickets, `${tab.sheetName} row ${rowNumber} unsolved_tickets`),
      one_touch_resolution: normalizeRate(source.one_touch_resolution, `${tab.sheetName} row ${rowNumber} one_touch_resolution`),
      reopened_rate: normalizeRate(source.reopened_rate, `${tab.sheetName} row ${rowNumber} reopened_rate`),
      responded_tickets: normalizeInteger(source.responded_tickets, `${tab.sheetName} row ${rowNumber} responded_tickets`),
      first_response_minutes_total: normalizeNumber(source.first_response_minutes_total, `${tab.sheetName} row ${rowNumber} first_response_minutes_total`),
      first_response_median_minutes: normalizeNumber(source.first_response_median_minutes, `${tab.sheetName} row ${rowNumber} first_response_median_minutes`),
      resolved_tickets: normalizeInteger(source.resolved_tickets, `${tab.sheetName} row ${rowNumber} resolved_tickets`),
      resolution_minutes_total: normalizeNumber(source.resolution_minutes_total, `${tab.sheetName} row ${rowNumber} resolution_minutes_total`),
      resolution_median_minutes: normalizeNumber(source.resolution_median_minutes, `${tab.sheetName} row ${rowNumber} resolution_median_minutes`),
      reopened_tickets: normalizeInteger(source.reopened_tickets, `${tab.sheetName} row ${rowNumber} reopened_tickets`),
      one_touch_tickets: normalizeInteger(source.one_touch_tickets, `${tab.sheetName} row ${rowNumber} one_touch_tickets`),
      updated_at: importedAt
    }

    if (record.one_touch_tickets > record.resolved_tickets) {
      throw new Error(
        `${tab.sheetName} row ${rowNumber} one_touch_tickets cannot exceed resolved_tickets.`
      )
    }

    const expectedOneTouchRate = record.resolved_tickets > 0
      ? record.one_touch_tickets / record.resolved_tickets
      : 0
    const expectedReopenedRate = record.resolved_tickets > 0
      ? record.reopened_tickets / record.resolved_tickets
      : 0

    if (Math.abs(record.one_touch_resolution - expectedOneTouchRate) > 0.0001) {
      throw new Error(
        `${tab.sheetName} row ${rowNumber} one_touch_resolution does not reconcile.`
      )
    }
    if (Math.abs(record.reopened_rate - expectedReopenedRate) > 0.0001) {
      throw new Error(
        `${tab.sheetName} row ${rowNumber} reopened_rate does not reconcile.`
      )
    }

    records.push(record)
    rawRecords.push(buildRawRecord(
      tab,
      headers,
      row,
      reportDate,
      syncRunId,
      importedAt
    ))
  })

  assertUnique(records, ['report_date'], tab.sheetName)
  return { records, rawRecords }
}

function processTicketProductivity(dataset, syncRunId, importedAt) {
  const tab = PHASE3_STEP9_TABS.ticketProductivity
  const headers = tab.columns.map(definition => definition.name)
  const records = []
  const rawRecords = []
  const agentNames = new Map()

  dataset.values.slice(1).forEach((row, index) => {
    if (isBlankRow(row)) return
    const rowNumber = index + 2
    const source = makeRowObject(headers, row)
    const agentKey = normalizeHeader(source.agent_key)
    const agentName = normalizeText(source.agent_name)

    if (!AGENT_KEY_PATTERN.test(agentKey)) {
      throw new Error(
        `${tab.sheetName} row ${rowNumber} agent_key is invalid.`
      )
    }
    if (!agentName) {
      throw new Error(
        `${tab.sheetName} row ${rowNumber} agent_name is required.`
      )
    }

    const existingName = agentNames.get(agentKey)
    if (
      existingName &&
      normalizeHeader(existingName) !== normalizeHeader(agentName)
    ) {
      throw new Error(
        `agent_key ${agentKey} maps to more than one agent_name.`
      )
    }
    agentNames.set(agentKey, agentName)

    const handledTickets = normalizeInteger(
      source.handled_tickets,
      `${tab.sheetName} row ${rowNumber} handled_tickets`
    )
    const respondedTickets = normalizeInteger(
      source.responded_tickets,
      `${tab.sheetName} row ${rowNumber} responded_tickets`
    )
    const resolvedTickets = normalizeInteger(
      source.resolved_tickets,
      `${tab.sheetName} row ${rowNumber} resolved_tickets`
    )
    const oneTouchTickets = normalizeInteger(
      source.one_touch_tickets,
      `${tab.sheetName} row ${rowNumber} one_touch_tickets`
    )

    if (respondedTickets > handledTickets) {
      throw new Error(
        `${tab.sheetName} row ${rowNumber} responded_tickets cannot exceed handled_tickets.`
      )
    }
    if (resolvedTickets > handledTickets) {
      throw new Error(
        `${tab.sheetName} row ${rowNumber} resolved_tickets cannot exceed handled_tickets.`
      )
    }
    if (oneTouchTickets > resolvedTickets) {
      throw new Error(
        `${tab.sheetName} row ${rowNumber} one_touch_tickets cannot exceed resolved_tickets.`
      )
    }

    const handleMinutesTotal = normalizeNumber(
      source.handle_minutes_total,
      `${tab.sheetName} row ${rowNumber} handle_minutes_total`
    )
    const record = {
      report_date: normalizeDate(
        source.report_date,
        `${tab.sheetName} row ${rowNumber} report_date`
      ),
      agent_key: agentKey,
      agent_name: agentName,
      solved_tickets: normalizeInteger(source.solved_tickets, `${tab.sheetName} row ${rowNumber} solved_tickets`),
      open_tickets: normalizeInteger(source.open_tickets, `${tab.sheetName} row ${rowNumber} open_tickets`),
      handled_tickets: handledTickets,
      handle_minutes_total: handleMinutesTotal,
      responded_tickets: respondedTickets,
      first_response_minutes_total: normalizeNumber(source.first_response_minutes_total, `${tab.sheetName} row ${rowNumber} first_response_minutes_total`),
      first_response_median_minutes: normalizeNumber(source.first_response_median_minutes, `${tab.sheetName} row ${rowNumber} first_response_median_minutes`),
      resolved_tickets: resolvedTickets,
      resolution_minutes_total: normalizeNumber(source.resolution_minutes_total, `${tab.sheetName} row ${rowNumber} resolution_minutes_total`),
      resolution_median_minutes: normalizeNumber(source.resolution_median_minutes, `${tab.sheetName} row ${rowNumber} resolution_median_minutes`),
      reopened_tickets: normalizeInteger(source.reopened_tickets, `${tab.sheetName} row ${rowNumber} reopened_tickets`),
      one_touch_tickets: oneTouchTickets,
      worked_hours: normalizeNumber(source.worked_hours, `${tab.sheetName} row ${rowNumber} worked_hours`),
      aht_value: handledTickets > 0
        ? handleMinutesTotal / handledTickets
        : null,
      aht_unit: 'minutes.seconds',
      updated_at: importedAt
    }

    records.push(record)
    rawRecords.push(buildRawRecord(
      tab,
      headers,
      row,
      record.report_date,
      syncRunId,
      importedAt
    ))
  })

  assertUnique(records, ['report_date', 'agent_key'], tab.sheetName)
  return { records, rawRecords, agentNames }
}

function processAgentDimensionMetrics(
  dataset,
  productivityRecords,
  agentNames,
  syncRunId,
  importedAt
) {
  const tab = PHASE3_STEP9_TABS.agentDimensionMetrics
  const headers = tab.columns.map(definition => definition.name)
  const records = []
  const rawRecords = []
  const productivityKeys = new Set(
    productivityRecords.map(record =>
      `${record.report_date}\u0000${record.agent_key}`
    )
  )

  dataset.values.slice(1).forEach((row, index) => {
    if (isBlankRow(row)) return
    const rowNumber = index + 2
    const source = makeRowObject(headers, row)
    const reportDate = normalizeDate(
      source.report_date,
      `${tab.sheetName} row ${rowNumber} report_date`
    )
    const agentKey = normalizeHeader(source.agent_key)
    const agentName = normalizeText(source.agent_name)
    const dimensionType = normalizeHeader(source.dimension_type)
    const dimensionKey = normalizeHeader(source.dimension_key)
    const dimensionLabel = normalizeText(source.dimension_label)

    if (!AGENT_KEY_PATTERN.test(agentKey)) {
      throw new Error(`${tab.sheetName} row ${rowNumber} agent_key is invalid.`)
    }
    if (!productivityKeys.has(`${reportDate}\u0000${agentKey}`)) {
      throw new Error(
        `${tab.sheetName} row ${rowNumber} does not match a Ticket Productivity row.`
      )
    }
    if (
      normalizeHeader(agentNames.get(agentKey)) !== normalizeHeader(agentName)
    ) {
      throw new Error(
        `${tab.sheetName} row ${rowNumber} agent_name does not match agent_key.`
      )
    }
    if (!PHASE3_STEP9_ALLOWED_DIMENSION_TYPES.includes(dimensionType)) {
      throw new Error(
        `${tab.sheetName} row ${rowNumber} dimension_type is invalid.`
      )
    }
    if (!DIMENSION_KEY_PATTERN.test(dimensionKey)) {
      throw new Error(
        `${tab.sheetName} row ${rowNumber} dimension_key is invalid.`
      )
    }
    if (!dimensionLabel) {
      throw new Error(
        `${tab.sheetName} row ${rowNumber} dimension_label is required.`
      )
    }

    const record = {
      report_date: reportDate,
      agent_key: agentKey,
      agent_name: agentName,
      dimension_type: dimensionType,
      dimension_key: dimensionKey,
      dimension_label: dimensionLabel,
      ticket_count: normalizeInteger(
        source.ticket_count,
        `${tab.sheetName} row ${rowNumber} ticket_count`
      ),
      updated_at: importedAt
    }

    records.push(record)
    rawRecords.push(buildRawRecord(
      tab,
      headers,
      row,
      reportDate,
      syncRunId,
      importedAt
    ))
  })

  assertUnique(
    records,
    ['report_date', 'agent_key', 'dimension_type', 'dimension_key'],
    tab.sheetName
  )
  return { records, rawRecords }
}

function processDataDictionary(dataset, importedAt) {
  const tab = PHASE3_STEP9_TABS.dataDictionary
  const headers = tab.columns.map(definition => definition.name)
  const records = []

  dataset.values.slice(1).forEach((row, index) => {
    if (isBlankRow(row)) return
    const rowNumber = index + 2
    const source = makeRowObject(headers, row)
    const record = {
      contract_version: PHASE3_STEP9_CONTRACT_VERSION,
      tab_name: normalizeText(source.tab_name),
      column_name: normalizeHeader(source.column_name),
      data_type: normalizeHeader(source.data_type),
      required: normalizeBoolean(
        source.required,
        `${tab.sheetName} row ${rowNumber} required`
      ),
      definition: normalizeText(source.definition),
      validation_rule: normalizeText(source.validation_rule),
      updated_at: importedAt
    }

    if (
      !record.tab_name ||
      !record.column_name ||
      !record.data_type ||
      !record.definition ||
      !record.validation_rule
    ) {
      throw new Error(
        `${tab.sheetName} row ${rowNumber} contains a blank required value.`
      )
    }

    records.push(record)
  })

  assertUnique(
    records,
    ['contract_version', 'tab_name', 'column_name'],
    tab.sheetName
  )

  const received = new Map(records.map(record => [
    `${normalizeHeader(record.tab_name)}\u0000${record.column_name}`,
    record
  ]))

  getPhase3Step9ExpectedDictionaryRows().forEach(expected => {
    const key =
      `${normalizeHeader(expected.tab_name)}\u0000` +
      `${normalizeHeader(expected.column_name)}`
    const record = received.get(key)
    if (!record) {
      throw new Error(
        `Data Dictionary is missing ${expected.tab_name}.${expected.column_name}.`
      )
    }
    if (record.data_type !== normalizeHeader(expected.data_type)) {
      throw new Error(
        `Data Dictionary has the wrong data_type for ` +
        `${expected.tab_name}.${expected.column_name}.`
      )
    }
    if (record.required !== expected.required) {
      throw new Error(
        `Data Dictionary has the wrong required value for ` +
        `${expected.tab_name}.${expected.column_name}.`
      )
    }
  })

  return { records }
}

function processSyncMetadata(dataset, importedAt) {
  const tab = PHASE3_STEP9_TABS.syncMetadata
  const headers = tab.columns.map(definition => definition.name)
  const rows = dataset.values.slice(1).filter(row => !isBlankRow(row))

  if (rows.length !== 1) {
    throw new Error(`${tab.sheetName} must contain exactly one data row.`)
  }

  const source = makeRowObject(headers, rows[0])
  const contractVersion = normalizeInteger(
    source.contract_version,
    `${tab.sheetName} contract_version`
  )
  if (contractVersion !== PHASE3_STEP9_CONTRACT_VERSION) {
    throw new Error(
      `${tab.sheetName} contract_version must equal ` +
      `${PHASE3_STEP9_CONTRACT_VERSION}.`
    )
  }

  const sourceTimeZone = normalizeText(source.source_time_zone)
  if (sourceTimeZone !== 'America/New_York') {
    throw new Error(
      `${tab.sheetName} source_time_zone must equal America/New_York.`
    )
  }

  const testWindowStart = normalizeDate(
    source.test_window_start,
    `${tab.sheetName} test_window_start`
  )
  const testWindowEnd = normalizeDate(
    source.test_window_end,
    `${tab.sheetName} test_window_end`
  )
  if (testWindowStart > testWindowEnd) {
    throw new Error(
      `${tab.sheetName} test_window_start cannot be after test_window_end.`
    )
  }

  const testDaysCount = normalizeInteger(
    source.test_days_count,
    `${tab.sheetName} test_days_count`
  )
  if (testDaysCount < 1) {
    throw new Error(`${tab.sheetName} test_days_count must be at least 1.`)
  }

  const inclusiveDays = Math.round(
    (
      new Date(`${testWindowEnd}T00:00:00Z`) -
      new Date(`${testWindowStart}T00:00:00Z`)
    ) / 86400000
  ) + 1
  if (inclusiveDays !== testDaysCount) {
    throw new Error(
      `${tab.sheetName} test_days_count does not match the test window.`
    )
  }

  const producer = normalizeText(source.producer)
  if (!producer) {
    throw new Error(`${tab.sheetName} producer is required.`)
  }

  return {
    record: {
      contract_version: contractVersion,
      generated_at: normalizeDateTime(
        source.generated_at,
        `${tab.sheetName} generated_at`
      ),
      source_time_zone: sourceTimeZone,
      test_window_start: testWindowStart,
      test_window_end: testWindowEnd,
      test_days_count: testDaysCount,
      producer,
      ready_for_production: false,
      updated_at: importedAt
    }
  }
}

function addDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function getLongestConsecutiveDayCount(dateValues) {
  const dates = [...new Set(dateValues)].sort()
  let longest = 0
  let current = 0
  let previous = null

  dates.forEach(date => {
    if (previous && date === addDays(previous, 1)) {
      current += 1
    } else {
      current = 1
    }
    longest = Math.max(longest, current)
    previous = date
  })

  return longest
}

function sum(records, field) {
  return records.reduce(
    (total, record) => total + Number(record[field] || 0),
    0
  )
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label} does not reconcile: expected ${expected}, received ${actual}.`
    )
  }
}

function assertClose(actual, expected, label) {
  if (Math.abs(actual - expected) > EPSILON) {
    throw new Error(
      `${label} does not reconcile: expected ${expected}, received ${actual}.`
    )
  }
}

function reconcileDailyTotals(dailyRecords, productivityRecords) {
  const byDate = new Map()
  productivityRecords.forEach(record => {
    const rows = byDate.get(record.report_date) || []
    rows.push(record)
    byDate.set(record.report_date, rows)
  })

  const dailyDates = new Set(dailyRecords.map(record => record.report_date))
  const productivityDates = new Set(productivityRecords.map(
    record => record.report_date
  ))

  if (
    dailyDates.size !== productivityDates.size ||
    [...dailyDates].some(date => !productivityDates.has(date))
  ) {
    throw new Error(
      'Daily Ticket Metrics and Ticket Productivity must contain the same reporting dates.'
    )
  }

  dailyRecords.forEach(daily => {
    const rows = byDate.get(daily.report_date) || []
    const prefix = `Reporting date ${daily.report_date}`

    assertEqual(sum(rows, 'solved_tickets'), daily.solved_tickets, `${prefix} solved_tickets`)
    assertEqual(sum(rows, 'responded_tickets'), daily.responded_tickets, `${prefix} responded_tickets`)
    assertClose(sum(rows, 'first_response_minutes_total'), daily.first_response_minutes_total, `${prefix} first_response_minutes_total`)
    assertEqual(sum(rows, 'resolved_tickets'), daily.resolved_tickets, `${prefix} resolved_tickets`)
    assertClose(sum(rows, 'resolution_minutes_total'), daily.resolution_minutes_total, `${prefix} resolution_minutes_total`)
    assertEqual(sum(rows, 'reopened_tickets'), daily.reopened_tickets, `${prefix} reopened_tickets`)
    assertEqual(sum(rows, 'one_touch_tickets'), daily.one_touch_tickets, `${prefix} one_touch_tickets`)
  })
}

function reconcileDimensionTotals(dimensionRecords, productivityRecords) {
  const handledByAgentDate = new Map(productivityRecords.map(record => [
    `${record.report_date}\u0000${record.agent_key}`,
    record.handled_tickets
  ]))
  const groups = new Map()

  dimensionRecords.forEach(record => {
    const key = [
      record.report_date,
      record.agent_key,
      record.dimension_type
    ].join('\u0000')
    groups.set(key, (groups.get(key) || 0) + record.ticket_count)
  })

  groups.forEach((count, key) => {
    const [reportDate, agentKey, dimensionType] = key.split('\u0000')
    const handled = handledByAgentDate.get(
      `${reportDate}\u0000${agentKey}`
    )
    assertEqual(
      count,
      handled,
      `${reportDate} ${agentKey} ${dimensionType} ticket_count`
    )
  })
}

function validateMetadataCoverage(metadata, dailyRecords) {
  const dates = dailyRecords.map(record => record.report_date)
  const uniqueDates = [...new Set(dates)].sort()

  if (
    uniqueDates[0] !== metadata.test_window_start ||
    uniqueDates.at(-1) !== metadata.test_window_end ||
    uniqueDates.length !== metadata.test_days_count
  ) {
    throw new Error(
      'Sync Metadata test window does not match Daily Ticket Metrics.'
    )
  }

  const longestConsecutiveDays = getLongestConsecutiveDayCount(uniqueDates)
  return {
    longestConsecutiveDays,
    readyForProduction:
      metadata.test_days_count >= 7 &&
      longestConsecutiveDays >= 7
  }
}

export function isPhase3Step9Payload(payload) {
  return payload?.payloadVersion === PHASE3_STEP9_CONTRACT_VERSION &&
    payload?.contractKey === PHASE3_STEP9_CONTRACT_KEY &&
    payload?.datasets &&
    typeof payload.datasets === 'object'
}

export function validatePhase3Step9Payload(payload) {
  const contractErrors = validatePhase3Step9ContractDefinition()
  if (contractErrors.length > 0) {
    throw new Error(
      `Step 9 contract definition is invalid: ${contractErrors.join(' ')}`
    )
  }

  if (!isPhase3Step9Payload(payload)) {
    throw new Error(
      `The request must use payloadVersion ` +
      `${PHASE3_STEP9_CONTRACT_VERSION} and contractKey ` +
      `${PHASE3_STEP9_CONTRACT_KEY}.`
    )
  }

  PHASE3_STEP9_REQUIRED_DATASET_KEYS.forEach(datasetKey => {
    const tab = Object.values(PHASE3_STEP9_TABS).find(
      candidate => candidate.datasetKey === datasetKey
    )
    validateDataset(getDataset(payload, datasetKey), tab)
  })
}

export function processPhase3Step9Payload(payload, syncRunId) {
  validatePhase3Step9Payload(payload)
  const importedAt = new Date().toISOString()

  const daily = processDailyTicketMetrics(
    getDataset(payload, PHASE3_STEP9_TABS.dailyTicketMetrics.datasetKey),
    syncRunId,
    importedAt
  )
  const productivity = processTicketProductivity(
    getDataset(payload, PHASE3_STEP9_TABS.ticketProductivity.datasetKey),
    syncRunId,
    importedAt
  )
  const dimensions = processAgentDimensionMetrics(
    getDataset(payload, PHASE3_STEP9_TABS.agentDimensionMetrics.datasetKey),
    productivity.records,
    productivity.agentNames,
    syncRunId,
    importedAt
  )
  const dictionary = processDataDictionary(
    getDataset(payload, PHASE3_STEP9_TABS.dataDictionary.datasetKey),
    importedAt
  )
  const metadata = processSyncMetadata(
    getDataset(payload, PHASE3_STEP9_TABS.syncMetadata.datasetKey),
    importedAt
  )

  reconcileDailyTotals(daily.records, productivity.records)
  reconcileDimensionTotals(dimensions.records, productivity.records)

  const readiness = validateMetadataCoverage(
    metadata.record,
    daily.records
  )
  metadata.record.ready_for_production = readiness.readyForProduction
  metadata.record.latest_report_date = daily.records
    .map(record => record.report_date)
    .sort()
    .at(-1) || null

  const warnings = []
  if (!readiness.readyForProduction) {
    warnings.push(
      `Step 9 requires seven consecutive test days. ` +
      `Current longest consecutive window: ` +
      `${readiness.longestConsecutiveDays} day(s).`
    )
  }

  return {
    dailyMetrics: daily.records,
    productivity: productivity.records,
    agentDimensions: dimensions.records,
    dataDictionary: dictionary.records,
    syncMetadata: metadata.record,
    rawRecords: [
      ...daily.rawRecords,
      ...productivity.rawRecords,
      ...dimensions.rawRecords
    ],
    warnings,
    readiness,
    latestReportDate: metadata.record.latest_report_date
  }
}

export const PHASE3_STEP9_DESTINATIONS = Object.freeze({
  dailyMetrics: Object.freeze({
    tableName: 'daily_ticket_metrics',
    conflictColumns: Object.freeze(['report_date'])
  }),
  productivity: Object.freeze({
    tableName: 'agent_productivity',
    conflictColumns: Object.freeze(['report_date', 'agent_key'])
  }),
  agentDimensions: Object.freeze({
    tableName: 'agent_dimension_metrics',
    conflictColumns: Object.freeze([
      'report_date',
      'agent_key',
      'dimension_type',
      'dimension_key'
    ])
  }),
  dataDictionary: Object.freeze({
    tableName: 'reporting_data_dictionary',
    conflictColumns: Object.freeze([
      'contract_version',
      'tab_name',
      'column_name'
    ])
  }),
  syncMetadata: Object.freeze({
    tableName: 'sheet_sync_metadata',
    conflictColumns: Object.freeze(['sync_run_id'])
  })
})
