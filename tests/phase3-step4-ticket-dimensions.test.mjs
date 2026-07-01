import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  buildTicketDimensionProfile,
  buildTicketDimensionProfiles,
  configuredTicketDimensionFieldCount,
  getZendeskTicketDimensionFieldMap,
  normalizeDimensionKey
} from '../functions/_shared/zendesk-ticket-dimension-normalizer.js'

const root = new URL('../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')

test('reads preferred Zendesk custom-field environment variables', () => {
  const mapping = getZendeskTicketDimensionFieldMap({
    ZENDESK_APP_CUSTOM_FIELD_ID: '101',
    ZENDESK_PLATFORM_CUSTOM_FIELD_ID: 102,
    ZENDESK_COUNTRY_CUSTOM_FIELD_ID: '103',
    ZENDESK_CONCERN_CUSTOM_FIELD_ID: 104
  })

  assert.deepEqual({ ...mapping }, {
    app: 101,
    platform: 102,
    country: 103,
    concern: 104
  })
  assert.equal(mapping.driver, 104)
})

test('accepts shorter concern custom-field aliases', () => {
  const mapping = getZendeskTicketDimensionFieldMap({
    ZENDESK_APP_FIELD_ID: 201,
    ZENDESK_PLATFORM_FIELD_ID: 202,
    ZENDESK_COUNTRY_FIELD_ID: 203,
    ZENDESK_CONCERN_FIELD_ID: 204
  })

  assert.deepEqual({ ...mapping }, {
    app: 201,
    platform: 202,
    country: 203,
    concern: 204
  })
})

test('preferred custom-field names take precedence over aliases', () => {
  const mapping = getZendeskTicketDimensionFieldMap({
    ZENDESK_CONCERN_CUSTOM_FIELD_ID: 301,
    ZENDESK_CONCERN_FIELD_ID: 999
  })
  assert.equal(mapping.concern, 301)
})

test('legacy driver environment variables are not treated as Concerns', () => {
  const mapping = getZendeskTicketDimensionFieldMap({
    ZENDESK_DRIVER_CUSTOM_FIELD_ID: 401
  })

  assert.equal(mapping.concern, null)
  assert.equal(mapping.driver, null)
})

test('invalid custom-field identifiers are ignored', () => {
  const mapping = getZendeskTicketDimensionFieldMap({
    ZENDESK_APP_CUSTOM_FIELD_ID: 'abc',
    ZENDESK_PLATFORM_CUSTOM_FIELD_ID: 0,
    ZENDESK_COUNTRY_CUSTOM_FIELD_ID: -5,
    ZENDESK_CONCERN_CUSTOM_FIELD_ID: 401
  })
  assert.deepEqual({ ...mapping }, {
    app: null,
    platform: null,
    country: null,
    concern: 401
  })
})

test('counts only canonical ticket dimensions', () => {
  const mapping = getZendeskTicketDimensionFieldMap({
    ZENDESK_APP_CUSTOM_FIELD_ID: 1,
    ZENDESK_PLATFORM_CUSTOM_FIELD_ID: 2,
    ZENDESK_COUNTRY_CUSTOM_FIELD_ID: 3,
    ZENDESK_CONCERN_CUSTOM_FIELD_ID: 4
  })

  assert.equal(configuredTicketDimensionFieldCount(mapping), 4)
  assert.equal(Object.keys(mapping).includes('driver'), false)
})

test('normalizes Zendesk option values into stable keys', () => {
  assert.equal(normalizeDimensionKey(' Survey Pop - iOS '), 'survey_pop_ios')
  assert.equal(normalizeDimensionKey('United States (US)'), 'united_states_us')
})

test('uses the first populated multi-select value', () => {
  assert.equal(normalizeDimensionKey(['', null, 'Account Access', 'Other']), 'account_access')
  assert.equal(normalizeDimensionKey([]), null)
})

test('builds app, platform, country, and concern dimensions', () => {
  const profile = buildTicketDimensionProfile({
    id: 987,
    status: 'Open',
    updated_at: '2026-06-30T12:30:00Z',
    custom_fields: [
      { id: 11, value: 'Eureka' },
      { id: 12, value: 'Android' },
      { id: 13, value: 'US' },
      { id: 14, value: 'Cash Out' }
    ]
  }, { app: 11, platform: 12, country: 13, concern: 14 })

  assert.deepEqual({
    ticket_id: profile.ticket_id,
    app_key: profile.app_key,
    platform_key: profile.platform_key,
    country_key: profile.country_key,
    concern_key: profile.concern_key
  }, {
    ticket_id: 987,
    app_key: 'eureka',
    platform_key: 'android',
    country_key: 'us',
    concern_key: 'cash_out'
  })
  assert.equal(profile.profile_version, 'zendesk-custom-fields-v2')
})

