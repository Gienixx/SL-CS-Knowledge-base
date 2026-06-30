import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  normalizeIncrementalTicketEvent,
  normalizeIncrementalTicketEvents
} from '../functions/_shared/zendesk-incremental-event-normalizer.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

function read(path) {
  return readFileSync(new URL(path, `file://${ROOT}/`), 'utf8')
}

test('observed Zendesk child event shape normalizes lifecycle changes', () => {
  const events = normalizeIncrementalTicketEvent({
    id: 900,
    ticket_id: 7001,
    timestamp: '2026-06-30T09:00:00Z',
    updater_id: 88,
    via: { channel: 'web' },
    child_events: [
      {
        id: 901,
        event_type: 'Change',
        previous_value: 'solved',
        status: 'open'
      },
      {
        id: 902,
        event_type: 'Change',
        previous_value: 91,
        assignee_id: 92
      },
      {
        id: 903,
        event_type: 'Change',
        previous_value: 'normal',
        priority: 'urgent'
      },
      {
        id: 904,
        event_type: 'Comment',
        comment_present: true
      }
    ]
  })

  assert.deepEqual(
    events.map(event => event.event_type),
    ['reopened', 'assigned', 'priority_changed']
  )
  assert.equal(
    events[0].source_event_id,
    'zendesk:ticket_event:900:event:901'
  )
  assert.equal(events[0].ticket_status, 'open')
  assert.equal(events[0].channel, 'web')
  assert.equal(events[1].agent_key, 'zendesk:92')
  assert.equal(events[2].priority, 'urgent')
})

test('legacy field_name and value event shape remains supported', () => {
  const events = normalizeIncrementalTicketEvent({
    id: 905,
    ticket_id: 7001,
    timestamp: '2026-06-30T09:01:00Z',
    child_events: [
      {
        id: 906,
        type: 'Change',
        field_name: 'status',
        previous_value: 'open',
        value: 'solved'
      }
    ]
  })

  assert.equal(events.length, 1)
  assert.equal(events[0].event_type, 'solved')
  assert.equal(events[0].ticket_status, 'solved')
})

test('incremental event normalization deduplicates source identifiers', () => {
  const source = {
    id: 910,
    ticket_id: 7002,
    timestamp: 1782810000,
    child_events: [
      {
        id: 911,
        event_type: 'Change',
        previous_value: 'open',
        status: 'solved'
      }
    ]
  }

  const events = normalizeIncrementalTicketEvents([source, source])

  assert.equal(events.length, 1)
  assert.equal(events[0].event_type, 'solved')
})

test('ticket snapshot endpoint no longer fetches per-ticket audits', () => {
  const endpoint = read('functions/api/sync-zendesk.js')

  assert.equal(endpoint.includes('/audits.json'), false)
  assert.equal(endpoint.includes('fetchTicketAudits'), false)
  assert.equal(endpoint.includes('/incremental/tickets/cursor.json'), true)
})

test('event endpoint uses a bounded incremental export page', () => {
  const endpoint = read('functions/api/sync-zendesk-events.js')

  assert.equal(
    endpoint.includes('/api/v2/incremental/ticket_events.json'),
    true
  )
  assert.equal(endpoint.includes('ZENDESK_EVENT_PAGE_SIZE'), true)
  assert.equal(endpoint.includes('Math.min(configured, 250)'), true)
  assert.equal(endpoint.includes('start_time: startTime'), true)
  assert.equal(endpoint.includes('end_of_stream'), true)
})
