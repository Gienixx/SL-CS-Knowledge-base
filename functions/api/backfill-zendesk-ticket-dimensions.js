import {
  fetchZendeskJson,
  getBearerToken,
  getZendeskEnvironment,
  secretsMatch
} from '../_shared/zendesk-client.js'
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
  releaseZendeskSyncLock,
  updateZendeskSyncRun
} from '../_shared/zendesk-sync-store.js'

const STREAM_KEY = 'ticket_dimensions_backfill'
const REQUIRED_FIELDS = ['app', 'platform', 'country', 'concern']
const DEFAULT_LOOKBACK_DAYS = 365
const DEFAULT_PAGE_SIZE = 50
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

function initialStartTime(environment, now = Date.now()) {
  const configured = Number(
    environment?.ZENDESK_DIMENSION_INITIAL_START_TIME ||
    environment?.ZENDESK_INITIAL_START_TIME
  )
  const currentSeconds = Math.floor(now / 1000)

  return Number.isInteger(configured) && configured > 0 && configured <= currentSeconds
    ? configured
    : currentSeconds - DEFAULT_LOOKBACK_DAYS * 86400
}

function pageSize(environment) {
  const configured = Number(environment?.ZENDESK_DIMENSION_PAGE_SIZE)
  return Number.isInteger(configured) && configured > 0
    ? Math.min(configured, MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE
}

async function fetchPage(environment, state, startTime, perPage) {
  const query = state.current_cursor
    ? { cursor: state.current_cursor, per_page: perPage }
    : {
        start_time: state.current_start_time || startTime,
        per_page: perPage
      }

  return fetchZendeskJson(
    environment,
    '/api/v2/incremental/tickets/cursor.json',
    query
  )
}

function failureFor(error) {
  const locked = String(error?.message || '').includes('zendesk_sync_locked')
  return locked
    ? {
        status: 409,
        code: 'zendesk_dimension_backfill_locked',
        message: 'Another Zendesk ticket-dimension backfill is running.'
      }
    : {
        status: 500,
        code: 'zendesk_dimension_backfill_failed',
        message: 'Unable to backfill Zendesk ticket dimensions.'
      }
}

export async function onRequestPost(context) {
  let zendeskEnvironment

  try {
    zendeskEnvironment = getZendeskEnvironment(context.env)
  } catch (error) {
    return respond({
      success: false,
      code: 'zendesk_configuration_incomplete',
      error: error.message
    }, 503)
  }

  if (!await secretsMatch(
    getBearerToken(context.request),
    zendeskEnvironment.syncSecret
  )) {
    return respond({
      success: false,
      code: 'unauthorized',
      error: 'Unauthorized Zendesk ticket-dimension request.'
    }, 401, { 'WWW-Authenticate': 'Bearer' })
  }

  const fieldMap = getZendeskTicketDimensionFieldMap(context.env)
  const configuredFields = configuredTicketDimensionFieldCount(fieldMap)
  const missingRequiredFields = REQUIRED_FIELDS.filter(
    fieldName => !fieldMap[fieldName]
  )

  if (missingRequiredFields.length > 0) {
    return respond({
      success: false,
      code: 'zendesk_dimension_fields_incomplete',
      error: 'Configure the app, platform, country, and concern Zendesk custom-field IDs before running the backfill.',
      configuredFields,
      requiredFields: REQUIRED_FIELDS.length,
      missingRequiredFields
    }, 503)
  }

  const lockToken = crypto.randomUUID()
  const startedAt = new Date().toISOString()
  let runId = null
  let lockAcquired = false

  try {
    const state = await acquireZendeskSyncLock(
      zendeskEnvironment,
      STREAM_KEY,
      lockToken,
      1800
    )
    lockAcquired = true

    runId = await createZendeskSyncRun(zendeskEnvironment, {
      streamKey: STREAM_KEY,
      startedAt,
      triggerSource: context.request.headers.get('X-Sync-Source') === 'scheduled'
        ? 'scheduled'
        : 'manual',
      cursorBefore: state.current_cursor || String(state.current_start_time || '') || null
    })

    const page = await fetchPage(
      zendeskEnvironment,
      state,
      initialStartTime(context.env),
      pageSize(context.env)
    )
    const tickets = Array.isArray(page?.tickets) ? page.tickets : []
    const profiles = buildTicketDimensionProfiles(tickets, fieldMap)
    const profilesUpserted = await upsertTicketDimensionProfiles(
      zendeskEnvironment,
      profiles
    )
    const cursorAfter = page?.after_cursor || state.current_cursor || null
    const endTime = Number(page?.end_time)
    const nextStartTime = Number.isInteger(endTime) && endTime > 0
      ? endTime
      : state.current_start_time || initialStartTime(context.env)
    const latestTimestamp = profiles.reduce(
      (latest, profile) =>
        profile.source_updated_at && (!latest || profile.source_updated_at > latest)
          ? profile.source_updated_at
          : latest,
      null
    )

    await advanceZendeskSyncState(zendeskEnvironment, {
      streamKey: STREAM_KEY,
      lockToken,
      cursor: cursorAfter,
      startTime: nextStartTime,
      lastEventTimestamp: latestTimestamp
    })
    lockAcquired = false

    await updateZendeskSyncRun(zendeskEnvironment, runId, {
      completed_at: new Date().toISOString(),
      status: 'success',
      cursor_after: cursorAfter || String(nextStartTime),
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
      configuredFields,
      requiredFieldsConfigured: REQUIRED_FIELDS.length,
      concernFieldConfigured: Boolean(fieldMap.concern),
      ticketsProcessed: tickets.length,
      profilesSeen: profiles.length,
      profilesUpserted,
      endOfStream: Boolean(page?.end_of_stream),
      hasMore: !Boolean(page?.end_of_stream),
      nextCursor: cursorAfter,
      nextStartTime
    })
  } catch (error) {
    if (lockAcquired) {
      await releaseZendeskSyncLock(
        zendeskEnvironment,
        STREAM_KEY,
        lockToken
      ).catch(() => {})
    }

    if (runId) {
      await updateZendeskSyncRun(zendeskEnvironment, runId, {
        completed_at: new Date().toISOString(),
        status: 'failed',
        error_message: String(
          error?.message || 'Ticket-dimension backfill failed.'
        ).slice(0, 1000)
      }).catch(() => {})
    }

    const failure = failureFor(error)
    console.error('Zendesk ticket-dimension backfill failed:', {
      code: failure.code,
      message: error?.message || failure.message
    })

    return respond({
      success: false,
      code: failure.code,
      error: failure.message
    }, failure.status)
  }
}

export function onRequestGet() {
  return respond({
    success: false,
    code: 'method_not_allowed',
    error: 'Use POST for Zendesk ticket-dimension backfill.'
  }, 405, { Allow: 'POST' })
}
