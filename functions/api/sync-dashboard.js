import {
  buildColumnIndexes,
  extractSheetValues,
  getLatestReportDate,
  processRows,
  validateSheetPayload
} from '../_shared/dashboard-sync-data.js'
import {
  getMultiDatasetSummary,
  isMultiDatasetPayload,
  MULTI_DATASET_DESTINATIONS,
  processMultiDatasetPayload,
  validateMultiDatasetPayload
} from '../_shared/dashboard-sync-datasets.js'
import {
  createSyncRun,
  insertRawRecords,
  updateSyncRun,
  upsertDashboardRecords
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

async function upsertMappedRecords(
  supabaseUrl,
  serviceRoleKey,
  destination,
  records
) {
  const { tableName, conflictTarget } =
    getMappedDestination(destination)
  const path =
    `${tableName}?on_conflict=${encodeURIComponent(conflictTarget)}`

  for (const batch of getMappedRecordBatches(records)) {
    await runJsonRequest(
      `${supabaseUrl}/rest/v1/${path}`,
      {
        method: 'POST',
        headers: {
          ...getServiceHeaders(serviceRoleKey),
          Prefer: 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify(batch)
      }
    )
  }
}

async function persistMultiDatasetResult(environment, result) {
  await insertRawRecords(
    environment.supabaseUrl,
    environment.serviceRoleKey,
    result.rawRecords
  )

  await upsertDashboardRecords(
    environment.supabaseUrl,
    environment.serviceRoleKey,
    result.dailyMetrics.importedRecords
  )

  const writes = [
    {
      label: 'distribution metrics',
      destination: MULTI_DATASET_DESTINATIONS.distributions,
      records: result.distributions.importedRecords
    },
    {
      label: 'agent productivity',
      destination: MULTI_DATASET_DESTINATIONS.productivity,
      records: result.productivity.importedRecords
    },
    {
      label: 'ticket drivers',
      destination: MULTI_DATASET_DESTINATIONS.drivers,
      records: result.drivers.importedRecords
    }
  ]

  for (const write of writes) {
    try {
      await upsertMappedRecords(
        environment.supabaseUrl,
        environment.serviceRoleKey,
        write.destination,
        write.records
      )
    } catch (error) {
      throw new Error(
        `Unable to store ${write.label}: ` +
        `${error?.message || 'Unknown database error.'}`
      )
    }
  }
}

async function runMultiDatasetSync(
  payload,
  environment,
  syncRunId
) {
  const result = processMultiDatasetPayload(payload, syncRunId)

  await persistMultiDatasetResult(environment, result)

  const summary = getMultiDatasetSummary(result)
  const latestReportDate = getLatestReportDate([
    ...result.dailyMetrics.importedRecords,
    ...result.distributions.importedRecords,
    ...result.productivity.importedRecords,
    ...result.drivers.importedRecords
  ])

  return {
    payloadVersion: 2,
    latestReportDate,
    summary,
    warnings: result.warnings
  }
}

async function runLegacySync(payload, environment, syncRunId) {
  const sheetData = extractSheetValues(payload)
  validateSheetPayload(sheetData)
  const indexes = buildColumnIndexes(sheetData.headers)
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

  return {
    payloadVersion: 1,
    latestReportDate: getLatestReportDate(result.importedRecords),
    summary: {
      rowsImported: result.importedRecords.length,
      rowsSkipped: result.skippedRows,
      rowsIgnored: result.ignoredRows,
      datasets: {
        dailyVolume: {
          metricRowsImported: result.importedRecords.length,
          rowsSkipped: result.skippedRows,
          rowsIgnored: result.ignoredRows
        }
      }
    },
    warnings: result.warnings
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

    const hasDatasetEnvelope =
      payload?.datasets !== undefined ||
      payload?.payloadVersion !== undefined

    if (hasDatasetEnvelope) {
      validateMultiDatasetPayload(payload)
    } else {
      const legacySheetData = extractSheetValues(payload)
      validateSheetPayload(legacySheetData)
    }

    syncRunId = await createSyncRun(
      environment.supabaseUrl,
      environment.serviceRoleKey,
      startedAt
    )

    const syncResult = isMultiDatasetPayload(payload)
      ? await runMultiDatasetSync(
          payload,
          environment,
          syncRunId
        )
      : await runLegacySync(
          payload,
          environment,
          syncRunId
        )

    await updateSyncRun(
      environment.supabaseUrl,
      environment.serviceRoleKey,
      syncRunId,
      {
        completed_at: new Date().toISOString(),
        status: 'success',
        report_date: syncResult.latestReportDate,
        rows_imported: syncResult.summary.rowsImported,
        error_message: null
      }
    )

    return jsonResponse({
      success: true,
      payloadVersion: syncResult.payloadVersion,
      latestReportDate: syncResult.latestReportDate,
      rowsImported: syncResult.summary.rowsImported,
      rowsSkipped: syncResult.summary.rowsSkipped,
      rowsIgnored: syncResult.summary.rowsIgnored,
      datasets: syncResult.summary.datasets,
      warnings: syncResult.warnings.slice(0, 50),
      warningCount: syncResult.warnings.length
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
