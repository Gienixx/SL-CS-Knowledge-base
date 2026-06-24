import {
  PHASE_ONE_DASHBOARD_MAPPING
} from '../../config/dashboard-data-mapping.js'

const RAW_INSERT_BATCH_SIZE = 100

async function supabaseRequest(
  supabaseUrl,
  serviceRoleKey,
  path,
  options = {}
) {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        ...(options.headers || {})
      }
    }
  )

  const responseText = await response.text()
  let responseData = null

  if (responseText) {
    try {
      responseData = JSON.parse(responseText)
    } catch {
      responseData = responseText
    }
  }

  if (!response.ok) {
    const details = typeof responseData === 'string'
      ? responseData
      : responseData?.message ||
        responseData?.details ||
        JSON.stringify(responseData)

    throw new Error(
      `Supabase request failed with status ${response.status}: ${details}`
    )
  }

  return responseData
}

export async function createSyncRun(
  supabaseUrl,
  serviceRoleKey,
  startedAt
) {
  const rows = await supabaseRequest(
    supabaseUrl,
    serviceRoleKey,
    'sheet_sync_runs',
    {
      method: 'POST',
      headers: {
        Prefer: 'return=representation'
      },
      body: JSON.stringify({
        started_at: startedAt,
        status: 'running',
        rows_imported: 0,
        sync_source: 'apps_script'
      })
    }
  )

  const syncRunId = Array.isArray(rows)
    ? rows[0]?.id
    : rows?.id

  if (!syncRunId) {
    throw new Error('The synchronization run could not be created.')
  }

  return syncRunId
}

export async function updateSyncRun(
  supabaseUrl,
  serviceRoleKey,
  syncRunId,
  updates
) {
  if (!syncRunId) return

  await supabaseRequest(
    supabaseUrl,
    serviceRoleKey,
    `sheet_sync_runs?id=eq.${encodeURIComponent(syncRunId)}`,
    {
      method: 'PATCH',
      headers: {
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(updates)
    }
  )
}

export async function insertRawRecords(
  supabaseUrl,
  serviceRoleKey,
  rawRecords
) {
  for (
    let start = 0;
    start < rawRecords.length;
    start += RAW_INSERT_BATCH_SIZE
  ) {
    const batch = rawRecords.slice(
      start,
      start + RAW_INSERT_BATCH_SIZE
    )

    await supabaseRequest(
      supabaseUrl,
      serviceRoleKey,
      'raw_sheet_imports',
      {
        method: 'POST',
        headers: {
          Prefer: 'return=minimal'
        },
        body: JSON.stringify(batch)
      }
    )
  }
}

export async function upsertDashboardRecords(
  supabaseUrl,
  serviceRoleKey,
  records
) {
  if (records.length === 0) return

  const tableName = PHASE_ONE_DASHBOARD_MAPPING.destination.tableName
  const conflictColumn = PHASE_ONE_DASHBOARD_MAPPING.destination.conflictColumn

  await supabaseRequest(
    supabaseUrl,
    serviceRoleKey,
    `${tableName}?on_conflict=${encodeURIComponent(conflictColumn)}`,
    {
      method: 'POST',
      headers: {
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(records)
    }
  )
}
