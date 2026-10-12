import {
  PHASE_ONE_DASHBOARD_MAPPING
} from '../../config/dashboard-data-mapping.js'
import {
  deduplicateMappedRecords
} from './mapped-record-batches.js'

const RAW_INSERT_BATCH_SIZE = 100
const PRODUCTIVITY_IDENTITY_PAGE_SIZE = 500
const PRODUCTIVITY_IDENTITY_DATE_BATCH_SIZE = 100

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

function normalizeIdentityName(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
    : ''
}

/**
 * Resolve explicitly reconciled source display names through the existing
 * identity map. Unmapped names keep their dynamic header-derived key.
 */
export async function resolveProductivityIdentityMap(
  supabaseUrl,
  serviceRoleKey,
  productivityRecords
) {
  const identityMap = []

  for (
    let offset = 0;
    ;
    offset += PRODUCTIVITY_IDENTITY_PAGE_SIZE
  ) {
    const rows = await supabaseRequest(
      supabaseUrl,
      serviceRoleKey,
      'agent_identity_map?select=agent_key,agent_name,dashboard_sync_approved' +
        '&order=agent_key.asc' +
        `&limit=${PRODUCTIVITY_IDENTITY_PAGE_SIZE}` +
        `&offset=${offset}`,
      {
        method: 'GET'
      }
    )

    if (!Array.isArray(rows)) {
      throw new Error('Stored productivity identities could not be loaded.')
    }

    identityMap.push(...rows)
    if (rows.length < PRODUCTIVITY_IDENTITY_PAGE_SIZE) break
  }

  const identityByNormalizedName = new Map()
  identityMap.forEach(identity => {
    const normalizedName = normalizeIdentityName(identity.agent_name)
    if (!normalizedName) return

    const existingIdentity = identityByNormalizedName.get(normalizedName)
    if (
      existingIdentity &&
      existingIdentity.agent_key !== identity.agent_key
    ) {
      const error = new Error(
        `Stored productivity identities contain an ambiguous name: ` +
        `${identity.agent_name}. Resolve the identity map before syncing.`
      )
      error.code = 'PRODUCTIVITY_IDENTITY_CONFLICT'
      throw error
    }
    identityByNormalizedName.set(normalizedName, identity)
  })

  const explicitlyApprovedKeys = new Set()
  const keysByDate = new Map()
  productivityRecords.forEach(record => {
    const mappedIdentity = identityByNormalizedName.get(
      normalizeIdentityName(record.agent_name)
    )
    if (mappedIdentity) {
      record.agent_key = mappedIdentity.agent_key
      if (mappedIdentity.dashboard_sync_approved === true) {
        explicitlyApprovedKeys.add(mappedIdentity.agent_key)
      }
    }

    if (!record.report_date || !record.agent_key) return
    if (!keysByDate.has(record.report_date)) {
      keysByDate.set(record.report_date, new Map())
    }

    const namesByKey = keysByDate.get(record.report_date)
    const previousName = namesByKey.get(record.agent_key)
    if (previousName && previousName !== record.agent_name) {
      const error = new Error(
        `Ticket Productivity source names ${previousName} and ` +
        `${record.agent_name} both resolve to key ${record.agent_key} ` +
        `on ${record.report_date}. Resolve the identity map before syncing.`
      )
      error.code = 'PRODUCTIVITY_IDENTITY_CONFLICT'
      throw error
    }
    namesByKey.set(record.agent_key, record.agent_name)
  })

  return explicitlyApprovedKeys
}

/**
 * A display-name-derived key cannot prove that a new source name is a new
 * person rather than a rename. Fail closed when a previously unseen key would
 * be written onto a report date that already has productivity history. This
 * prevents duplicate historical identities without rewriting old rows.
 */
export async function validateProductivityIdentityHistory(
  supabaseUrl,
  serviceRoleKey,
  productivityRecords,
  explicitlyApprovedKeys = new Set()
) {
  const incomingKeysByDate = new Map()

  productivityRecords.forEach(record => {
    if (!record.report_date || !record.agent_key) return
    if (!incomingKeysByDate.has(record.report_date)) {
      incomingKeysByDate.set(record.report_date, new Set())
    }
    incomingKeysByDate.get(record.report_date).add(record.agent_key)
  })

  const reportDates = [...incomingKeysByDate.keys()].sort()
  if (reportDates.length === 0) return

  const existingKeysByDate = new Map()

  for (
    let start = 0;
    start < reportDates.length;
    start += PRODUCTIVITY_IDENTITY_DATE_BATCH_SIZE
  ) {
    const dateBatch = reportDates.slice(
      start,
      start + PRODUCTIVITY_IDENTITY_DATE_BATCH_SIZE
    )
    const encodedDates = encodeURIComponent(`in.(${dateBatch.join(',')})`)
    const query =
      'agent_productivity?select=report_date,agent_key' +
      `&report_date=${encodedDates}&order=report_date.asc,agent_key.asc` +
      `&limit=${PRODUCTIVITY_IDENTITY_PAGE_SIZE}&offset=${offset}`

    for (
      let offset = 0;
      ;
      offset += PRODUCTIVITY_IDENTITY_PAGE_SIZE
    ) {
      const rows = await supabaseRequest(
        supabaseUrl,
        serviceRoleKey,
        query,
        {
          method: 'GET'
        }
      )

      if (!Array.isArray(rows)) {
        throw new Error(
          'Existing productivity identities could not be verified.'
        )
      }

      rows.forEach(row => {
        if (!existingKeysByDate.has(row.report_date)) {
          existingKeysByDate.set(row.report_date, new Set())
        }
        existingKeysByDate.get(row.report_date).add(row.agent_key)
      })

      if (rows.length < PRODUCTIVITY_IDENTITY_PAGE_SIZE) break
    }
  }

  for (const [reportDate, incomingKeys] of incomingKeysByDate) {
    const existingKeys = existingKeysByDate.get(reportDate)
    if (!existingKeys || existingKeys.size === 0) continue

    const unseenKeys = [...incomingKeys].filter(key =>
      !existingKeys.has(key) && !explicitlyApprovedKeys.has(key)
    )
    if (unseenKeys.length === 0) continue

    const error = new Error(
      'Ticket Productivity contains a new agent identity on report date ' +
      `${reportDate} that already has stored productivity history ` +
      `(${unseenKeys.join(', ')}). A changed header may represent an agent ` +
      'rename. No Analytics rows were written. Verify whether it is the same ' +
      'person; if so, update that existing agent_identity_map display name ' +
      'while preserving its agent_key. If it is a genuinely new person, ' +
      'register and explicitly approve that new identity before retrying.'
    )
    error.code = 'PRODUCTIVITY_IDENTITY_CONFLICT'
    throw error
  }
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
  const tableName = PHASE_ONE_DASHBOARD_MAPPING.destination.tableName
  const conflictColumn = PHASE_ONE_DASHBOARD_MAPPING.destination.conflictColumn
  const uniqueRecords = deduplicateMappedRecords(
    records,
    [conflictColumn]
  )

  if (uniqueRecords.length === 0) return

  await supabaseRequest(
    supabaseUrl,
    serviceRoleKey,
    `${tableName}?on_conflict=${encodeURIComponent(conflictColumn)}`,
    {
      method: 'POST',
      headers: {
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(uniqueRecords)
    }
  )
}
