import {
  fetchZendeskJson,
  getBearerToken,
  getZendeskEnvironment,
  secretsMatch
} from '../_shared/zendesk-client.js'

function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  })
}

function increment(counter, key) {
  const normalized = typeof key === 'string' && key.trim()
    ? key.trim()
    : '(missing)'

  counter[normalized] = (counter[normalized] || 0) + 1
}

function keySignature(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).sort().join(',')
    : '(not-an-object)'
}

export async function onRequestPost(context) {
  let environment

  try {
    environment = getZendeskEnvironment(context.env)
  } catch (error) {
    return response({
      success: false,
      code: 'zendesk_configuration_incomplete',
      error: error.message
    }, 503)
  }

  if (!await secretsMatch(
    getBearerToken(context.request),
    environment.syncSecret
  )) {
    return response({
      success: false,
      code: 'unauthorized',
      error: 'Unauthorized request.'
    }, 401)
  }

  const now = Math.floor(Date.now() / 1000)
  const requestedHours = Number(
    new URL(context.request.url).searchParams.get('hours')
  )
  const hours = Number.isFinite(requestedHours) && requestedHours > 0
    ? Math.min(Math.floor(requestedHours), 168)
    : 24
  const startTime = now - hours * 3600

  try {
    const page = await fetchZendeskJson(
      environment,
      '/api/v2/incremental/ticket_events.json',
      {
        start_time: startTime,
        per_page: 100
      }
    )
    const events = Array.isArray(page?.ticket_events)
      ? page.ticket_events
      : []
    const topLevelTypes = {}
    const topLevelKeySets = {}
    const childTypes = {}
    const childEventTypes = {}
    const childFieldNames = {}
    const childKeySets = {}

    for (const event of events) {
      increment(topLevelTypes, event?.type)
      increment(topLevelKeySets, keySignature(event))

      const children = Array.isArray(event?.child_events)
        ? event.child_events
        : []

      for (const child of children) {
        increment(childTypes, child?.type)
        increment(childEventTypes, child?.event_type)
        increment(childFieldNames, child?.field_name)
        increment(childKeySets, keySignature(child))
      }
    }

    return response({
      success: true,
      diagnostic: 'schema-only',
      hoursInspected: hours,
      sourceEventsProcessed: events.length,
      endOfStream: Boolean(page?.end_of_stream),
      topLevelTypes,
      topLevelKeySets,
      childTypes,
      childEventTypes,
      childFieldNames,
      childKeySets
    })
  } catch (error) {
    return response({
      success: false,
      code: 'zendesk_event_shape_failed',
      error: 'Unable to inspect Zendesk event structure.'
    }, 500)
  }
}

export function onRequestGet() {
  return response({
    success: false,
    code: 'method_not_allowed',
    error: 'Use POST.'
  }, 405)
}
