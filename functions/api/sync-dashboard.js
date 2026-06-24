import {
  buildColumnIndexes,
  extractSheetValues,
  getLatestReportDate,
  processRows,
  validateSheetPayload
} from '../_shared/dashboard-sync-data.js'
import {
  createSyncRun,
  insertRawRecords,
  updateSyncRun,
  upsertDashboardRecords
} from '../_shared/dashboard-sync-store.js'

function jsonResponse(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      }
    }
  )
}

function getBearerToken(request) {
  const authorization = request.headers.get('Authorization')

  if (!authorization || !authorization.startsWith('Bearer ')) {
    return null
  }

  return authorization.slice('Bearer '.length).trim()
}

async function secretsMatch(receivedSecret, expectedSecret) {
  if (
    typeof receivedSecret !== 'string' ||
    typeof expectedSecret !== 'string' ||
    !receivedSecret ||
    !expectedSecret
  ) {
    return false
  }

  const encoder = new TextEncoder()
  const [receivedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(receivedSecret)),
    crypto.subtle.digest('SHA-256', encoder.encode(expectedSecret))
  ])

  const receivedBytes = new Uint8Array(receivedDigest)
  const expectedBytes = new Uint8Array(expectedDigest)
  let difference = receivedBytes.length ^ expectedBytes.length

  for (let index = 0; index < receivedBytes.length; index += 1) {
    difference |= receivedBytes[index] ^ expectedBytes[index]
  }

  return difference === 0
}

function getRequiredEnvironment(context) {
  const {
    SHEET_SYNC_SECRET,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY
  } = context.env

  if (
    !SHEET_SYNC_SECRET ||
    !SUPABASE_URL ||
    !SUPABASE_SERVICE_ROLE_KEY
  ) {
    throw new Error(
      'Dashboard synchronization environment variables are incomplete.'
    )
  }

  return {
    sheetSyncSecret: SHEET_SYNC_SECRET,
    supabaseUrl: SUPABASE_URL.endsWith('/')
      ? SUPABASE_URL.slice(0, -1)
      : SUPABASE_URL,
    serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY
  }
}

export async function onRequestPost(context) {
  let environment
  let syncRunId = null
  const startedAt = new Date().toISOString()

  try {
    environment = getRequiredEnvironment(context)

    const authorized = await secretsMatch(
      getBearerToken(context.request),
      environment.sheetSyncSecret
    )

    if (!authorized) {
      return jsonResponse(
        {
          success: false,
          error: 'Unauthorized synchronization request.'
        },
        401
      )
    }

    let payload

    try {
      payload = await context.request.json()
    } catch {
      return jsonResponse(
        {
          success: false,
          error: 'The request body must contain valid JSON.'
        },
        400
      )
    }

    const sheetData = extractSheetValues(payload)
    validateSheetPayload(sheetData)
    const indexes = buildColumnIndexes(sheetData.headers)

    syncRunId = await createSyncRun(
      environment.supabaseUrl,
      environment.serviceRoleKey,
      startedAt
    )

    const result = processRows(
      sheetData.headers,
      sheetData.rows,
      indexes,
      syncRunId
    )

    await insertRawRecords(
      environment.supabaseUrl,
      environment.serviceRoleKey,
      result.rawRecords
    )

    await upsertDashboardRecords(
      environment.supabaseUrl,
      environment.serviceRoleKey,
      result.importedRecords
    )

    const latestReportDate = getLatestReportDate(
      result.importedRecords
    )

    await updateSyncRun(
      environment.supabaseUrl,
      environment.serviceRoleKey,
      syncRunId,
      {
        completed_at: new Date().toISOString(),
        status: 'success',
        report_date: latestReportDate,
        rows_imported: result.importedRecords.length,
        error_message: null
      }
    )

    return jsonResponse({
      success: true,
      latestReportDate,
      rowsImported: result.importedRecords.length,
      rowsSkipped: result.skippedRows,
      rowsIgnored: result.ignoredRows,
      warnings: result.warnings.slice(0, 25),
      warningCount: result.warnings.length
    })
  } catch (error) {
    console.error('Dashboard synchronization failed:', error)

    if (environment && syncRunId) {
      try {
        await updateSyncRun(
          environment.supabaseUrl,
          environment.serviceRoleKey,
          syncRunId,
          {
            completed_at: new Date().toISOString(),
            status: 'failed',
            rows_imported: 0,
            error_message: String(
              error?.message || 'Unknown synchronization error.'
            ).slice(0, 1000)
          }
        )
      } catch (loggingError) {
        console.error(
          'Unable to record the failed synchronization:',
          loggingError
        )
      }
    }

    return jsonResponse(
      {
        success: false,
        error: error?.message || 'Unable to synchronize dashboard data.'
      },
      500
    )
  }
}
