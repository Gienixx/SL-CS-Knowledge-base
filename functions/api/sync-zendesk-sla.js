import {
  fetchZendeskJson,
  getBearerToken,
  getZendeskEnvironment,
  secretsMatch
} from '../_shared/zendesk-client.js'
import {
  normalizeSlaMetricEvents
} from '../_shared/zendesk-sla-event-normalizer.js'
import {
  acquireZendeskSyncLock,
  advanceZendeskSlaSyncState,
  createZendeskSyncRun,
  insertTicketEvents,
  releaseZendeskSyncLock,
  updateZendeskSyncRun
} from '../_shared/zendesk-sync-store.js'

const STREAM_KEY = 'ticket_metric_events'
const DEFAULT_LOOKBACK_DAYS = 7

function respond(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers
    }
  })
}

function initialTime(env) {
  const configured = Number(
    env?.ZENDESK_SLA_INITIAL_START_TIME ||
    env?.ZENDESK_EVENT_INITIAL_START_TIME ||
    env?.ZENDESK_INITIAL_START_TIME
  )
  const now = Math.floor(Date.now() / 1000)

  return Number.isInteger(configured) && configured > 0 && configured <= now
    ? configured
    : now - DEFAULT_LOOKBACK_DAYS * 86400
}

function triggerSource(request) {
  return request.headers.get('X-Sync-Source') === 'scheduled'
    ? 'scheduled'
    : 'manual'
}

export function isSlaMetricPageComplete(page, eventCount) {
  if (typeof page?.end_of_stream === 'boolean') {
    return page.end_of_stream
  }

  return Number(eventCount) < 100
}

function summarizeSlaEvidence(sourceEvents, normalizedEvents) {
  const policyEvidence = sourceEvents.some(event => {
    const deleted = event?.deleted === true ||
      event?.deleted === 1 ||
      event?.deleted === 'true'

    return !deleted && ['apply_sla', 'apply_group_sla', 'breach'].includes(
      String(event?.type || '').trim().toLowerCase()
    )
  })

  return {
    policyEvidence,
    breachEvidence: normalizedEvents.length > 0
  }
}

function latestTimestamp(events) {
  return events.at(-1)?.event_timestamp || null
}

function publicFailure(error) {
  const message = String(error?.message || '')

  if (message.includes('zendesk_sync_locked')) {
    return {
      status: 409,
      code: 'zendesk_sync_locked',
      error: 'Another Zendesk SLA synchronization is currently running.'
    }
  }

  if (error?.status === 403 || error?.status === 404) {
    return {
      status: 503,
      code: 'zendesk_sla_unavailable',
      error: 'Zendesk SLA metric events are not enabled or are not accessible to the API user.'
    }
  }

  return {
    status: 500,
    code: 'zendesk_sla_sync_failed',
    error: 'Unable to synchronize Zendesk SLA metric events.'
  }
}

export async function onRequestPost(context) {
  let environment

  try {
    environment = getZendeskEnvironment(context.env)
  } catch (error) {
    return respond({
      success: false,
      code: 'zendesk_configuration_incomplete',
      error: error.message
    }, 503)
  }

  if (!await secretsMatch(
    getBearerToken(context.request),
    environment.syncSecret
  )) {
    return respond({
      success: false,
      code: 'unauthorized',
      error: 'Unauthorized Zendesk SLA synchronization request.'
    }, 401, { 'WWW-Authenticate': 'Bearer' })
  }

  const lockToken = crypto.randomUUID()
  let lockAcquired = false
  let runId = null

  try {
    const state = await acquireZendeskSyncLock(
      environment,
      STREAM_KEY,
      lockToken
    )
    lockAcquired = true

    const startTime = state.current_start_time || initialTime(context.env)
    runId = await createZendeskSyncRun(environment, {
      streamKey: STREAM_KEY,
      startedAt: new Date().toISOString(),
      triggerSource: triggerSource(context.request),
      cursorBefore: String(startTime)
    })

    const page = await fetchZendeskJson(
      environment,
      '/api/v2/incremental/ticket_metric_events.json',
      {
        start_time: startTime,
        exclude_deleted: true,
        include_changes: true
      }
    )
    const sourceEvents = Array.isArray(page?.ticket_metric_events)
      ? page.ticket_metric_events
      : []
    const events = normalizeSlaMetricEvents(sourceEvents)
    const imported = await insertTicketEvents(environment, events)
    const evidence = summarizeSlaEvidence(sourceEvents, events)
    const endTime = Number(page?.end_time)

    if (!Number.isInteger(endTime) || endTime <= 0) {
      throw new Error('Zendesk SLA export returned no valid end time.')
    }

    const slaReady = await advanceZendeskSlaSyncState(environment, {
      streamKey: STREAM_KEY,
      lockToken,
      startTime: endTime,
      lastEventTimestamp: latestTimestamp(events),
      ...evidence,
      observedAt: new Date().toISOString()
    })
    lockAcquired = false

    await updateZendeskSyncRun(environment, runId, {
      completed_at: new Date().toISOString(),
      status: 'success',
      cursor_after: String(endTime),
      tickets_processed: new Set(
        sourceEvents.map(item => item?.ticket_id).filter(Boolean)
      ).size,
      events_seen: events.length,
      events_imported: imported,
      duplicate_events: events.length - imported,
      warnings_count: 0,
      error_message: null
    })

    const endOfStream = isSlaMetricPageComplete(page, sourceEvents.length)

    return respond({
      success: true,
      stream: STREAM_KEY,
      sourceEventsProcessed: sourceEvents.length,
      eventsSeen: events.length,
      eventsImported: imported,
      duplicateEvents: events.length - imported,
      ignoredEvents: sourceEvents.length - events.length,
      policyEvidenceObserved: evidence.policyEvidence,
      breachEvidenceObserved: evidence.breachEvidence,
      slaReady,
      endOfStream,
      hasMore: !endOfStream,
      nextStartTime: endTime
    })
  } catch (error) {
    if (lockAcquired) {
      await releaseZendeskSyncLock(
        environment,
        STREAM_KEY,
        lockToken
      ).catch(() => {})
    }

    if (runId) {
      await updateZendeskSyncRun(environment, runId, {
        completed_at: new Date().toISOString(),
        status: 'failed',
        error_message: String(
          error?.message || 'SLA metric-event synchronization failed.'
        ).slice(0, 1000)
      }).catch(() => {})
    }

    const failure = publicFailure(error)
    console.error('Zendesk SLA synchronization failed:', {
      code: failure.code,
      message: error?.message || failure.error
    })

    return respond({
      success: false,
      code: failure.code,
      error: failure.error
    }, failure.status)
  }
}

export function onRequestGet() {
  return respond({
    success: false,
    code: 'method_not_allowed',
    error: 'Use POST for Zendesk SLA synchronization.'
  }, 405, { Allow: 'POST' })
}
