import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  normalizeSlaMetricEvent,
  normalizeSlaMetricEvents
} from '../functions/_shared/zendesk-sla-event-normalizer.js'
import {
  isSlaMetricPageComplete
} from '../functions/api/sync-zendesk-sla.js'
import {
  getZendeskSyncStreams,
  isSlaSyncEnabled
} from '../workers/zendesk-health/index.js'

const root = new URL('../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')

test('normalizes only non-deleted Zendesk SLA breach events', () => {
  const event = normalizeSlaMetricEvent({
    id: 4501,
    ticket_id: 9001,
    type: 'breach',
    metric: 'first_reply_time',
    time: '2026-07-01T14:00:00Z',
    business_hours: true,
    deleted: false,
    instance_id: 88,
    sla: { id: 7, title: 'Priority response policy' }
  })

  assert.equal(event.event_type, 'sla_breached')
  assert.equal(event.ticket_id, 9001)
  assert.equal(event.metadata.metric, 'first_reply_time')
  assert.equal(event.metadata.business_hours, true)
  assert.deepEqual(event.metadata.sla, {
    id: '7',
    title: 'Priority response policy'
  })

  assert.equal(normalizeSlaMetricEvent({ ...event, type: 'apply_sla' }), null)
  assert.equal(normalizeSlaMetricEvent({
    ticket_id: 1,
    type: 'breach',
    metric: 'reply',
    time: 1710000000,
    deleted: true
  }), null)
})

test('deduplicates SLA metric events by source event id', () => {
  const source = {
    id: 'same-event',
    ticket_id: 123,
    type: 'breach',
    metric: 'agent_work_time',
    time: 1710000000
  }
  const rows = normalizeSlaMetricEvents([source, source])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].source_event_id, 'zendesk:ticket_metric_event:same-event')
})

test('handles Zendesk metric pages with and without end_of_stream', () => {
  assert.equal(isSlaMetricPageComplete({ end_of_stream: false }, 3), false)
  assert.equal(isSlaMetricPageComplete({ end_of_stream: true }, 100), true)
  assert.equal(isSlaMetricPageComplete({}, 99), true)
  assert.equal(isSlaMetricPageComplete({}, 100), false)
})

test('keeps SLA scheduled ingestion disabled until explicitly activated', () => {
  assert.equal(isSlaSyncEnabled({}), false)
  assert.equal(getZendeskSyncStreams({}).length, 2)
  assert.equal(isSlaSyncEnabled({ ZENDESK_SLA_SYNC_ENABLED: 'true' }), true)
  assert.deepEqual(
    getZendeskSyncStreams({ ZENDESK_SLA_SYNC_ENABLED: 'TRUE' }).map(row => row.name),
    ['tickets', 'ticket_events', 'ticket_metric_events']
  )
})

test('Step 6 migration exposes filtered response and SLA reporting', async () => {
  const [sql, readinessSql] = await Promise.all([
    read('supabase/migrations/2026070201_phase3_step6_sla_response_dashboard.sql'),
    read('supabase/migrations/2026070202_phase3_step6_sla_readiness_gate.sql')
  ])
  assert.match(sql, /create or replace function public\.get_sla_response_dashboard/)
  assert.match(sql, /percentile_cont\(0\.9\)/)
  assert.match(sql, /event_type = 'sla_breached'/)
  assert.match(sql, /last_success_at is not null/)
  assert.match(readinessSql, /zendesk_sla_readiness/)
  assert.match(readinessSql, /advance_zendesk_sla_sync_state/)
  assert.match(readinessSql, /when v_policy_ready then now\(\)/)
  assert.match(sql, /grant execute[\s\S]*to authenticated, service_role/)
  assert.doesNotMatch(sql, /sla_breaches[^\n]*default 0/i)
})

test('Step 6 endpoint and UI preserve the trusted-source boundary', async () => {
  const [endpoint, page, browser, dashboard, packageJson] = await Promise.all([
    read('functions/api/sync-zendesk-sla.js'),
    read('response-times.html'),
    read('scripts/response-times.js'),
    read('dashboard.html'),
    read('package.json')
  ])

  assert.match(endpoint, /incremental\/ticket_metric_events\.json/)
  assert.match(endpoint, /ZENDESK_SLA_INITIAL_START_TIME/)
  assert.match(endpoint, /exclude_deleted: true/)
  assert.match(endpoint, /include_changes: true/)
  assert.match(endpoint, /advanceZendeskSlaSyncState/)
  assert.match(page, /All values on this page use Zendesk ticket events/)
  assert.match(browser, /get_sla_response_dashboard/)
  assert.doesNotMatch(browser, /daily_ticket_metrics|Google Sheet fallback/)
  assert.match(dashboard, /response-times\.html/)
  assert.match(packageJson, /test:phase3-step6/)
})
