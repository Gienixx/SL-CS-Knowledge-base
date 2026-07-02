import {
  getServiceHeaders
} from './auth-header-helper.js'

const EVENT_BATCH_SIZE = 100

async function supabaseRequest(environment, path, options = {}) {
  const response = await fetch(
    `${environment.supabaseUrl}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        ...getServiceHeaders(environment.serviceRoleKey),
        ...(options.headers || {})
      }
    }
  )
  const text = await response.text()
  let data = null

  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }

  if (!response.ok) {
    const details = typeof data === 'string'
      ? data
      : data?.message || data?.details || JSON.stringify(data)
    const error = new Error(
      `Supabase request failed with status ${response.status}: ${details}`
    )
    error.status = response.status
    error.details = details
    throw error
  }

  return data
}

export async function acquireZendeskSyncLock(
  environment,
  streamKey,
  lockToken,
  leaseSeconds = 900
) {
  const rows = await supabaseRequest(
    environment,
    'rpc/acquire_zendesk_sync_lock',
    {
      method: 'POST',
      body: JSON.stringify({
        p_stream_key: streamKey,
        p_lock_token: lockToken,
        p_lease_seconds: leaseSeconds
      })
    }
  )

  return Array.isArray(rows) ? rows[0] || {} : rows || {}
}

export async function releaseZendeskSyncLock(
  environment,
  streamKey,
  lockToken
) {
  await supabaseRequest(
    environment,
    'rpc/release_zendesk_sync_lock',
    {
      method: 'POST',
      body: JSON.stringify({
        p_stream_key: streamKey,
        p_lock_token: lockToken
      })
    }
  )
}

export async function advanceZendeskSyncState(
  environment,
  {
    streamKey,
    lockToken,
    cursor,
    startTime,
    lastEventTimestamp
  }
) {
  await supabaseRequest(
    environment,
    'rpc/advance_zendesk_sync_state',
    {
      method: 'POST',
      body: JSON.stringify({
        p_stream_key: streamKey,
        p_lock_token: lockToken,
        p_cursor: cursor || null,
        p_start_time: startTime || null,
        p_last_event_timestamp: lastEventTimestamp || null
      })
    }
  )
}

export async function createZendeskSyncRun(
  environment,
  {
    streamKey,
    startedAt,
    triggerSource,
    cursorBefore
  }
) {
  const rows = await supabaseRequest(
    environment,
    'zendesk_sync_runs',
    {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        stream_key: streamKey,
        started_at: startedAt,
        status: 'running',
        trigger_source: triggerSource,
        cursor_before: cursorBefore || null
      })
    }
  )
  const id = Array.isArray(rows) ? rows[0]?.id : rows?.id

  if (!id) throw new Error('The Zendesk synchronization run was not created.')
  return id
}

export async function updateZendeskSyncRun(
  environment,
  runId,
  updates
) {
  if (!runId) return

  await supabaseRequest(
    environment,
    `zendesk_sync_runs?id=eq.${encodeURIComponent(runId)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(updates)
    }
  )
}

export async function insertTicketEvents(environment, events) {
  let inserted = 0

  for (let start = 0; start < events.length; start += EVENT_BATCH_SIZE) {
    const batch = events.slice(start, start + EVENT_BATCH_SIZE)
    const rows = await supabaseRequest(
      environment,
      'ticket_events?on_conflict=source_event_id',
      {
        method: 'POST',
        headers: {
          Prefer: 'resolution=ignore-duplicates,return=representation'
        },
        body: JSON.stringify(batch)
      }
    )

    inserted += Array.isArray(rows) ? rows.length : 0
  }

  return inserted
}

export async function recordZendeskSlaEvidence(
  environment,
  {
    policyEvidence = false,
    breachEvidence = false,
    observedAt = null
  } = {}
) {
  await supabaseRequest(
    environment,
    'rpc/record_zendesk_sla_evidence',
    {
      method: 'POST',
      body: JSON.stringify({
        p_policy_evidence: policyEvidence === true,
        p_breach_evidence: breachEvidence === true,
        p_observed_at: observedAt || new Date().toISOString()
      })
    }
  )
}