test('leaves concern null when the ticket field has no value', () => {
  const profile = buildTicketDimensionProfile({
    id: 989,
    updated_at: '2026-06-30T12:30:00Z',
    custom_fields: [
      { id: 11, value: 'Eureka' },
      { id: 12, value: 'iOS' },
      { id: 13, value: 'GB' }
    ]
  }, { app: 11, platform: 12, country: 13, concern: 14 })

  assert.equal(profile.concern_key, null)
  assert.equal(profile.app_key, 'eureka')
  assert.equal(profile.platform_key, 'ios')
  assert.equal(profile.country_key, 'gb')
})

test('records source metadata without embedding raw ticket contents', () => {
  const profile = buildTicketDimensionProfile({
    id: 988,
    status: 'Pending',
    created_at: '2026-06-29T01:00:00Z',
    custom_fields: [{ id: 21, value: 'SurveyPop' }],
    subject: 'Sensitive ticket subject'
  }, { app: 21 })

  assert.equal(profile.source_record_id, '988')
  assert.equal(profile.source_updated_at, '2026-06-29T01:00:00.000Z')
  assert.equal(profile.metadata.status, 'pending')
  assert.equal(JSON.stringify(profile).includes('Sensitive ticket subject'), false)
})

test('rejects tickets without a positive numeric identifier', () => {
  assert.equal(buildTicketDimensionProfile({ id: 0 }, { app: 1 }), null)
  assert.equal(buildTicketDimensionProfile({ id: 'bad' }, { app: 1 }), null)
})

test('deduplicates ticket profiles and keeps the newest snapshot', () => {
  const profiles = buildTicketDimensionProfiles([
    {
      id: 44,
      updated_at: '2026-06-01T00:00:00Z',
      custom_fields: [{ id: 1, value: 'Old App' }]
    },
    {
      id: 44,
      updated_at: '2026-06-02T00:00:00Z',
      custom_fields: [{ id: 1, value: 'New App' }]
    }
  ], { app: 1 })

  assert.equal(profiles.length, 1)
  assert.equal(profiles[0].app_key, 'new_app')
})

test('backfill endpoint remains bearer-protected and uses an independent stream', async () => {
  const source = await read('functions/api/backfill-zendesk-ticket-dimensions.js')
  assert.match(source, /secretsMatch\(/)
  assert.match(source, /getBearerToken\(context\.request\)/)
  assert.match(source, /ticket_dimensions_backfill/)
  assert.match(source, /WWW-Authenticate/)
})

test('normal Zendesk snapshot sync maintains profiles without modifying event normalization', async () => {
  const source = await read('functions/api/sync-zendesk.js')
  assert.match(source, /buildTicketDimensionProfiles/)
  assert.match(source, /upsertTicketDimensionProfiles/)
  assert.match(source, /dimensionProfilesUpserted/)
  assert.doesNotMatch(source, /update\s+public\.ticket_events/i)
})

test('fresh-install migration uses concern and a read-only driver compatibility alias', async () => {
  const migration = await read(
    'supabase/migrations/20260701_phase3_step4_ticket_dimension_profiles.sql'
  )

  assert.match(migration, /concern_key text/i)
  assert.match(
    migration,
    /driver_key text generated always as \(concern_key\) stored/i
  )
  assert.match(migration, /profile\.concern_key/i)
  assert.match(migration, /enable row level security/i)
  assert.match(migration, /revoke all privileges[\s\S]*from anon, authenticated/i)
  assert.match(migration, /grant execute[\s\S]*to service_role/i)
  assert.match(migration, /excluded\.source_updated_at >= public\.ticket_dimension_profiles\.source_updated_at/i)
  assert.doesNotMatch(migration, /update\s+public\.ticket_events/i)
  assert.match(migration.trim(), /^begin;[\s\S]*commit;$/i)
})

test('deployed-database migration renames the field and resets the backfill cursor', async () => {
  const migration = await read(
    'supabase/migrations/20260701_phase3_step4b_concern_dimension.sql'
  )

  assert.match(migration, /rename column driver_key to concern_key/i)
  assert.match(migration, /generated always as \(concern_key\) stored/i)
  assert.match(migration, /profile\.concern_key/i)
  assert.match(migration, /stream_key = 'ticket_dimensions_backfill'/i)
  assert.match(migration, /cursor = null/i)
  assert.doesNotMatch(migration, /update\s+public\.ticket_events/i)
  assert.match(migration.trim(), /^begin;[\s\S]*commit;$/i)
})
