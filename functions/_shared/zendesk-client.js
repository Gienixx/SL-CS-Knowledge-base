const ZENDESK_SUBDOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/i
const DEFAULT_TIMEOUT_MS = 10000
const READINESS_LOOKBACK_DAYS = 7

export class ZendeskApiError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'ZendeskApiError'
    this.status = Number(options.status) || 0
    this.code = options.code || 'zendesk_request_failed'
    this.retryAfter = options.retryAfter || null
  }
}

function requiredValue(env, name, missing) {
  const value = typeof env?.[name] === 'string'
    ? env[name].trim()
    : ''

  if (!value) missing.push(name)
  return value
}

function normalizeSupabaseUrl(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

export function getZendeskEnvironment(
  env,
  { requireSyncSecret = true, requireSupabase = true } = {}
) {
  const missing = []
  const subdomain = requiredValue(env, 'ZENDESK_SUBDOMAIN', missing)
  const email = requiredValue(env, 'ZENDESK_EMAIL', missing)
  const apiToken = requiredValue(env, 'ZENDESK_API_TOKEN', missing)
  const syncSecret = requireSyncSecret
    ? requiredValue(env, 'ZENDESK_SYNC_SECRET', missing)
    : ''
  const supabaseUrl = requireSupabase
    ? requiredValue(env, 'SUPABASE_URL', missing)
    : ''
  const serviceRoleKey = requireSupabase
    ? requiredValue(env, 'SUPABASE_SERVICE_ROLE_KEY', missing)
    : ''

  if (missing.length > 0) {
    throw new Error(
      `Zendesk integration environment variables are incomplete: ` +
      `${missing.join(', ')}.`
    )
  }

  if (!ZENDESK_SUBDOMAIN_PATTERN.test(subdomain)) {
    throw new Error('ZENDESK_SUBDOMAIN must contain only the subdomain value.')
  }

  if (!email.includes('@')) {
    throw new Error('ZENDESK_EMAIL must contain a valid email address.')
  }

  return {
    subdomain,
    email,
    apiToken,
    syncSecret,
    baseUrl: `https://${subdomain}.zendesk.com`,
    supabaseUrl: supabaseUrl ? normalizeSupabaseUrl(supabaseUrl) : '',
    serviceRoleKey
  }
}

export function getBearerToken(request) {
  const authorization = request.headers.get('Authorization')

  if (!authorization || !authorization.startsWith('Bearer ')) {
    return null
  }

  return authorization.slice('Bearer '.length).trim()
}

export async function secretsMatch(receivedSecret, expectedSecret) {
  if (
    typeof receivedSecret !== 'string' ||
    typeof expectedSecret !== 'string' ||
    !receivedSecret ||
    !expectedSecret
  ) {
    return false
  }

  const encoder = new TextEncoder()
  const [receivedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(receivedSecret)),
    crypto.subtle.digest('SHA-256', encoder.encode(expectedSecret))
  ])
  const receivedBytes = new Uint8Array(receivedDigest)
  const expectedBytes = new Uint8Array(expectedDigest)
  let difference = receivedBytes.length ^ expectedBytes.length

  for (let index = 0; index < receivedBytes.length; index += 1) {
    difference |= receivedBytes[index] ^ expectedBytes[index]
  }

  return difference === 0
}

function encodeBase64(value) {
  const bytes = new TextEncoder().encode(value)
  let binary = ''

  bytes.forEach(byte => {
    binary += String.fromCharCode(byte)
  })

  return btoa(binary)
}

export function createZendeskAuthorization(email, apiToken) {
  return `Basic ${encodeBase64(`${email}/token:${apiToken}`)}`
}

export function buildZendeskUrl(environment, path, query = {}) {
  if (!path.startsWith('/api/v2/')) {
    throw new Error('Zendesk API paths must start with /api/v2/.')
  }

  const url = new URL(path, environment.baseUrl)

  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value))
    }
  })

  return url.toString()
}

function errorCodeForStatus(status) {
  if (status === 401) return 'zendesk_authentication_failed'
  if (status === 403) return 'zendesk_permission_denied'
  if (status === 404) return 'zendesk_resource_unavailable'
  if (status === 429) return 'zendesk_rate_limited'
  return 'zendesk_request_failed'
}

