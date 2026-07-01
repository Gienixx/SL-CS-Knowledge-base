import {
  fetchZendeskJson,
  getBearerToken,
  getZendeskEnvironment,
  secretsMatch
} from '../_shared/zendesk-client.js'
import {
  normalizeIncrementalTicketEvents
} from '../_shared/zendesk-incremental-event-normalizer.js'
import {
  syncZendeskAgentDirectory
} from '../_shared/zendesk-agent-directory.js'
import {
  acquireZendeskSyncLock,
  advanceZendeskSyncState,
  createZendeskSyncRun,
  insertTicketEvents,
  releaseZendeskSyncLock,
  updateZendeskSyncRun
} from '../_shared/zendesk-sync-store.js'

const STREAM_KEY = 'ticket_events'
const NORMALIZER_VERSION = 'zendesk-child-event-v2'

function respond(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  })
}

function initialTime(env) {
  const configured = Number(
    env?.ZENDESK_EVENT_INITIAL_START_TIME ||
    env?.ZENDESK_INITIAL_START_TIME
  )
  const now = Math.floor(Date.now() / 1000)

  return Number.isInteger(configured) && configured > 0
    ? configured
    : now - 7 * 86400
}

function pageSize(env) {
  const configured = Number(env?.ZENDESK_EVENT_PAGE_SIZE)
  return Number.isInteger(configured) && configured > 0
    ? Math.min(configured, 250)
    : 100
}

function summarizeSourceEvents(sourceEvents) {
  let childEventsObserved = 0
  let changeChildrenObserved = 0
  let supportedChangeChildrenObserved = 0

  for (const parent of sourceEvents) {
    const children = Array.isArray(parent?.child_events)
      ? parent.child_events
      : []

    for (const child of children) {
      childEventsObserved += 1

      const eventType = String(
        child?.event_type ?? child?.type ?? ''
      ).trim().toLowerCase()

      if (eventType !== 'change') continue

      changeChildrenObserved += 1

      if (
        Object.prototype.hasOwnProperty.call(child, 'status') ||
        Object.prototype.hasOwnProperty.call(child, 'priority') ||
        Object.prototype.hasOwnProperty.call(child, 'assignee_id') ||
        ['status', 'priority', 'assignee_id'].includes(
          String(child?.field_name || '').trim().toLowerCase()
        )
      ) {
        supportedChangeChildrenObserved += 1
      }
    }
  }

  return {
    childEventsObserved,
    changeChildrenObserved,
    supportedChangeChildrenObserved
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
      error: 'Unauthorized request.'
    }, 401)
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
      triggerSource: context.request.headers.get('X-Sync-Source') === 'scheduled'
        ? 'scheduled'
        : 'manual',
      cursorBefore: String(startTime)
    })

    const page = await fetchZendeskJson(
      environment,
      '/api/v2/incremental/ticket_events.json',
      {
        start_time: startTime,
        per_page: pageSize(context.env)
      }
    )
    const sourceEvents = Array.isArray(page?.ticket_events)
      ? page.ticket_events
      : []
    const diagnostics = summarizeSourceEvents(sourceEvents)
    const events = normalizeIncrementalTicketEvents(sourceEvents)
    const imported = await insertTicketEvents(environment, events)
    let agentDirectoryUpdated = 0
    let agentDirectoryWarning = null

    try {
      agentDirectoryUpdated = await syncZendeskAgentDirectory(environment)
    } catch (directoryError) {
      console.error(
        'Zendesk agent directory refresh failed:',
        directoryError
      )
      agentDirectoryWarning =
        'Ticket events were imported, but agent names could not be refreshed.'
    }

    const endTime = Number(page?.end_time)

    if (!Number.isInteger(endTime) || endTime <= 0) {
      throw new Error('Zendesk event export returned no valid end time.')
    }

    await advanceZendeskSyncState(environment, {
      streamKey: STREAM_KEY,
      lockToken,
      cursor: null,
      startTime: endTime,
      lastEventTimestamp: events.at(-1)?.event_timestamp || null
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
      warnings_count: agentDirectoryWarning ? 1 : 0,
      error_message: null
    })

    return respond({
      success: true,
      stream: STREAM_KEY,
      normalizerVersion: NORMALIZER_VERSION,
      sourceEventsProcessed: sourceEvents.length,
      ...diagnostics,
      eventsSeen: events.length,
      eventsImported: imported,
      duplicateEvents: events.length - imported,
      agentDirectoryUpdated,
      agentDirectoryWarning,
      endOfStream: Boolean(page?.end_of_stream),
      hasMore: !Boolean(page?.end_of_stream),
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
        error_message: String(error?.message || 'Event sync failed.').slice(0, 1000)
      }).catch(() => {})
    }

    const locked = String(error?.message || '').includes('zendesk_sync_locked')
    return respond({
      success: false,
      code: locked ? 'zendesk_sync_locked' : 'zendesk_event_sync_failed',
      error: locked
        ? 'Another Zendesk event synchronization is running.'
        : 'Unable to synchronize Zendesk ticket events.'
    }, locked ? 409 : 500)
  }
}

export function onRequestGet() {
  return respond({
    success: false,
    code: 'method_not_allowed',
    error: 'Use POST.'
  }, 405)
}
