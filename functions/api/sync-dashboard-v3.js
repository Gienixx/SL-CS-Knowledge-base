import {
  PHASE3_STEP9_DESTINATIONS,
  processPhase3Step9Payload,
  validatePhase3Step9Payload
} from '../_shared/dashboard-sync-contract-v3.js'
import {
  createSyncRun,
  insertRawRecords,
  updateSyncRun
} from '../_shared/dashboard-sync-store.js'
import {
  getServiceHeaders
} from '../_shared/auth-header-helper.js'
import {
  getMappedDestination,
  getMappedRecordBatches
} from '../_shared/mapped-record-batches.js'
import {
  runJsonRequest
} from '../_shared/request-runner.js'

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Reporting-Contract': 'phase3-step9-v3',
      ...headers
    }
  })
}

function getBearerToken(request) {
  const authorization = request.headers.get('Authorization')
  if (!authorization || !authorization.startsWith('Bearer ')) return null
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

async function upsertRecords(environment, destination, records) {
  const { tableName, conflictTarget } =
    getMappedDestination(destination)
  const path =
    `${tableName}?on_conflict=${encodeURIComponent(conflictTarget)}`

  for (const batch of getMappedRecordBatches(records)) {
    await runJsonRequest(
      `${environment.supabaseUrl}/rest/v1/${path}`,
      {
        method: 'POST',
        headers: {
          ...getServiceHeaders(environment.serviceRoleKey),
          Prefer: 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify(batch)
      }
    )
  }
}

async function persistResult(environment, result, syncRunId) {
  await insertRawRecords(
    environment.supabaseUrl,
    environment.serviceRoleKey,
    result.rawRecords
  )

  const writes = [
    [PHASE3_STEP9_DESTINATIONS.dailyMetrics, result.dailyMetrics],
    [PHASE3_STEP9_DESTINATIONS.productivity, result.productivity],
    [PHASE3_STEP9_DESTINATIONS.agentDimensions, result.agentDimensions],
    [PHASE3_STEP9_DESTINATIONS.dataDictionary, result.dataDictionary],
    [
      PHASE3_STEP9_DESTINATIONS.syncMetadata,
      [{
        ...result.syncMetadata,
        sync_run_id: String(syncRunId),
        rows_imported:
          result.dailyMetrics.length +
          result.productivity.length +
          result.agentDimensions.length
      }]
    ]
  ]

  for (const [destination, records] of writes) {
    await upsertRecords(environment, destination, records)
  }
}

function importedRowCount(result) {
  return result.dailyMetrics.length +
    result.productivity.length +
    result.agentDimensions.length +
    result.dataDictionary.length +
    1
}

export async function onRequestPost(context) {
  let environment
  let syncRunId = null
  const startedAt = new Date().toISOString()

  try {
    environment = getRequiredEnvironment(context)

    if (!await secretsMatch(
      getBearerToken(context.request),
      environment.sheetSyncSecret
    )) {
      return jsonResponse({
        success: false,
        code: 'unauthorized',
        error: 'Unauthorized synchronization request.'
      }, 401, { 'WWW-Authenticate': 'Bearer' })
    }

    let payload
    try {
      payload = await context.request.json()
    } catch {
      return jsonResponse({
        success: false,
        code: 'invalid_json',
        error: 'The request body must contain valid JSON.'
      }, 400)
    }

    validatePhase3Step9Payload(payload)

    syncRunId = await createSyncRun(
      environment.supabaseUrl,
      environment.serviceRoleKey,
      startedAt
    )

    const result = processPhase3Step9Payload(payload, syncRunId)
    await persistResult(environment, result, syncRunId)

    const rowsImported = importedRowCount(result)
    await updateSyncRun(
      environment.supabaseUrl,
      environment.serviceRoleKey,
      syncRunId,
      {
        completed_at: new Date().toISOString(),
        status: 'success',
        report_date: result.latestReportDate,
        rows_imported: rowsImported,
        error_message: null
      }
    )

    return jsonResponse({
      success: true,
      payloadVersion: 3,
      contractKey: 'phase3_step9_google_sheet_reporting',
      syncRunId,
      latestReportDate: result.latestReportDate,
      rowsImported,
      datasets: {
        dailyTicketMetrics: result.dailyMetrics.length,
        ticketProductivity: result.productivity.length,
        agentDimensionMetrics: result.agentDimensions.length,
        dataDictionary: result.dataDictionary.length,
        syncMetadata: 1
      },
      readiness: result.readiness,
      warnings: result.warnings
    })
  } catch (error) {
    console.error('Step 9 dashboard synchronization failed:', error)

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
          'Unable to record the failed Step 9 synchronization:',
          loggingError
        )
      }
    }

    return jsonResponse({
      success: false,
      code: 'phase3_step9_sync_failed',
      error: error?.message ||
        'Unable to synchronize the Step 9 reporting contract.'
    }, 400)
  }
}

export function onRequestGet() {
  return jsonResponse({
    success: false,
    code: 'method_not_allowed',
    error: 'Use POST for Step 9 Google Sheet synchronization.'
  }, 405, { Allow: 'POST' })
}
