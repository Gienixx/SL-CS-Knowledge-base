import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getEasternHour,
  runZendeskScheduledSync,
  shouldRunZendeskSync
} from '../workers/zendesk-health/index.js'

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

test('hourly cron runs only at 9 AM in America/New_York', () => {
  const nineDuringDaylightTime = new Date('2026-06-27T13:00:00Z')
  const eightDuringDaylightTime = new Date('2026-06-27T12:00:00Z')
  const nineDuringStandardTime = new Date('2026-12-27T14:00:00Z')

  assert.equal(getEasternHour(nineDuringDaylightTime), 9)
  assert.equal(shouldRunZendeskSync(nineDuringDaylightTime), true)
  assert.equal(shouldRunZendeskSync(eightDuringDaylightTime), false)
  assert.equal(shouldRunZendeskSync(nineDuringStandardTime), true)
})

test('scheduled sync paginates both streams then refreshes daily metrics', async () => {
  const calls = []
  const pagesByPath = {
    '/api/sync-zendesk': [
      {
        success: true,
        stream: 'tickets',
        ticketsProcessed: 5,
        eventsSeen: 8,
        eventsImported: 6,
        duplicateEvents: 2,
        endOfStream: false,
        hasMore: true
      },
      {
        success: true,
        stream: 'tickets',
        ticketsProcessed: 2,
        eventsSeen: 3,
        eventsImported: 3,
        duplicateEvents: 0,
        endOfStream: true,
        hasMore: false
      }
    ],
    '/api/sync-zendesk-events': [
      {
        success: true,
        stream: 'ticket_events',
        sourceEventsProcessed: 10,
        eventsSeen: 7,
        eventsImported: 7,
        duplicateEvents: 0,
        endOfStream: false,
        hasMore: true
      },
      {
        success: true,
        stream: 'ticket_events',
        sourceEventsProcessed: 4,
        eventsSeen: 3,
        eventsImported: 2,
        duplicateEvents: 1,
        endOfStream: true,
        hasMore: false
      }
    ],
    '/api/refresh-operations-metrics': [
      {
        success: true,
        mode: 'rolling',
        timeZone: 'America/New_York',
        startDate: '2026-05-31',
        endDate: '2026-06-30',
        rowsUpserted: 31
      }
    ]
  }

  const summary = await runZendeskScheduledSync(
    {
      PAGES_BASE_URL: 'https://support.example.com',
      ZENDESK_SYNC_SECRET: 'worker-test-secret'
    },
    {
      fetchImpl: async (url, options) => {
        const parsedUrl = new URL(url)
        calls.push({
          path: parsedUrl.pathname,
          options
        })

        return jsonResponse(pagesByPath[parsedUrl.pathname].shift())
      },
      sleepImpl: async () => {},
      nowImpl: () => Date.UTC(2026, 5, 30, 13, 0, 0),
      requestDelayMs: 0,
      maxRequests: 10
    }
  )

  assert.deepEqual(
    calls.map(call => call.path),
    [
      '/api/sync-zendesk',
      '/api/sync-zendesk-events',
      '/api/sync-zendesk',
      '/api/sync-zendesk-events',
      '/api/refresh-operations-metrics'
    ]
  )

  for (const call of calls) {
    assert.equal(call.options.method, 'POST')
    assert.equal(
      call.options.headers.Authorization,
      'Bearer worker-test-secret'
    )
    assert.equal(call.options.headers['X-Sync-Source'], 'scheduled')
  }

  assert.equal(calls[0].options.body, '{}')
  assert.equal(calls[4].options.body, JSON.stringify({ full: false }))
  assert.equal(summary.complete, true)
  assert.equal(summary.requests, 4)
  assert.equal(summary.metricsRefresh.rowsUpserted, 31)
  assert.deepEqual(
    summary.streams.map(stream => ({
      name: stream.name,
      complete: stream.complete,
      pages: stream.pages,
      eventsImported: stream.eventsImported
    })),
    [
      {
        name: 'tickets',
        complete: true,
        pages: 2,
        eventsImported: 9
      },
      {
        name: 'ticket_events',
        complete: true,
        pages: 2,
        eventsImported: 9
      }
    ]
  )
})

test('partial sync does not refresh daily metrics', async () => {
  const calls = []
  const summary = await runZendeskScheduledSync(
    {
      PAGES_BASE_URL: 'https://support.example.com',
      ZENDESK_SYNC_SECRET: 'worker-test-secret'
    },
    {
      fetchImpl: async url => {
        calls.push(new URL(url).pathname)
        return jsonResponse({
          success: true,
          eventsSeen: 1,
          eventsImported: 1,
          duplicateEvents: 0,
          endOfStream: false,
          hasMore: true
        })
      },
      sleepImpl: async () => {},
      nowImpl: () => Date.UTC(2026, 5, 30, 13, 0, 0),
      requestDelayMs: 0,
      maxRequests: 2
    }
  )

  assert.equal(summary.complete, false)
  assert.equal(summary.requests, 2)
  assert.equal(summary.metricsRefresh, null)
  assert.equal(
    calls.includes('/api/refresh-operations-metrics'),
    false
  )
})
