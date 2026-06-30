const EASTERN_TIME_ZONE = 'America/New_York'
const SCHEDULED_HOUR = 9
const REQUEST_DELAY_MS = 7000
const LOCK_RETRY_DELAY_MS = 30000
const MAX_RUNTIME_MS = 13 * 60 * 1000
const MAX_REQUESTS = 100

const SYNC_STREAMS = [
  {
    name: 'tickets',
    path: '/api/sync-zendesk'
  },
  {
    name: 'ticket_events',
    path: '/api/sync-zendesk-events'
  }
]

function requiredEnvironment(env, name) {
  const value = typeof env?.[name] === 'string'
    ? env[name].trim()
    : ''

  if (!value) {
    throw new Error(`Missing required Worker environment value: ${name}.`)
  }

  return value
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

export function getEasternHour(date) {
  const parts = new Intl.DateTimeFormat(
    'en-US',
    {
      timeZone: EASTERN_TIME_ZONE,
      hour: '2-digit',
      hourCycle: 'h23'
    }
  ).formatToParts(date)

  return Number(parts.find(part => part.type === 'hour')?.value)
}

export function shouldRunZendeskSync(date) {
  return getEasternHour(date) === SCHEDULED_HOUR
}

// Retained for compatibility with earlier tests and integrations.
export const shouldRunZendeskHealthCheck = shouldRunZendeskSync

async function parseJsonResponse(response) {
  const responseText = await response.text()

  if (!responseText) return null

  try {
    return JSON.parse(responseText)
  } catch {
    return null
  }
}

export async function requestZendeskSyncPage(
  env,
  stream,
  fetchImpl = fetch
) {
  const pagesBaseUrl = requiredEnvironment(env, 'PAGES_BASE_URL')
  const syncSecret = requiredEnvironment(env, 'ZENDESK_SYNC_SECRET')
  const endpoint = new URL(stream.path, pagesBaseUrl)
  const response = await fetchImpl(endpoint.toString(), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${syncSecret}`,
      'Content-Type': 'application/json',
      'X-Sync-Source': 'scheduled'
    },
    body: '{}'
  })
  const payload = await parseJsonResponse(response)

  if (
    response.status === 409 &&
    payload?.code === 'zendesk_sync_locked'
  ) {
    return {
      locked: true,
      payload
    }
  }

  if (!response.ok || payload?.success !== true) {
    const error = new Error(
      `Zendesk ${stream.name} synchronization failed with status ` +
      `${response.status}.`
    )
    error.status = response.status
    error.code = payload?.code || 'zendesk_sync_request_failed'
    throw error
  }

  return {
    locked: false,
    payload
  }
}

function createStreamState(stream) {
  return {
    ...stream,
    complete: false,
    pages: 0,
    locks: 0,
    ticketsProcessed: 0,
    sourceEventsProcessed: 0,
    eventsSeen: 0,
    eventsImported: 0,
    duplicateEvents: 0
  }
}

function addPayloadTotals(state, payload) {
  state.pages += 1
  state.ticketsProcessed += Number(payload?.ticketsProcessed) || 0
  state.sourceEventsProcessed +=
    Number(payload?.sourceEventsProcessed) || 0
  state.eventsSeen += Number(payload?.eventsSeen) || 0
  state.eventsImported += Number(payload?.eventsImported) || 0
  state.duplicateEvents += Number(payload?.duplicateEvents) || 0
  state.complete =
    payload?.endOfStream === true || payload?.hasMore !== true
}

export async function runZendeskScheduledSync(
  env,
  {
    fetchImpl = fetch,
    sleepImpl = delay,
    nowImpl = Date.now,
    requestDelayMs = REQUEST_DELAY_MS,
    lockRetryDelayMs = LOCK_RETRY_DELAY_MS,
    maxRuntimeMs = MAX_RUNTIME_MS,
    maxRequests = MAX_REQUESTS
  } = {}
) {
  // Validate before starting so a bad deployment fails immediately.
  requiredEnvironment(env, 'PAGES_BASE_URL')
  requiredEnvironment(env, 'ZENDESK_SYNC_SECRET')

  const startedAtMs = nowImpl()
  const deadlineMs = startedAtMs + maxRuntimeMs
  const streams = SYNC_STREAMS.map(createStreamState)
  let requests = 0

  while (
    streams.some(stream => !stream.complete) &&
    requests < maxRequests &&
    nowImpl() < deadlineMs
  ) {
    for (const stream of streams) {
      if (
        stream.complete ||
        requests >= maxRequests ||
        nowImpl() >= deadlineMs
      ) {
        continue
      }

      const result = await requestZendeskSyncPage(
        env,
        stream,
        fetchImpl
      )
      requests += 1

      if (result.locked) {
        stream.locks += 1
        console.warn(JSON.stringify({
          event: 'zendesk_sync_locked',
          stream: stream.name,
          request: requests
        }))

        if (nowImpl() + lockRetryDelayMs < deadlineMs) {
          await sleepImpl(lockRetryDelayMs)
        }

        continue
      }

      addPayloadTotals(stream, result.payload)

      console.log(JSON.stringify({
        event: 'zendesk_sync_page',
        stream: stream.name,
        request: requests,
        page: stream.pages,
        eventsSeen: Number(result.payload?.eventsSeen) || 0,
        eventsImported: Number(result.payload?.eventsImported) || 0,
        duplicateEvents: Number(result.payload?.duplicateEvents) || 0,
        endOfStream: result.payload?.endOfStream === true,
        hasMore: result.payload?.hasMore === true
      }))

      const hasPendingWork = streams.some(item => !item.complete)

      if (
        hasPendingWork &&
        requests < maxRequests &&
        nowImpl() + requestDelayMs < deadlineMs
      ) {
        await sleepImpl(requestDelayMs)
      }
    }
  }

  const summary = {
    event: 'zendesk_scheduled_sync',
    scheduledHourEastern: SCHEDULED_HOUR,
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: new Date(nowImpl()).toISOString(),
    requests,
    complete: streams.every(stream => stream.complete),
    streams: streams.map(stream => ({
      name: stream.name,
      complete: stream.complete,
      pages: stream.pages,
      locks: stream.locks,
      ticketsProcessed: stream.ticketsProcessed,
      sourceEventsProcessed: stream.sourceEventsProcessed,
      eventsSeen: stream.eventsSeen,
      eventsImported: stream.eventsImported,
      duplicateEvents: stream.duplicateEvents
    }))
  }

  if (summary.complete) {
    console.log(JSON.stringify(summary))
  } else {
    console.warn(JSON.stringify(summary))
  }

  return summary
}

// Retained as a compatibility alias while the Worker project keeps its
// existing deployment name.
export const runZendeskHealthCheck = runZendeskScheduledSync

export default {
  async scheduled(controller, env, context) {
    const scheduledDate = new Date(controller.scheduledTime)

    if (!shouldRunZendeskSync(scheduledDate)) return

    context.waitUntil(runZendeskScheduledSync(env))
  },

  async fetch() {
    return new Response(
      'Zendesk synchronization cron is active at 9:00 AM Eastern.',
      {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store'
        }
      }
    )
  }
}
