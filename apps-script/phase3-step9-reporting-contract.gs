const SIMPLE_DASHBOARD_SYNC = Object.freeze({
  payloadVersion: 2,
  endpointProperty: 'DASHBOARD_SYNC_URL',
  secretProperty: 'SHEET_SYNC_SECRET',
  sourceTabs: Object.freeze({
    dailyVolume: Object.freeze({
      sheetName: 'Daily Volume',
      payloadSheetName: 'Daily Volume ',
      columnCount: 19,
      headerRows: 1,
      dataStartRow: 2
    }),
    ticketProductivity: Object.freeze({
      sheetName: 'Ticket Productivity',
      payloadSheetName: 'Ticket Productivity',
      columnCount: 25,
      headerRows: 2,
      dataStartRow: 3
    }),
    dailyDrivers: Object.freeze({
      sheetName: 'Daily Drivers',
      payloadSheetName: 'Daily Drivers',
      columnCount: 73,
      headerRows: 2,
      dataStartRow: 3
    })
  }),
  ignoredTabs: Object.freeze([
    'MTD YTD',
    'Driver Summary'
  ])
})

const RETIRED_STEP9_V3_REFERENCE = Object.freeze({
  legacyProductivitySheetName: 'Ticket Productivity',
  sheetName: 'Ticket Productivity V3',
  timeZone: 'America/New_York',
  note: 'Retired V3 tabs are left unchanged and are not synchronized.'
})

function setupPhase3Step9Tabs() {
  const spreadsheet = SpreadsheetApp.getActive()
  const sourceNames = Object.keys(SIMPLE_DASHBOARD_SYNC.sourceTabs).map(
    function (key) {
      return SIMPLE_DASHBOARD_SYNC.sourceTabs[key].sheetName
    }
  )
  const missing = sourceNames.filter(function (name) {
    return !findSimpleSourceSheet_(spreadsheet, name)
  })

  if (missing.length > 0) {
    throw new Error(
      'Missing required source tab(s): ' + missing.join(', ') + '.'
    )
  }

  const result = {
    ready: true,
    sourceTabs: sourceNames,
    ignoredTabs: SIMPLE_DASHBOARD_SYNC.ignoredTabs,
    message: 'No additional reporting tabs are required.'
  }

  console.log(JSON.stringify(result, null, 2))
  return result
}

function syncPhase3Step9Dashboard() {
  return syncAllDashboardData()
}

function syncAllDashboardData() {
  const lock = LockService.getScriptLock()
  lock.waitLock(30000)

  try {
    const spreadsheet = SpreadsheetApp.getActive()
    const properties = PropertiesService.getScriptProperties()
    const configuredEndpoint = properties.getProperty(
      SIMPLE_DASHBOARD_SYNC.endpointProperty
    )
    const secret = properties.getProperty(
      SIMPLE_DASHBOARD_SYNC.secretProperty
    )

    setupPhase3Step9Tabs()

    if (!configuredEndpoint || !secret) {
      throw new Error(
        'Set DASHBOARD_SYNC_URL and SHEET_SYNC_SECRET in Script Properties.'
      )
    }

    const endpoint = resolveSimpleDashboardEndpoint_(configuredEndpoint)
    const payload = buildSimpleDashboardPayload_(spreadsheet)
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
    const responseText = response.getContentText()
    let result

    try {
      result = JSON.parse(responseText)
    } catch (error) {
      throw new Error(
        'Dashboard sync returned non-JSON content with status ' + status + '.'
      )
    }

    if (status < 200 || status >= 300 || !result.success) {
      throw new Error(
        'Dashboard sync failed with status ' + status + ': ' +
        (result.error || responseText)
      )
    }

    if (endpoint !== String(configuredEndpoint).trim()) {
      properties.setProperty(
        SIMPLE_DASHBOARD_SYNC.endpointProperty,
        endpoint
      )
    }

    console.log(JSON.stringify(result, null, 2))
    return result
  } finally {
    lock.releaseLock()
  }
}

function buildSimpleDashboardPayload_(spreadsheet) {
  const datasets = {}

  Object.keys(SIMPLE_DASHBOARD_SYNC.sourceTabs).forEach(function (key) {
    const source = SIMPLE_DASHBOARD_SYNC.sourceTabs[key]
    const sheet = findSimpleSourceSheet_(spreadsheet, source.sheetName)

    if (!sheet) {
      throw new Error('Missing required source tab: ' + source.sheetName + '.')
    }

    if (sheet.getMaxColumns() < source.columnCount) {
      throw new Error(
        source.sheetName + ' must contain at least ' +
        source.columnCount + ' columns.'
      )
    }

    datasets[key] = {
      sheetName: source.payloadSheetName,
      columnCount: source.columnCount,
      headerRows: source.headerRows,
      dataStartRow: source.dataStartRow,
      values: readSimpleSourceValues_(sheet, source)
    }
  })

  return {
    payloadVersion: SIMPLE_DASHBOARD_SYNC.payloadVersion,
    datasets: datasets
  }
}

function readSimpleSourceValues_(sheet, source) {
  const lastRow = Math.max(source.headerRows, sheet.getLastRow())
  const values = sheet
    .getRange(1, 1, lastRow, source.columnCount)
    .getValues()

  while (
    values.length > source.headerRows &&
    isSimpleBlankRow_(values[values.length - 1])
  ) {
    values.pop()
  }

  return values
}

function resolveSimpleDashboardEndpoint_(configuredEndpoint) {
  const endpoint = String(configuredEndpoint || '').trim().replace(/\/+$/, '')

  if (!endpoint) {
    throw new Error('DASHBOARD_SYNC_URL is empty.')
  }

  if (/\/api\/sync-dashboard-v3$/i.test(endpoint)) {
    return endpoint.replace(
      /\/api\/sync-dashboard-v3$/i,
      '/api/sync-dashboard'
    )
  }

  if (/\/api\/sync-dashboard$/i.test(endpoint)) {
    return endpoint
  }

  if (/\/api\//i.test(endpoint)) {
    throw new Error(
      'DASHBOARD_SYNC_URL must end with /api/sync-dashboard.'
    )
  }

  return endpoint + '/api/sync-dashboard'
}

function findSimpleSourceSheet_(spreadsheet, expectedName) {
  const normalizedExpected = normalizeSimpleSheetName_(expectedName)

  return spreadsheet.getSheets().find(function (sheet) {
    return normalizeSimpleSheetName_(sheet.getName()) === normalizedExpected
  }) || null
}

function normalizeSimpleSheetName_(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function isSimpleBlankRow_(row) {
  return row.every(function (value) {
    return value === null ||
      value === undefined ||
      (typeof value === 'string' && value.trim() === '')
  })
}
