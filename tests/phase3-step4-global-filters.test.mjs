import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const read = path => readFileSync(new URL(path, `file://${ROOT}/`), 'utf8')

test('global filter migration exposes the authenticated aggregate RPC', () => {
  const sql = read('supabase/migrations/20260701_phase3_step4_global_filter_rpc.sql')

  for (const value of [
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
    assert.ok(sql.includes(value), value)
  }
})

test('RPC uses ticket profiles and event-derived dimensions', () => {
  const sql = read('supabase/migrations/20260701_phase3_step4_global_filter_rpc.sql')

  for (const value of [
    'public.ticket_dimension_profiles',
    'event_dimensions as materialized',
    'selected_tickets as materialized',
    'dashboard_filter_date_range_invalid',
    'dashboard_filter_date_range_too_large',
    "'summary'",
    "'trend'",
    "'breakdowns'",
    "'agents'",
    "'options'"
  ]) {
    assert.ok(sql.includes(value), value)
  }
})

test('detail-page filtering uses the aggregate RPC and all supported dimensions', () => {
  const source = read('scripts/report-details.js')

  assert.ok(source.includes('get_dashboard_filtered_data'))
  assert.ok(source.includes('FILTER_KEYS'))
  assert.ok(source.includes('selectSource'))
  assert.ok(source.includes('google_sheet'))
  assert.ok(source.includes('zendesk'))
  assert.equal(source.includes(".from('ticket_events')"), false)
  assert.equal(source.includes(".from('ticket_dimension_profiles')"), false)

  for (const key of ['app', 'platform', 'country', 'driver', 'agent', 'priority', 'channel']) {
    assert.ok(source.includes(`'${key}'`), key)
  }
})

test('filters live on the reusable report page instead of the overview', () => {
  const dashboard = read('dashboard.html')
  const detail = read('report-details.html')

  assert.equal(dashboard.includes('dashboard-global-filters.js'), false)
  assert.equal(dashboard.includes('dashboard-global-filters.css'), false)

  for (const value of [
    'id="reportFilterForm"',
    'name="range"',
    'name="app"',
    'name="platform"',
    'name="country"',
    'name="driver"',
    'name="agent"',
    'name="priority"',
    'name="channel"'
  ]) {
    assert.ok(detail.includes(value), value)
  }
})

test('Concern compatibility retains the public Concern wording', () => {
  const source = read('scripts/dashboard-concern-compat.js')

  for (const value of [
    "searchParams.get('concern')",
    "searchParams.set('driver', concern)",
    "searchParams.set('concern', driver)",
    "setTextIfChanged(caption, 'Concern')",
    "setTextIfChanged(allOption, 'All concerns')"
  ]) {
    assert.ok(source.includes(value), value)
  }
})

test('verification preserves the ticket profile security boundary', () => {
  const sql = read('supabase/verification/phase3_step4_global_filters_check.sql')

  assert.ok(sql.includes('server_only_profile_table'))
  assert.ok(sql.includes('authenticated_filter_rpc'))
  assert.ok(sql.includes("stream_key = 'ticket_dimensions_backfill'"))
})
