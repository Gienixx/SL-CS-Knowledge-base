import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  buildTicketDimensionProfile,
  buildTicketDimensionProfiles,
  getZendeskTicketFieldMap,
  normalizeDimensionKey
} from '../functions/_shared/zendesk-ticket-profile.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

function read(path) {
  return readFileSync(new URL(path, `file://${ROOT}/`), 'utf8')
}

const environment = {
  ZENDESK_APP_FIELD_ID: '101',
  ZENDESK_PLATFORM_FIELD_ID: '102',
  ZENDESK_COUNTRY_FIELD_ID: '103',
  ZENDESK_DRIVER_FIELD_ID: '104'
}

test('dimension keys are normalized for URLs and database filters', () => {
  assert.equal(normalizeDimensionKey('Survey Pop App'), 'survey_pop_app')
  assert.equal(normalizeDimensionKey(' Cashout & PayPal '), 'cashout_and_paypal')
})

test('ticket custom-field identifiers are read from environment values', () => {
  assert.deepEqual(getZendeskTicketFieldMap(environment), {
    app_key: 101,
    platform_key: 102,
    country_key: 103,
    driver_key: 104
  })
})

test('invalid custom-field identifiers are ignored safely', () => {
  assert.deepEqual(getZendeskTicketFieldMap({
    ZENDESK_APP_FIELD_ID: 'not-an-id'
  }), {
    app_key: null,
    platform_key: null,
    country_key: null,
    driver_key: null
  })
})

test('ticket snapshots normalize all supported profile dimensions', () => {
  const profile = buildTicketDimensionProfile({
    id: 7001,
    assignee_id: 88,
    priority: 'High',
    via: { channel: 'Web Widget' },
    updated_at: '2026-07-01T10:00:00Z',
    custom_fields: [
      { id: 101, value: 'SurveyPop' },
      { id: 102, value: 'iPhone' },
      { id: 103, value: 'United States' },
      { id: 104, value: 'Cashout Issues' }
    ]
  }, environment)

  assert.equal(profile.ticket_id, 7001)
  assert.equal(profile.agent_key, 'zendesk:88')
  assert.equal(profile.app_key, 'survey_pop')
  assert.equal(profile.platform_key, 'ios')
  assert.equal(profile.country_key, 'us')
  assert.equal(profile.driver_key, 'cashout_issues')
  assert.equal(profile.priority, 'high')
  assert.equal(profile.channel, 'web_widget')
})

test('unconfigured custom fields do not erase core ticket dimensions', () => {
  const profile = buildTicketDimensionProfile({
    id: 7002,
    assignee_id: 91,
    priority: 'Normal',
    via: { channel: 'email' },
    created_at: '2026-07-01T10:00:00Z'
  })

  assert.equal(profile.agent_key, 'zendesk:91')
  assert.equal(profile.priority, 'normal')
  assert.equal(profile.channel, 'email')
  assert.equal(profile.app_key, null)
})

test('profile batches deduplicate repeated ticket snapshots', () => {
  const profiles = buildTicketDimensionProfiles([
    { id: 10, priority: 'low' },
    { id: 10, priority: 'urgent' },
    { id: null }
  ])

  assert.equal(profiles.length, 1)
  assert.equal(profiles[0].priority, 'urgent')
})

test('migration creates the ticket profile table and indexes', () => {
  const sql = read(
    'supabase/migrations/20260701_phase3_step4_global_dashboard_filters.sql'
  )

  assert.equal(sql.includes('create table if not exists public.ticket_dimension_profiles'), true)
  assert.equal(sql.includes('ticket_dimension_profiles_country_idx'), true)
  assert.equal(sql.includes('ticket_dimension_profiles_channel_idx'), true)
})

test('migration exposes one server-filtered dashboard function', () => {
  const sql = read(
    'supabase/migrations/20260701_phase3_step4_global_dashboard_filters.sql'
  )

  assert.equal(sql.includes('get_dashboard_filtered_data'), true)
  assert.equal(sql.includes('returns jsonb'), true)
  assert.equal(sql.includes('p_start_date date'), true)
  assert.equal(sql.includes('p_channel text'), true)
})

test('dashboard RPC enforces bounded date ranges', () => {
  const sql = read(
    'supabase/migrations/20260701_phase3_step4_global_dashboard_filters.sql'
  )

  assert.equal(sql.includes('dashboard_filter_date_range_invalid'), true)
  assert.equal(sql.includes('dashboard_filter_date_range_too_large'), true)
  assert.equal(sql.includes('> 366'), true)
})

test('profile upsert preserves non-null historical dimensions', () => {
  const sql = read(
    'supabase/migrations/20260701_phase3_step4_global_dashboard_filters.sql'
  )

  assert.equal(sql.includes('upsert_ticket_dimension_profiles'), true)
  assert.equal(
    sql.includes('coalesce(\n      excluded.app_key,\n      public.ticket_dimension_profiles.app_key'),
    true
  )
})

test('migration creates a separate ticket-profile cursor', () => {
  const sql = read(
    'supabase/migrations/20260701_phase3_step4_global_dashboard_filters.sql'
  )

  assert.equal(sql.includes("values ('ticket_profiles')"), true)
})

test('historical profile backfill is protected and cursor based', () => {
  const endpoint = read('functions/api/backfill-zendesk-ticket-profiles.js')

  assert.equal(endpoint.includes('getBearerToken'), true)
  assert.equal(endpoint.includes('secretsMatch'), true)
  assert.equal(endpoint.includes('/incremental/tickets/cursor.json'), true)
  assert.equal(endpoint.includes("STREAM_KEY = 'ticket_profiles'"), true)
})

test('normal ticket synchronization maintains dimension profiles', () => {
  const endpoint = read('functions/api/sync-zendesk.js')

  assert.equal(endpoint.includes('buildTicketDimensionProfiles'), true)
  assert.equal(endpoint.includes('upsertTicketDimensionProfiles'), true)
  assert.equal(endpoint.includes('profilesUpserted'), true)
})

test('browser filtering uses a Supabase RPC rather than downloading events', () => {
  const frontend = read('scripts/dashboard-global-filters.js')

  assert.equal(frontend.includes(".rpc(\n    'get_dashboard_filtered_data'"), true)
  assert.equal(frontend.includes(".from('ticket_events')"), false)
  assert.equal(frontend.includes('dashboard:filters-changed'), true)
})

test('filter state supports every Phase 3 Step 4 URL dimension', () => {
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
    assert.equal(frontend.includes(`'${key}'`), true)
  }

  assert.equal(frontend.includes("params.set('range'"), true)
  assert.equal(frontend.includes("state.range === 'custom'"), true)
})
