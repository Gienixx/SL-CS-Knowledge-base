const PHASE3_STEP9 = Object.freeze({
  payloadVersion: 3,
  contractKey: 'phase3_step9_google_sheet_reporting',
  timeZone: 'America/New_York',
  endpointProperty: 'DASHBOARD_SYNC_URL',
  secretProperty: 'SHEET_SYNC_SECRET',
  producer: 'phase3-step9-apps-script',
  tabs: Object.freeze({
    dailyTicketMetrics: Object.freeze({
      sheetName: 'Daily Ticket Metrics',
      columns: Object.freeze([
        ['report_date', 'date', 'Reporting date in Eastern Time.', 'ISO date YYYY-MM-DD.'],
        ['new_tickets', 'integer', 'Tickets created during the reporting date.', 'Non-negative integer.'],
        ['solved_tickets', 'integer', 'Tickets solved during the reporting date.', 'Non-negative integer; must equal the agent total.'],
        ['unsolved_tickets', 'integer', 'Open backlog snapshot for the reporting date.', 'Non-negative integer.'],
        ['one_touch_resolution', 'number', 'Share of resolved tickets completed in one touch.', 'Decimal from 0 through 1.'],
        ['reopened_rate', 'number', 'Share of resolved tickets that reopened.', 'Decimal from 0 through 1.'],
        ['responded_tickets', 'integer', 'Tickets that received a first response.', 'Non-negative integer; must equal the agent total.'],
        ['first_response_minutes_total', 'number', 'Total first-response minutes for responded tickets.', 'Non-negative number; must equal the agent total.'],
        ['first_response_median_minutes', 'number', 'Median first-response minutes for the team.', 'Non-negative number.'],
        ['resolved_tickets', 'integer', 'Tickets with a completed resolution.', 'Non-negative integer; must equal the agent total.'],
        ['resolution_minutes_total', 'number', 'Total resolution minutes for resolved tickets.', 'Non-negative number; must equal the agent total.'],
        ['resolution_median_minutes', 'number', 'Median resolution minutes for the team.', 'Non-negative number.'],
        ['reopened_tickets', 'integer', 'Resolved tickets that reopened.', 'Non-negative integer; must equal the agent total.'],
        ['one_touch_tickets', 'integer', 'Resolved tickets completed in one touch.', 'Non-negative integer; must equal the agent total.']
      ])
    }),
    ticketProductivity: Object.freeze({
      sheetName: 'Ticket Productivity',
      columns: Object.freeze([
        ['report_date', 'date', 'Reporting date in Eastern Time.', 'ISO date YYYY-MM-DD.'],
        ['agent_key', 'key', 'Stable machine-readable agent identifier.', 'Lowercase letters, numbers, underscores, and hyphens only.'],
        ['agent_name', 'text', 'Current display name for the agent.', 'One name per agent_key in the test window.'],
        ['solved_tickets', 'integer', 'Tickets solved by the agent.', 'Non-negative integer.'],
        ['open_tickets', 'integer', 'Open tickets assigned to the agent.', 'Non-negative integer.'],
        ['handled_tickets', 'integer', 'Tickets handled by the agent.', 'Non-negative integer.'],
        ['handle_minutes_total', 'number', 'Total handle minutes for handled tickets.', 'Non-negative number.'],
        ['responded_tickets', 'integer', 'Tickets receiving a first response from the agent.', 'Cannot exceed handled_tickets.'],
        ['first_response_minutes_total', 'number', 'Total first-response minutes for responded tickets.', 'Non-negative number.'],
        ['first_response_median_minutes', 'number', 'Median first-response minutes for the agent.', 'Non-negative number.'],
        ['resolved_tickets', 'integer', 'Tickets resolved by the agent.', 'Cannot exceed handled_tickets.'],
        ['resolution_minutes_total', 'number', 'Total resolution minutes for resolved tickets.', 'Non-negative number.'],
        ['resolution_median_minutes', 'number', 'Median resolution minutes for the agent.', 'Non-negative number.'],
        ['reopened_tickets', 'integer', 'Resolved tickets that reopened for the agent.', 'Non-negative integer.'],
        ['one_touch_tickets', 'integer', 'Resolved tickets completed in one touch.', 'Cannot exceed resolved_tickets.'],
        ['worked_hours', 'number', 'Hours worked by the agent.', 'Non-negative number.']
      ])
    }),
    agentDimensionMetrics: Object.freeze({
      sheetName: 'Agent Dimension Metrics',
      columns: Object.freeze([
        ['report_date', 'date', 'Reporting date in Eastern Time.', 'ISO date YYYY-MM-DD.'],
        ['agent_key', 'key', 'Stable machine-readable agent identifier.', 'Must match Ticket Productivity.'],
        ['agent_name', 'text', 'Current display name for the agent.', 'Must match Ticket Productivity.'],
        ['dimension_type', 'enum', 'Reporting dimension represented by the row.', 'app, platform, country, concern, priority, or channel.'],
        ['dimension_key', 'key', 'Stable machine-readable dimension value.', 'Use unknown when the value is missing.'],
        ['dimension_label', 'text', 'Display label for the dimension value.', 'Non-empty text.'],
        ['ticket_count', 'integer', 'Handled-ticket count for the dimension value.', 'Non-negative integer.']
      ])
    }),
    dataDictionary: Object.freeze({
      sheetName: 'Data Dictionary',
      columns: Object.freeze([
        ['tab_name', 'text', 'Workbook tab containing the documented column.', 'Must match a Step 9 tab name.'],
        ['column_name', 'text', 'Exact machine-readable column header.', 'Must match the Step 9 contract.'],
        ['data_type', 'text', 'Expected logical data type.', 'Must match the Step 9 contract.'],
        ['required', 'boolean', 'Whether every imported row requires a value.', 'TRUE or FALSE.'],
        ['definition', 'text', 'Business definition for the column.', 'Non-empty text.'],
        ['validation_rule', 'text', 'Human-readable validation rule.', 'Non-empty text.']
      ])
    }),
    syncMetadata: Object.freeze({
      sheetName: 'Sync Metadata',
      columns: Object.freeze([
        ['contract_version', 'integer', 'Google Sheet reporting contract version.', 'Must equal 3.'],
        ['generated_at', 'datetime', 'Time the payload was generated.', 'ISO-8601 date and time.'],
        ['source_time_zone', 'text', 'Workbook reporting time zone.', 'Must equal America/New_York.'],
        ['test_window_start', 'date', 'First date in the validation window.', 'ISO date YYYY-MM-DD.'],
        ['test_window_end', 'date', 'Last date in the validation window.', 'ISO date YYYY-MM-DD.'],
        ['test_days_count', 'integer', 'Distinct reporting dates in the validation window.', 'Production readiness requires at least 7.'],
        ['producer', 'text', 'Process producing the payload.', 'Non-empty text.']
      ])
    })
  })
})

