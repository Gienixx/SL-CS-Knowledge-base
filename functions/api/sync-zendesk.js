import {
  fetchZendeskJson,
  getBearerToken,
  getZendeskEnvironment,
  secretsMatch
} from '../_shared/zendesk-client.js'
import {
  buildTicketEvents,
  deduplicateTicketEvents,
  findMetricSet
} from '../_shared/zendesk-event-normalizer.js'
import {
  buildTicketDimensionProfiles,
  configuredTicketDimensionFieldCount,
  getZendeskTicketDimensionFieldMap
} from '../_shared/zendesk-ticket-dimension-normalizer.js'
import {
  upsertTicketDimensionProfiles
} from '../_shared/zendesk-ticket-dimension-store.js'
import {
  acquireZendeskSyncLock,
  advanceZendeskSyncState,
  createZendeskSyncRun,
  insertTicketEvents,
  releaseZendeskSyncLock,
  updateZendeskSyncRun
} from '../_shared/zendesk-sync-store.js'

const STREAM_KEY = 'tickets'
const DEFAULT_LOOKBACK_DAYS = 7
const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 50

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers
    }
  })
}

function getInitialStartTime(env, now) {
  const configured = Number(env?.ZENDESK_INITIAL_START_TIME)
  const currentSeconds = Math.floor(now / 1000)

  if (
    Number.isInteger(configured) &&
    configured > 0 &&
    configured <= currentSeconds
  ) {
    return configured
  }

  return currentSeconds - DEFAULT_LOOKBACK_DAYS * 86400
}

