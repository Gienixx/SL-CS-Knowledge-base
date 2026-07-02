const SIMPLE_DASHBOARD_SYNC = Object.freeze({
  endpointProperty: 'DASHBOARD_SYNC_URL',
  sourceTabs: Object.freeze([
    'Daily Volume',
    'Daily Drivers',
    'Ticket Productivity'
  ]),
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
  const missing = SIMPLE_DASHBOARD_SYNC.sourceTabs.filter(function (name) {
    return !findSimpleSourceSheet_(spreadsheet, name)
  })

  if (missing.length > 0) {
    throw new Error(
      'Missing required source tab(s): ' + missing.join(', ') + '.'
    )
  }

  const result = {
    ready: true,
    sourceTabs: SIMPLE_DASHBOARD_SYNC.sourceTabs,
    ignoredTabs: SIMPLE_DASHBOARD_SYNC.ignoredTabs,
    message: 'No additional reporting tabs are required.'
  }

  console.log(JSON.stringify(result, null, 2))
  return result
}

function syncPhase3Step9Dashboard() {
  setupPhase3Step9Tabs()
  useSimpleDashboardEndpoint_()

  if (typeof syncAllDashboardData !== 'function') {
    throw new Error(
      'syncAllDashboardData is missing from this Apps Script project. ' +
      'Restore the existing Google Sheet dashboard sync function first.'
    )
  }

  const result = syncAllDashboardData()
  console.log(JSON.stringify(result || null, null, 2))
  return result
}

function useSimpleDashboardEndpoint_() {
  const properties = PropertiesService.getScriptProperties()
  const propertyName = SIMPLE_DASHBOARD_SYNC.endpointProperty
  const currentEndpoint = String(
    properties.getProperty(propertyName) || ''
  ).trim()

  if (!currentEndpoint) {
    throw new Error('Set DASHBOARD_SYNC_URL in Script Properties.')
  }

  const simpleEndpoint = currentEndpoint.replace(
    /\/api\/sync-dashboard-v3\/?$/i,
    '/api/sync-dashboard'
  )

  if (simpleEndpoint !== currentEndpoint) {
    properties.setProperty(propertyName, simpleEndpoint)
  }
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
