import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildZendeskUrl,
  createZendeskAuthorization,
  secretsMatch,
  testZendeskConnection
} from '../functions/_shared/zendesk-client.js'

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

const environment = {
  baseUrl: 'https://socialloop.zendesk.com',
  email: 'integration@example.com',
  apiToken: 'test-value'
}

test('Zendesk URL and token helpers use the expected format', () => {
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
    'integration@example.com/token:test-value'
  )
})

test('constant-time value comparison accepts exact matches only', async () => {
  assert.equal(await secretsMatch('matching-value', 'matching-value'), true)
  assert.equal(await secretsMatch('different-value', 'matching-value'), false)
  assert.equal(await secretsMatch(null, 'matching-value'), false)
})

test('readiness output excludes ticket content and user email', async () => {
  const requests = []
  const fetchImpl = async url => {
    requests.push(url)

    if (url.includes('/users/me.json')) {
      return jsonResponse({
        user: { id: 1, email: 'private@example.com', role: 'admin' }
      })
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
  assert.equal(JSON.stringify(result).includes('private subject'), false)
  assert.equal(JSON.stringify(result).includes('private@example.com'), false)
  assert.equal(requests.length, 5)
})
