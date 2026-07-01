import {
  fetchZendeskJson,
  getBearerToken,
  getZendeskEnvironment,
  secretsMatch
} from '../_shared/zendesk-client.js'
import {
  buildTicketDimensionProfiles
} from '../_shared/zendesk-ticket-profile.js'
import {
  acquireZendeskSyncLock,
  advanceZendeskSyncState,
  createZendeskSyncRun,
  releaseZendeskSyncLock,
  updateZendeskSyncRun,
  upsertTicketDimensionProfiles
} from '../_shared/zendesk-sync-store.js'

const STREAM_KEY = 'ticket_profiles'
const DEFAULT_LOOKBACK_DAYS = 365
const DEFAULT_PAGE_SIZE = 100
const MAX_PAGE_SIZE = 100

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

async function readBody(request) {
  const text = await request.text()
  if (!text) return {}

  try {
    return JSON.parse(text)
  } catch {
    throw new Error('Request body must be valid JSON.')
  }
}

function initialStartTime(environment, requestedStartTime) {
  const configured = Number(
    requestedStartTime ||
    environment?.ZENDESK_PROFILE_INITIAL_START_TIME ||
    environment?.ZENDESK_INITIAL_START_TIME
  )
  const now = Math.floor(Date.now() / 1000)

  if (
    Number.isInteger(configured) &&
    configured > 0 &&
    configured <= now
  ) {
    return configured
  }

  return now - DEFAULT_LOOKBACK_DAYS * 86400
}

function pageSize(environment) {
  const configured = Number(environment?.ZENDESK_PROFILE_PAGE_SIZE)

  return Number.isInteger(configured) && configured > 0
    ? Math.min(configured, MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE
}

function triggerSource(request) {
  return request.headers.get('X-Sync-Source') === 'scheduled'
    ? 'scheduled'
    : 'manual'
}

function latestProfileTimestamp(profiles) {
  return profiles.reduce(
    (latest, profile) =>
      profile.source_updated_at &&
      (!latest || profile.source_updated_at > latest)
        ? profile.source_updated_at
        : latest,
    null
  )
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
      error: 'Unauthorized ticket-profile backfill request.'
    }, 401, { 'WWW-Authenticate': 'Bearer' })
  }

  let body

  try {
    body = await readBody(context.request)
  } catch (error) {
    return respond({
      success: false,
      code: 'invalid_request',
      error: error.message
    }, 400)
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

    const startTime = state.current_start_time ||
      initialStartTime(context.env, body?.startTime)

    runId = await createZendeskSyncRun(environment, {
      streamKey: STREAM_KEY,
      startedAt: new Date().toISOString(),
      triggerSource: triggerSource(context.request),
      cursorBefore: state.current_cursor || String(startTime)
    })

    const query = state.current_cursor
      ? {
          cursor: state.current_cursor,
          per_page: pageSize(context.env)
        }
      : {
          start_time: startTime,
          per_page: pageSize(context.env)
        }
    const page = await fetchZendeskJson(
      environment,
      '/api/v2/incremental/tickets/cursor.json',
      query
    )
    const tickets = Array.isArray(page?.tickets) ? page.tickets : []
    const profiles = buildTicketDimensionProfiles(
      tickets,
      context.env
    )
    const profilesUpserted = await upsertTicketDimensionProfiles(
      environment,
      profiles
    )
    const cursorAfter = page?.after_cursor || state.current_cursor || null
    const endTime = Number(page?.end_time)
    const nextStartTime = Number.isInteger(endTime) && endTime > 0
      ? endTime
      : startTime

    await advanceZendeskSyncState(environment, {
      streamKey: STREAM_KEY,
      lockToken,
      cursor: cursorAfter,
      startTime: nextStartTime,
      lastEventTimestamp: latestProfileTimestamp(profiles)
    })
    lockAcquired = false

    await updateZendeskSyncRun(environment, runId, {
      completed_at: new Date().toISOString(),
      status: 'success',
      cursor_after: cursorAfter,
      tickets_processed: tickets.length,
      events_seen: profiles.length,
      events_imported: profilesUpserted,
      duplicate_events: 0,
      warnings_count: tickets.length - profiles.length,
      error_message: null
    })

    return respond({
      success: true,
      stream: STREAM_KEY,
      ticketsProcessed: tickets.length,
      profilesProcessed: profiles.length,
      profilesUpserted,
      endOfStream: Boolean(page?.end_of_stream),
      hasMore: !Boolean(page?.end_of_stream)
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
          error?.message || 'Ticket-profile backfill failed.'
        ).slice(0, 1000)
      }).catch(() => {})
    }

    const locked = String(error?.message || '').includes(
      'zendesk_sync_locked'
    )

    console.error('Zendesk ticket-profile backfill failed:', {
      locked,
      message: error?.message || 'Unknown error.'
    })

    return respond({
      success: false,
      code: locked
        ? 'zendesk_sync_locked'
        : 'zendesk_profile_backfill_failed',
      error: locked
        ? 'Another ticket-profile synchronization is running.'
        : 'Unable to backfill Zendesk ticket profiles.'
    }, locked ? 409 : 500)
  }
}

export function onRequestGet() {
  return respond({
    success: false,
    code: 'method_not_allowed',
    error: 'Use POST.'
  }, 405, { Allow: 'POST' })
}