function getPageSize(env) {
  const configured = Number(env?.ZENDESK_SYNC_PAGE_SIZE)

  return Number.isInteger(configured) && configured > 0
    ? Math.min(configured, MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE
}

function getTriggerSource(request) {
  return request.headers.get('X-Sync-Source') === 'scheduled'
    ? 'scheduled'
    : 'manual'
}

async function fetchTicketPage(
  environment,
  state,
  initialStartTime,
  pageSize
) {
  const query = state.current_cursor
    ? {
        cursor: state.current_cursor,
        per_page: pageSize,
        include: 'metric_sets'
      }
    : {
        start_time: state.current_start_time || initialStartTime,
        per_page: pageSize,
        include: 'metric_sets'
      }

  return fetchZendeskJson(
    environment,
    '/api/v2/incremental/tickets/cursor.json',
    query
  )
}

function latestTimestamp(events) {
  return events.reduce(
    (latest, event) =>
      !latest || event.event_timestamp > latest
        ? event.event_timestamp
        : latest,
    null
  )
}

function publicFailure(error) {
  const locked = String(error?.message || '').includes(
    'zendesk_sync_locked'
  )

  return locked
    ? {
        status: 409,
        code: 'zendesk_sync_locked',
        message: 'Another Zendesk synchronization is currently running.'
      }
    : {
        status: 500,
        code: 'zendesk_sync_failed',
        message: 'Unable to synchronize Zendesk ticket snapshots.'
      }
}

export async function onRequestPost(context) {
  let environment

  try {
    environment = getZendeskEnvironment(context.env)
  } catch (error) {
    return jsonResponse({
      success: false,
      code: 'zendesk_configuration_incomplete',
      error: error.message
    }, 503)
  }

  if (!await secretsMatch(
    getBearerToken(context.request),
    environment.syncSecret
  )) {
    return jsonResponse({
      success: false,
      code: 'unauthorized',
      error: 'Unauthorized Zendesk synchronization request.'
    }, 401, { 'WWW-Authenticate': 'Bearer' })
  }

  const lockToken = crypto.randomUUID()
  const startedAt = new Date().toISOString()
  const initialStartTime = getInitialStartTime(context.env, Date.now())
  let runId = null
  let lockAcquired = false

  try {
    const state = await acquireZendeskSyncLock(
      environment,
      STREAM_KEY,
      lockToken
    )
    lockAcquired = true

    runId = await createZendeskSyncRun(environment, {
      streamKey: STREAM_KEY,
      startedAt,
      triggerSource: getTriggerSource(context.request),
      cursorBefore: state.current_cursor
    })

    const page = await fetchTicketPage(
      environment,
      state,
      initialStartTime,
      getPageSize(context.env)
    )
    const tickets = Array.isArray(page?.tickets) ? page.tickets : []
    const metricSets = Array.isArray(page?.metric_sets)
      ? page.metric_sets
      : Array.isArray(page?.ticket_metrics)
        ? page.ticket_metrics
        : []
    const events = deduplicateTicketEvents(
      tickets.flatMap(ticket => buildTicketEvents(
        ticket,
        findMetricSet(metricSets, ticket.id)
      ))
    )
    const insertedEvents = await insertTicketEvents(environment, events)

    const dimensionFieldMap = getZendeskTicketDimensionFieldMap(context.env)
    const dimensionFieldsConfigured = configuredTicketDimensionFieldCount(
      dimensionFieldMap
    )
    const dimensionProfiles = dimensionFieldsConfigured > 0
      ? buildTicketDimensionProfiles(tickets, dimensionFieldMap)
      : []
    const dimensionProfilesUpserted = dimensionProfiles.length > 0
      ? await upsertTicketDimensionProfiles(environment, dimensionProfiles)
      : 0

    const cursorAfter = page?.after_cursor || state.current_cursor || null
    const endTime = Number(page?.end_time)
    const nextStartTime = Number.isInteger(endTime) && endTime > 0
      ? endTime
      : state.current_start_time || initialStartTime

    await advanceZendeskSyncState(environment, {
      streamKey: STREAM_KEY,
      lockToken,
      cursor: cursorAfter,
      startTime: nextStartTime,
      lastEventTimestamp: latestTimestamp(events)
    })
    lockAcquired = false

    await updateZendeskSyncRun(environment, runId, {
      completed_at: new Date().toISOString(),
      status: 'success',
      cursor_after: cursorAfter,
      tickets_processed: tickets.length,
      events_seen: events.length,
      events_imported: insertedEvents,
      duplicate_events: events.length - insertedEvents,
      warnings_count: dimensionFieldsConfigured > 0
        ? tickets.length - dimensionProfiles.length
        : 0,
      error_message: null
    })

    return jsonResponse({
      success: true,
      stream: STREAM_KEY,
      ticketsProcessed: tickets.length,
      eventsSeen: events.length,
      eventsImported: insertedEvents,
      duplicateEvents: events.length - insertedEvents,
      dimensionFieldsConfigured,
      dimensionProfilesSeen: dimensionProfiles.length,
      dimensionProfilesUpserted,
      endOfStream: Boolean(page?.end_of_stream),
      hasMore: !Boolean(page?.end_of_stream)
    })
  } catch (error) {
    if (lockAcquired) {
      try {
        await releaseZendeskSyncLock(
          environment,
          STREAM_KEY,
          lockToken
        )
      } catch (releaseError) {
        console.error('Unable to release Zendesk snapshot lock:', releaseError)
      }
    }

    if (runId) {
      try {
        await updateZendeskSyncRun(environment, runId, {
          completed_at: new Date().toISOString(),
          status: 'failed',
          error_message: String(
            error?.message || 'Unknown synchronization error.'
          ).slice(0, 1000)
        })
      } catch (loggingError) {
        console.error('Unable to record failed snapshot sync:', loggingError)
      }
    }

    const failure = publicFailure(error)
    console.error('Zendesk snapshot synchronization failed:', {
      code: failure.code,
      message: error?.message || failure.message
    })

    return jsonResponse({
      success: false,
      code: failure.code,
      error: failure.message
    }, failure.status)
  }
}

export function onRequestGet() {
  return jsonResponse({
    success: false,
    code: 'method_not_allowed',
    error: 'Use POST for Zendesk synchronization.'
  }, 405, { Allow: 'POST' })
}
