import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

function read(path) {
  return readFileSync(new URL(path, `file://${ROOT}/`), 'utf8')
}

test('global filter migration exposes one authenticated aggregate RPC', () => {
  const sql = read(
    'supabase/migrations/20260701_phase3_step4_global_filter_rpc.sql'
  )

  for (const requiredText of [
    'create or replace function public.get_dashboard_filtered_data',
    'returns jsonb',
    'p_start_date date',
    'p_end_date date',
    'p_app_key text',
    'p_platform_key text',
    'p_country_key text',
    'p_driver_key text',
    'p_agent_key text',
    'p_priority text',
    'p_channel text',
    'to authenticated, service_role'
  ]) {
    assert.equal(sql.includes(requiredText), true, requiredText)
  }
})

test('RPC combines ticket profiles with event-derived operational dimensions', () => {
  const sql = read(
    'supabase/migrations/20260701_phase3_step4_global_filter_rpc.sql'
  )

  assert.equal(sql.includes('public.ticket_dimension_profiles'), true)
  assert.equal(sql.includes('event_dimensions as materialized'), true)
  assert.equal(sql.includes('event.agent_key'), true)
  assert.equal(sql.includes('event.priority'), true)
  assert.equal(sql.includes('event.channel'), true)
})

test('RPC applies filters in the database and limits date ranges', () => {
  const sql = read(
    'supabase/migrations/20260701_phase3_step4_global_filter_rpc.sql'
  )

  assert.equal(sql.includes('selected_tickets as materialized'), true)
  assert.equal(sql.includes('dashboard_filter_date_range_invalid'), true)
  assert.equal(sql.includes('dashboard_filter_date_range_too_large'), true)
  assert.equal(sql.includes('> 366'), true)
})

test('RPC returns summary, trend, breakdown, agent, and option payloads', () => {
  const sql = read(
    'supabase/migrations/20260701_phase3_step4_global_filter_rpc.sql'
  )

  for (const requiredText of [
    "'summary'",
    "'trend'",
    "'breakdowns'",
    "'agents'",
    "'options'",
    "'backlog_open'",
    "'reopened_tickets'"
  ]) {
    assert.equal(sql.includes(requiredText), true, requiredText)
  }
})

test('browser filtering uses the aggregate RPC instead of reading raw events', () => {
  const frontend = read('scripts/dashboard-global-filters.js')

  assert.equal(
    frontend.includes(".rpc(\n    'get_dashboard_filtered_data'"),
    true
  )
  assert.equal(frontend.includes(".from('ticket_events')"), false)
  assert.equal(frontend.includes(".from('ticket_dimension_profiles')"), false)
})

test('filter state supports every Step 4 URL dimension', () => {
  const frontend = read('scripts/dashboard-global-filters.js')

  for (const key of [
    'app',
    'platform',
    'country',
    'driver',
    'agent',
    'priority',
    'channel'
  ]) {
    assert.equal(frontend.includes(`'${key}'`), true, key)
  }

  assert.equal(frontend.includes("params.set('range'"), true)
  assert.equal(frontend.includes("state.range === 'custom'"), true)
  assert.equal(frontend.includes('dashboard:filters-changed'), true)
})

test('dashboard loads the global filter stylesheet and module', () => {
  const dashboard = read('dashboard.html')

  assert.equal(
    dashboard.includes('./dashboard-global-filters.css?v=1'),
    true
  )
  assert.equal(
    dashboard.includes('./scripts/dashboard-global-filters.js?v=1'),
    true
  )
})

test('verification checks the existing dimension profile security boundary', () => {
  const sql = read(
    'supabase/verification/phase3_step4_global_filters_check.sql'
  )

  assert.equal(sql.includes('server_only_profile_table'), true)
  assert.equal(sql.includes('authenticated_filter_rpc'), true)
  assert.equal(sql.includes("stream_key = 'ticket_dimensions_backfill'"), true)
})
