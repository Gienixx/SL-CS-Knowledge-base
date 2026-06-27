import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildAuditEvents,
  buildTicketEvents,
  deduplicateTicketEvents,
  findMetricSet
} from '../functions/_shared/zendesk-event-normalizer.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

function read(relativePath) {
  const absolutePath = join(ROOT, relativePath)
  assert.ok(existsSync(absolutePath), `${relativePath} must exist`)
  return readFileSync(absolutePath, 'utf8')
}

const ticket = {
  id: 7001,
  created_at: '2026-06-27T10:00:00Z',
  status: 'open',
  priority: 'high',
  assignee_id: 91,
  group_id: 12,
  via: { channel: 'email' }
}

test('ticket records create stable created and first-response events', () => {
  const events = buildTicketEvents(ticket, {
    id: 300,
    ticket_id: 7001,
    reply_time_in_minutes: {
      calendar: 15,
      business: 10
    }
  })

  assert.equal(events.length, 2)
  assert.equal(events[0].event_type, 'created')
  assert.equal(events[0].source_event_id, 'zendesk:ticket:7001:created')
  assert.equal(events[0].channel, 'email')
  assert.equal(events[1].event_type, 'first_response')
  assert.equal(
    events[1].event_timestamp,
    '2026-06-27T10:15:00.000Z'
  )
  assert.equal(events[1].metadata.business_minutes, 10)
})

test('ticket audits normalize assignment, priority, and lifecycle changes', () => {
  const events = buildAuditEvents(ticket, [
    {
      id: 800,
      created_at: '2026-06-27T11:00:00Z',
      author_id: 88,
      events: [
        {
          id: 801,
          type: 'Change',
          field_name: 'status',
          previous_value: 'solved',
          value: 'open'
        },
        {
          id: 802,
          type: 'Change',
          field_name: 'assignee_id',
          previous_value: 91,
          value: 92
        },
        {
          id: 803,
          type: 'Change',
          field_name: 'priority',
          previous_value: 'normal',
          value: 'urgent'
        },
        {
          id: 804,
          type: 'Change',
          field_name: 'status',
          previous_value: 'open',
          value: 'solved'
        },
        {
          id: 805,
          type: 'Change',
          field_name: 'status',
          previous_value: 'solved',
          value: 'closed'
        }
      ]
    }
  ])

  assert.deepEqual(
    events.map(event => event.event_type),
    ['reopened', 'assigned', 'priority_changed', 'solved', 'closed']
  )
  assert.equal(events[1].agent_key, 'zendesk:92')
  assert.equal(events[2].priority, 'urgent')
  assert.equal(events[0].metadata.previous_status, 'solved')
})

test('event keys deduplicate retries and metric sets match by ticket id', () => {
  const events = buildTicketEvents(ticket)
  const duplicateInput = [...events, ...events]

  assert.equal(deduplicateTicketEvents(duplicateInput).length, 1)
  assert.equal(
    findMetricSet([{ ticket_id: 7001, id: 3 }], 7001).id,
    3
  )
})

test('database migration creates protected normalized storage and sync state', () => {
  const migration = read(
    'supabase/migrations/20260627_phase3_step2_ticket_event_storage.sql'
  )

  for (const requiredText of [
    'create table if not exists public.ticket_events',
    'ticket_id bigint not null',
    'source_event_id text not null unique',
    'event_timestamp timestamptz not null',
    'agent_key text',
    'ticket_status text',
    'priority text',
    'channel text',
    'app_key text',
    'platform_key text',
    'country_key text',
    'driver_key text',
    'create table if not exists public.zendesk_sync_state',
    'create table if not exists public.zendesk_sync_runs',
    'acquire_zendesk_sync_lock',
    'advance_zendesk_sync_state',
    'enable row level security',
    'grant select',
    'to authenticated',
    'to service_role'
  ]) {
    assert.ok(
      migration.includes(requiredText),
      `migration must contain ${JSON.stringify(requiredText)}`
    )
  }
})

test('sync endpoint is protected, cursor-based, bounded, and idempotent', () => {
  const endpoint = read('functions/api/sync-zendesk.js')
  const store = read('functions/_shared/zendesk-sync-store.js')

  for (const requiredText of [
    'getBearerToken',
    'secretsMatch',
    'acquireZendeskSyncLock',
    "'/api/v2/incremental/tickets/cursor.json'",
    'DEFAULT_PAGE_SIZE = 25',
    'MAX_PAGE_SIZE = 50',
    'advanceZendeskSyncState',
    'endOfStream',
    'hasMore'
  ]) {
    assert.ok(
      endpoint.includes(requiredText),
      `sync endpoint must contain ${JSON.stringify(requiredText)}`
    )
  }

  assert.ok(store.includes('on_conflict=source_event_id'))
  assert.ok(store.includes('resolution=ignore-duplicates'))
  assert.ok(store.includes('return=representation'))
})
