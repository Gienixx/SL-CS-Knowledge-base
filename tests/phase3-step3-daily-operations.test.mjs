import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  onRequestPost
} from '../functions/api/refresh-operations-metrics.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

function read(path) {
  return readFileSync(new URL(path, `file://${ROOT}/`), 'utf8')
}

const ENV = {
  ZENDESK_SUBDOMAIN: 'socialloop',
  ZENDESK_EMAIL: 'integration@example.com',
  ZENDESK_API_TOKEN: 'test-token',
  ZENDESK_SYNC_SECRET: 'test-sync-secret',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role',
  OPERATIONS_TIME_ZONE: 'America/New_York'
}

test('migration creates the Step 3 table and secure refresh function', () => {
  const migration = read(
    'supabase/migrations/20260701_phase3_step3_daily_operations_metrics.sql'
  )

  for (const requiredText of [
    'create table if not exists public.daily_operations_metrics',
    'tickets_created bigint',
    'tickets_solved bigint',
    'backlog_open bigint',
    'backlog_over_24h bigint',
    'backlog_over_48h bigint',
    'first_response_minutes numeric',
    'resolution_minutes numeric',
    'sla_breaches bigint',
    'reopened_tickets bigint',
    'csat_score numeric',
    'refresh_daily_operations_metrics',
    'alter table public.daily_operations_metrics enable row level security',
    'grant execute',
    'to service_role'
  ]) {
    assert.equal(migration.includes(requiredText), true, requiredText)
  }

  assert.equal(
    migration.includes('null::bigint'),
    true,
    'SLA remains null until a trusted source is added'
  )
  assert.equal(
    migration.includes('null::numeric'),
    true,
    'CSAT remains null until a trusted source is added'
  )
})

test('optimization migration uses one materialized state-interval pass', () => {
  const migration = read(
    'supabase/migrations/20260701_phase3_step3_optimize_daily_operations_refresh.sql'
  )

  for (const requiredText of [
    'create or replace function public.refresh_daily_operations_metrics',
    'state_events as materialized',
    'state_intervals as materialized',
    'lead(state.event_timestamp) over',
    'backlog_daily as',
    'current_state as materialized',
    'using materialized ticket-state intervals'
  ]) {
    assert.equal(migration.includes(requiredText), true, requiredText)
  }

  assert.equal(
    migration.includes('select lifecycle.is_terminal'),
    false,
    'the repeated per-ticket correlated lifecycle lookup must not return'
  )
})

test('full refresh endpoint calls the Supabase RPC with null date bounds', async () => {
  const originalFetch = globalThis.fetch
  let capturedUrl
  let capturedOptions

  globalThis.fetch = async (url, options) => {
    capturedUrl = url
    capturedOptions = options

    return new Response(JSON.stringify([{
      refresh_start_date: '2026-06-22',
      refresh_end_date: '2026-06-30',
      rows_upserted: 9
    }]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  try {
    const response = await onRequestPost({
      env: ENV,
      request: new Request(
        'https://support.example.com/api/refresh-operations-metrics',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer test-sync-secret',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ full: true })
        }
      )
    })
    const payload = await response.json()
    const rpcBody = JSON.parse(capturedOptions.body)

    assert.equal(response.status, 200)
    assert.equal(payload.success, true)
    assert.equal(payload.mode, 'full')
    assert.equal(payload.rowsUpserted, 9)
    assert.equal(
      capturedUrl,
      'https://example.supabase.co/rest/v1/rpc/refresh_daily_operations_metrics'
    )
    assert.equal(rpcBody.p_start_date, null)
    assert.equal(rpcBody.p_end_date, null)
    assert.equal(rpcBody.p_time_zone, 'America/New_York')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('authenticated refresh errors expose bounded upstream diagnostics', async () => {
  const originalFetch = globalThis.fetch

  globalThis.fetch = async () => new Response(JSON.stringify({
    message: 'canceling statement due to statement timeout'
  }), {
    status: 500,
    headers: { 'Content-Type': 'application/json' }
  })

  try {
    const response = await onRequestPost({
      env: ENV,
      request: new Request(
        'https://support.example.com/api/refresh-operations-metrics',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer test-sync-secret',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ full: true })
        }
      )
    })
    const payload = await response.json()

    assert.equal(response.status, 500)
    assert.equal(payload.code, 'operations_metrics_refresh_failed')
    assert.equal(payload.diagnostic.upstreamStatus, 500)
    assert.match(payload.diagnostic.details, /statement timeout/)
    assert.ok(payload.diagnostic.details.length <= 500)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('refresh endpoint rejects unauthorized requests', async () => {
  const response = await onRequestPost({
    env: ENV,
    request: new Request(
      'https://support.example.com/api/refresh-operations-metrics',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer wrong-secret',
          'Content-Type': 'application/json'
        },
        body: '{}'
      }
    )
  })
  const payload = await response.json()

  assert.equal(response.status, 401)
  assert.equal(payload.code, 'unauthorized')
})
