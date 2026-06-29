import {
  fetchZendeskJson,
  getBearerToken,
  getZendeskEnvironment,
  secretsMatch
} from '../_shared/zendesk-client.js'
import {
  buildAuditEvents,
  buildTicketEvents,
  deduplicateTicketEvents,
  findMetricSet
} from '../_shared/zendesk-event-normalizer.js'
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
const MAX_AUDIT_PAGES = 1000

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
  const value = request.headers.get('X-Sync-Source')
  return value === 'scheduled' ? 'scheduled' : 'manual'
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

export async function fetchTicketAudits(
  environment,
  ticketId,
  {
    fetchJson = fetchZendeskJson,
    warn = console.warn
  } = {}
) {
  const audits = []
  let afterCursor = null
  let pageCount = 0

  while (pageCount < MAX_AUDIT_PAGES) {
    const query = {
      'page[size]': 100,
      include_boundary_indicators: true
    }

    if (afterCursor) {
      query['page[after]'] = afterCursor
    }

    const payload = await fetchJson(
      environment,
      `/api/v2/tickets/${encodeURIComponent(ticketId)}/audits.json`,
      query
    )
    const pageAudits = Array.isArray(payload?.audits)
      ? payload.audits
      : []

    audits.push(...pageAudits)
    pageCount += 1

    const meta = payload?.meta
    const hasCursorMetadata =
      meta && typeof meta.has_more === 'boolean'

    if (!hasCursorMetadata) {
      if (pageAudits.length === 100) {
        warn(
          'Zendesk audit pagination metadata was unavailable; ' +
          'the ticket audit history may be truncated.',
          { ticketId }
        )
      }

      break
    }

    if (!meta.has_more) break

    const nextCursor = typeof meta.after_cursor === 'string'
      ? meta.after_cursor.trim()
      : ''

    if (!nextCursor || nextCursor === afterCursor) {
      throw new Error(
        'Zendesk audit pagination indicated more records without ' +
        'a usable next cursor.'
      )
    }

    afterCursor = nextCursor
  }

  if (pageCount >= MAX_AUDIT_PAGES) {
    throw new Error(
      `Zendesk audit pagination exceeded ${MAX_AUDIT_PAGES} pages.`
    )
  }

  return audits
}

function latestEventTimestamp(events) {
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
        message: 'Unable to synchronize Zendesk ticket events.'
      }
}

export async function onRequestPost(context) {
  let environment

  try {
    environment = getZendeskEnvironment(context.env)
  } catch (error) {
    return jsonResponse(
      {
        success: false,
        code: 'zendesk_configuration_incomplete',
        error: error.message
      },
      503
    )
  }

  if (!await secretsMatch(
    getBearerToken(context.request),
    environment.syncSecret
  )) {
    return jsonResponse(
      {
        success: false,
        code: 'unauthorized',
        error: 'Unauthorized Zendesk synchronization request.'
      },
      401,
      { 'WWW-Authenticate': 'Bearer' }
    )
  }

  const lockToken = crypto.randomUUID()
  const startedAt = new Date().toISOString()
  const initialStartTime = getInitialStartTime(
    context.env,
    Date.now()
  )
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
    const tickets = Array.isArray(page?.tickets)
      ? page.tickets
      : []
    const metricSets = Array.isArray(page?.metric_sets)
      ? page.metric_sets
      : Array.isArray(page?.ticket_metrics)
        ? page.ticket_metrics
        : []
    const events = []

    for (const ticket of tickets) {
      events.push(...buildTicketEvents(
        ticket,
        findMetricSet(metricSets, ticket.id)
      ))

      const audits = await fetchTicketAudits(
        environment,
        ticket.id
      )

      events.push(...buildAuditEvents(ticket, audits))
    }

    const uniqueEvents = deduplicateTicketEvents(events)
    const insertedEvents = await insertTicketEvents(
      environment,
      uniqueEvents
    )
    const cursorAfter =
      page?.after_cursor || state.current_cursor || null
    const endTime = Number(page?.end_time)
    const nextStartTime = Number.isInteger(endTime) && endTime > 0
      ? endTime
      : state.current_start_time || initialStartTime

    await advanceZendeskSyncState(environment, {
      streamKey: STREAM_KEY,
      lockToken,
      cursor: cursorAfter,
      startTime: nextStartTime,
      lastEventTimestamp: latestEventTimestamp(uniqueEvents)
    })
    lockAcquired = false

    await updateZendeskSyncRun(environment, runId, {
      completed_at: new Date().toISOString(),
      status: 'success',
      cursor_after: cursorAfter,
      tickets_processed: tickets.length,
      events_seen: uniqueEvents.length,
      events_imported: insertedEvents,
      duplicate_events: uniqueEvents.length - insertedEvents,
      warnings_count: 0,
      error_message: null
    })

    return jsonResponse({
      success: true,
      ticketsProcessed: tickets.length,
      eventsSeen: uniqueEvents.length,
      eventsImported: insertedEvents,
      duplicateEvents: uniqueEvents.length - insertedEvents,
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
        console.error(
          'Unable to release Zendesk synchronization lock:',
          releaseError
        )
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
        console.error(
          'Unable to record the failed Zendesk synchronization:',
          loggingError
        )
      }
    }

    const failure = publicFailure(error)

    console.error('Zendesk event synchronization failed:', {
      code: failure.code,
      message: error?.message || failure.message
    })

    return jsonResponse(
      {
        success: false,
        code: failure.code,
        error: failure.message
      },
      failure.status
    )
  }
}

export function onRequestGet() {
  return jsonResponse(
    {
      success: false,
      code: 'method_not_allowed',
      error: 'Use POST for Zendesk synchronization.'
    },
    405,
    { Allow: 'POST' }
  )
}