export async function fetchZendeskJson(
  environment,
  path,
  query = {},
  { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}
) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchImpl(
      buildZendeskUrl(environment, path, query),
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: createZendeskAuthorization(
            environment.email,
            environment.apiToken
          )
        },
        signal: controller.signal
      }
    )
    const responseText = await response.text()
    let responseData = null

    if (responseText) {
      try {
        responseData = JSON.parse(responseText)
      } catch {
        responseData = null
      }
    }

    if (!response.ok) {
      throw new ZendeskApiError(
        `Zendesk request failed with status ${response.status}.`,
        {
          status: response.status,
          code: errorCodeForStatus(response.status),
          retryAfter: response.headers.get('Retry-After')
        }
      )
    }

    return responseData || {}
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new ZendeskApiError('Zendesk request timed out.', {
        code: 'zendesk_request_timeout'
      })
    }

    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function probeAccess(request) {
  try {
    const data = await request()
    return {
      status: 'available',
      httpStatus: 200,
      data
    }
  } catch (error) {
    if (error instanceof ZendeskApiError) {
      return {
        status: error.status === 429 ? 'rate_limited' : 'unavailable',
        httpStatus: error.status || null,
        data: null
      }
    }

    throw error
  }
}

function firstArrayLength(payload, keys) {
  for (const key of keys) {
    if (Array.isArray(payload?.[key])) return payload[key].length
  }

  return 0
}

export async function testZendeskConnection(
  environment,
  { fetchImpl = fetch, now = Date.now() } = {}
) {
  const startTime = Math.floor(
    (now - READINESS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000) / 1000
  )
  const requestOptions = { fetchImpl }
  const userPayload = await fetchZendeskJson(
    environment,
    '/api/v2/users/me.json',
    {},
    requestOptions
  )
  const ticketPayload = await fetchZendeskJson(
    environment,
    '/api/v2/incremental/tickets/cursor.json',
    {
      start_time: startTime,
      per_page: 1,
      include: 'metric_sets'
    },
    requestOptions
  )
  const tickets = Array.isArray(ticketPayload?.tickets)
    ? ticketPayload.tickets
    : []
  const sampleTicketId = tickets[0]?.id
  const auditProbe = sampleTicketId
    ? await probeAccess(() => fetchZendeskJson(
        environment,
        `/api/v2/tickets/${encodeURIComponent(sampleTicketId)}/audits.json`,
        { per_page: 1 },
        requestOptions
      ))
    : {
        status: 'not_tested_no_recent_ticket',
        httpStatus: null,
        data: null
      }
  const metricEventProbe = await probeAccess(() => fetchZendeskJson(
    environment,
    '/api/v2/incremental/ticket_metric_events.json',
    {
      start_time: startTime,
      exclude_deleted: true,
      include_changes: true
    },
    requestOptions
  ))
  const satisfactionProbe = await probeAccess(() => fetchZendeskJson(
    environment,
    '/api/v2/satisfaction_ratings.json',
    {
      start_time: startTime,
      per_page: 1
    },
    requestOptions
  ))
  const user = userPayload?.user || {}
  const metricSetCount = firstArrayLength(ticketPayload, [
    'metric_sets',
    'ticket_metrics'
  ])

  return {
    checkedAt: new Date(now).toISOString(),
    authenticatedRole: user.role || null,
    access: {
      tickets: 'available',
      ticketMetrics: metricSetCount > 0
        ? 'available'
        : 'not_observed_in_sample',
      ticketAudits: auditProbe.status,
      ticketMetricEvents: metricEventProbe.status,
      customerSatisfaction: satisfactionProbe.status
    },
    sample: {
      ticketsReturned: tickets.length,
      metricSetsReturned: metricSetCount,
      metricEventsReturned: firstArrayLength(
        metricEventProbe.data,
        ['ticket_metric_events']
      ),
      satisfactionRatingsReturned: firstArrayLength(
        satisfactionProbe.data,
        ['satisfaction_ratings']
      ),
      endOfStream: Boolean(ticketPayload?.end_of_stream)
    },
    readyForTicketEventImport:
      auditProbe.status === 'available' ||
      auditProbe.status === 'not_tested_no_recent_ticket',
    readyForSlaImport: metricEventProbe.status === 'available',
    readyForCsatImport: satisfactionProbe.status === 'available'
  }
}
