import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildZendeskUrl,
  createZendeskAuthorization,
  getZendeskEnvironment,
  secretsMatch,
  testZendeskConnection
} from '../functions/_shared/zendesk-client.js'
import {
  getEasternHour,
  runZendeskHealthCheck,
  shouldRunZendeskHealthCheck
} from '../workers/zendesk-health/index.js'

const ENV = {
  ZENDESK_SUBDOMAIN: 'socialloop',
  ZENDESK_EMAIL: 'integration@example.com',
  ZENDESK_API_TOKEN: 'token-value',
  ZENDESK_SYNC_SECRET: 'sync-secret',
  SUPABASE_URL: 'https://example.supabase.co/',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key'
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

test('environment validation produces normalized server-side settings', () => {
  const environment = getZendeskEnvironment(ENV)

  assert.equal(environment.baseUrl, 'https://socialloop.zendesk.com')
  assert.equal(environment.supabaseUrl, 'https://example.supabase.co')
  assert.equal(environment.syncSecret, 'sync-secret')
  assert.throws(
    () => getZendeskEnvironment({ ...ENV, ZENDESK_SUBDOMAIN: 'https://bad' }),
    /subdomain value/
  )
})

test('Zendesk URL and authentication helpers use the official token format', () => {
  const environment = getZendeskEnvironment(ENV)
  const url = buildZendeskUrl(
    environment,
    '/api/v2/incremental/tickets/cursor.json',
    { start_time: 123, include: 'metric_sets' }
  )
  const encoded = createZendeskAuthorization(
    environment.email,
    environment.apiToken
  ).replace('Basic ', '')

  assert.equal(
    url,
    'https://socialloop.zendesk.com/api/v2/incremental/tickets/cursor.json?start_time=123&include=metric_sets'
  )
  assert.equal(
    Buffer.from(encoded, 'base64').toString('utf8'),
    'integration@example.com/token:token-value'
  )
})

test('constant-time secret comparison accepts only the configured secret', async () => {
  assert.equal(await secretsMatch('sync-secret', 'sync-secret'), true)
  assert.equal(await secretsMatch('wrong-secret', 'sync-secret'), false)
  assert.equal(await secretsMatch(null, 'sync-secret'), false)
})

test('connection readiness returns only sanitized access summaries', async () => {
  const environment = getZendeskEnvironment(ENV)
  const requests = []
  const fetchImpl = async url => {
    requests.push(url)

    if (url.includes('/users/me.json')) {
      return jsonResponse({ user: { id: 1, email: 'private@example.com', role: 'admin' } })
    }

    if (url.includes('/incremental/tickets/cursor.json')) {
      return jsonResponse({
        tickets: [{ id: 99, subject: 'private subject' }],
        metric_sets: [{ ticket_id: 99 }],
        end_of_stream: true
      })
    }

    if (url.includes('/tickets/99/audits.json')) {
      return jsonResponse({ audits: [{ id: 10 }] })
    }

    if (url.includes('/incremental/ticket_metric_events.json')) {
      return jsonResponse({ ticket_metric_events: [{ id: 20 }] })
    }

    if (url.includes('/satisfaction_ratings.json')) {
      return jsonResponse({ satisfaction_ratings: [{ id: 30 }] })
    }

    return jsonResponse({}, 404)
  }
  const result = await testZendeskConnection(environment, {
    fetchImpl,
    now: Date.UTC(2026, 5, 27, 12, 0, 0)
  })

  assert.equal(result.authenticatedRole, 'admin')
  assert.equal(result.readyForTicketEventImport, true)
  assert.equal(result.readyForSlaImport, true)
  assert.equal(result.readyForCsatImport, true)
  assert.equal(result.sample.ticketsReturned, 1)
  assert.equal(JSON.stringify(result).includes('private subject'), false)
  assert.equal(JSON.stringify(result).includes('private@example.com'), false)
  assert.equal(requests.length, 5)
})

test('hourly cron runs only during noon in America/New_York', () => {
  const noonDuringDaylightTime = new Date('2026-06-27T16:00:00Z')
  const elevenDuringDaylightTime = new Date('2026-06-27T15:00:00Z')
  const noonDuringStandardTime = new Date('2026-12-27T17:00:00Z')

  assert.equal(getEasternHour(noonDuringDaylightTime), 12)
  assert.equal(shouldRunZendeskHealthCheck(noonDuringDaylightTime), true)
  assert.equal(shouldRunZendeskHealthCheck(elevenDuringDaylightTime), false)
  assert.equal(shouldRunZendeskHealthCheck(noonDuringStandardTime), true)
})

test('cron health request uses a bearer secret without exposing it in output', async () => {
  let requestOptions
  const payload = await runZendeskHealthCheck(
    {
      PAGES_BASE_URL: 'https://support.example.com',
      ZENDESK_SYNC_SECRET: 'worker-secret'
    },
    async (url, options) => {
      assert.equal(url, 'https://support.example.com/api/zendesk-test')
      requestOptions = options
      return jsonResponse({
        success: true,
        checkedAt: '2026-06-27T16:00:00.000Z',
        supabaseConnected: true,
        readyForTicketEventImport: true,
        readyForSlaImport: true,
        readyForCsatImport: false
      })
    }
  )

  assert.equal(requestOptions.method, 'POST')
  assert.equal(requestOptions.headers.Authorization, 'Bearer worker-secret')
  assert.equal(payload.success, true)
})