function setupPhase3Step9Tabs() {
  const spreadsheet = SpreadsheetApp.getActive()

  if (spreadsheet.getSpreadsheetTimeZone() !== PHASE3_STEP9.timeZone) {
    throw new Error(
      'Set the spreadsheet time zone to America/New_York before Step 9 setup.'
    )
  }

  Object.keys(PHASE3_STEP9.tabs).forEach(function (key) {
    ensureContractSheet_(spreadsheet, PHASE3_STEP9.tabs[key])
  })

  populateStep9DataDictionary_(spreadsheet)
  SpreadsheetApp.flush()

  return 'Step 9 tabs are ready. Existing mismatched tabs were not modified.'
}

function ensureContractSheet_(spreadsheet, tab) {
  const headers = tab.columns.map(function (column) {
    return column[0]
  })
  let sheet = spreadsheet.getSheetByName(tab.sheetName)

  if (!sheet) {
    sheet = spreadsheet.insertSheet(tab.sheetName)
    sheet.getRange(1, 1, 1, headers.length).setValues([headers])
    sheet.setFrozenRows(1)
    return
  }

  const lastColumn = Math.max(sheet.getLastColumn(), headers.length)
  const existing = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0]
  const hasExistingHeader = existing.some(function (value) {
    return String(value).trim() !== ''
  })

  if (!hasExistingHeader) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers])
    sheet.setFrozenRows(1)
    return
  }

  const matches = headers.length === sheet.getLastColumn() &&
    headers.every(function (header, index) {
      return String(existing[index]).trim().toLowerCase() === header
    })

  if (!matches) {
    throw new Error(
      'The existing "' + tab.sheetName + '" tab does not match the Step 9 ' +
      'contract. Rename or archive that tab, then run setup again. No data ' +
      'was changed.'
    )
  }
}

function populateStep9DataDictionary_(spreadsheet) {
  const dictionaryTab = PHASE3_STEP9.tabs.dataDictionary
  const sheet = spreadsheet.getSheetByName(dictionaryTab.sheetName)
  const rows = []

  Object.keys(PHASE3_STEP9.tabs).forEach(function (key) {
    const tab = PHASE3_STEP9.tabs[key]
    tab.columns.forEach(function (column) {
      rows.push([
        tab.sheetName,
        column[0],
        column[1],
        true,
        column[2],
        column[3]
      ])
    })
  })

  const existingRows = Math.max(0, sheet.getLastRow() - 1)
  if (existingRows > 0) {
    sheet.getRange(2, 1, existingRows, dictionaryTab.columns.length)
      .clearContent()
  }
  sheet.getRange(2, 1, rows.length, dictionaryTab.columns.length)
    .setValues(rows)
}

