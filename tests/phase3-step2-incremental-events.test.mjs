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

test('incremental ticket changes normalize without ticket audit requests', () => {
  const events = normalizeIncrementalTicketEvent({
    id: 900,
    ticket_id: 7001,
    timestamp: '2026-06-30T09:00:00Z',
    updater_id: 88,
    child_events: [
      {
        id: 901,
        audit_id: 800,
        type: 'Change',
        field_name: 'status',
        previous_value: 'solved',
        value: 'open'
      },
      {
        id: 902,
        audit_id: 800,
        type: 'Change',
        field_name: 'assignee_id',
        previous_value: 91,
        value: 92
      },
      {
        id: 903,
        audit_id: 800,
        type: 'Change',
        field_name: 'priority',
        previous_value: 'normal',
        value: 'urgent'
      }
    ]
  })

  assert.deepEqual(
    events.map(event => event.event_type),
    ['reopened', 'assigned', 'priority_changed']
  )
  assert.equal(events[0].source_event_id, 'zendesk:audit:800:event:901')
  assert.equal(events[1].agent_key, 'zendesk:92')
  assert.equal(events[2].priority, 'urgent')
})

test('incremental event normalization deduplicates source identifiers', () => {
  const source = {
    id: 910,
    ticket_id: 7002,
    timestamp: 1782810000,
    child_events: [
      {
        id: 911,
        type: 'Change',
        field_name: 'status',
        previous_value: 'open',
        value: 'solved'
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