function syncPhase3Step9Dashboard() {
  const spreadsheet = SpreadsheetApp.getActive()
  const properties = PropertiesService.getScriptProperties()
  const endpoint = properties.getProperty(PHASE3_STEP9.endpointProperty)
  const secret = properties.getProperty(PHASE3_STEP9.secretProperty)

  if (!endpoint || !secret) {
    throw new Error(
      'Set DASHBOARD_SYNC_URL and SHEET_SYNC_SECRET in Script Properties.'
    )
  }

  updateStep9SyncMetadata_(spreadsheet)
  const payload = buildPhase3Step9Payload_(spreadsheet)
  const response = UrlFetchApp.fetch(endpoint, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + secret
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  })

  const status = response.getResponseCode()
  const body = response.getContentText()
  let parsed

  try {
    parsed = JSON.parse(body)
  } catch (error) {
    throw new Error(
      'Step 9 sync returned non-JSON content with status ' + status + '.'
    )
  }

  if (status < 200 || status >= 300 || !parsed.success) {
    throw new Error(
      'Step 9 sync failed with status ' + status + ': ' +
      (parsed.error || body)
    )
  }

  console.log(JSON.stringify(parsed, null, 2))
  return parsed
}

function updateStep9SyncMetadata_(spreadsheet) {
  if (spreadsheet.getSpreadsheetTimeZone() !== PHASE3_STEP9.timeZone) {
    throw new Error(
      'The spreadsheet time zone must be America/New_York.'
    )
  }

  const dailyTab = PHASE3_STEP9.tabs.dailyTicketMetrics
  const dailySheet = spreadsheet.getSheetByName(dailyTab.sheetName)
  const dates = readContractValues_(dailySheet, dailyTab)
    .slice(1)
    .map(function (row) { return row[0] })
    .filter(function (value) { return value !== '' })

  if (dates.length === 0) {
    throw new Error('Daily Ticket Metrics must contain at least one data row.')
  }

  const uniqueDates = Array.from(new Set(dates)).sort()
  const metadataTab = PHASE3_STEP9.tabs.syncMetadata
  const metadataSheet = spreadsheet.getSheetByName(metadataTab.sheetName)
  const row = [[
    PHASE3_STEP9.payloadVersion,
    new Date().toISOString(),
    PHASE3_STEP9.timeZone,
    uniqueDates[0],
    uniqueDates[uniqueDates.length - 1],
    uniqueDates.length,
    PHASE3_STEP9.producer
  ]]

  const existingRows = Math.max(0, metadataSheet.getLastRow() - 1)
  if (existingRows > 0) {
    metadataSheet.getRange(2, 1, existingRows, metadataTab.columns.length)
      .clearContent()
  }
  metadataSheet.getRange(2, 1, 1, metadataTab.columns.length).setValues(row)
}

function buildPhase3Step9Payload_(spreadsheet) {
  const datasets = {}

  Object.keys(PHASE3_STEP9.tabs).forEach(function (key) {
    const tab = PHASE3_STEP9.tabs[key]
    const sheet = spreadsheet.getSheetByName(tab.sheetName)

    if (!sheet) {
      throw new Error('Missing required tab: ' + tab.sheetName + '.')
    }

    datasets[key] = {
      sheetName: tab.sheetName,
      values: readContractValues_(sheet, tab)
    }
  })

  return {
    payloadVersion: PHASE3_STEP9.payloadVersion,
    contractKey: PHASE3_STEP9.contractKey,
    datasets: datasets
  }
}

function readContractValues_(sheet, tab) {
  const lastRow = Math.max(1, sheet.getLastRow())
  const width = tab.columns.length
  const values = sheet.getRange(1, 1, lastRow, width).getValues()
  const normalized = values.map(function (row, rowIndex) {
    return row.map(function (value, columnIndex) {
      if (rowIndex === 0) return String(value).trim().toLowerCase()
      const dataType = tab.columns[columnIndex][1]
      return normalizeStep9Value_(value, dataType)
    })
  })

  while (
    normalized.length > 1 &&
    normalized[normalized.length - 1].every(function (value) {
      return value === ''
    })
  ) {
    normalized.pop()
  }

  return normalized
}

function normalizeStep9Value_(value, dataType) {
  if (value === null || value === undefined || value === '') return ''

  if (dataType === 'date' && value instanceof Date) {
    return Utilities.formatDate(
      value,
      PHASE3_STEP9.timeZone,
      'yyyy-MM-dd'
    )
  }

  if (dataType === 'datetime' && value instanceof Date) {
    return value.toISOString()
  }

  if (dataType === 'key' || dataType === 'enum') {
    return String(value).trim().toLowerCase()
  }

  if (dataType === 'text') {
    return String(value).trim()
  }

  return value
}
