import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  PHASE3_REPORTING_SOURCE_POLICY,
  validatePhase3ReportingSourcePolicy
} from '../config/phase3-reporting-source-policy.js'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const disabledEndpoints = [
  'functions/api/sync-zendesk.js',
  'functions/api/sync-zendesk-events.js',
  'functions/api/sync-zendesk-sla.js',
  'functions/api/backfill-zendesk-ticket-dimensions.js',
  'functions/api/zendesk-test.js'
]

test('Phase 3 Step 8 declares Google Sheet as the only reporting source', () => {
  assert.equal(PHASE3_REPORTING_SOURCE_POLICY.reportingSource, 'google_sheet')
  assert.equal(PHASE3_REPORTING_SOURCE_POLICY.zendeskIntegrationEnabled, false)
  assert.equal(PHASE3_REPORTING_SOURCE_POLICY.zendeskSyncEndpointsEnabled, false)
  assert.equal(PHASE3_REPORTING_SOURCE_POLICY.zendeskReportingEnabled, false)
  assert.equal(PHASE3_REPORTING_SOURCE_POLICY.preserveZendeskTables, true)
  assert.deepEqual(validatePhase3ReportingSourcePolicy(), [])
})

test('all Zendesk network entry points return the shared disabled response', async () => {
  for (const path of disabledEndpoints) {
    const source = await read(path)
    assert.match(source, /zendeskIntegrationDisabledResponse/)
    assert.doesNotMatch(source, /fetchZendeskJson|testZendeskConnection|acquireZendeskSyncLock/)
  }

  const shared = await read('functions/_shared/zendesk-disabled.js')
  assert.match(shared, /zendesk_integration_disabled/)
  assert.match(shared, /reportingSource: 'google_sheet'/)
  assert.match(shared, /status,?\s*headers/)
})

test('scheduled Worker is a no-op and exposes disabled status', async () => {
  const worker = await read('workers/zendesk-health/index.js')
  assert.match(worker, /enabled: false/)
  assert.match(worker, /reportingSource: 'google_sheet'/)
  assert.match(worker, /scheduled synchronization skipped/)
  assert.doesNotMatch(worker, /\/api\/sync-zendesk|PAGES_BASE_URL|ZENDESK_SYNC_SECRET/)
})

test('active navigation and legacy Zendesk-only pages route to Google Sheet reporting', async () => {
  const dashboard = await read('dashboard.html')
  const responseTimes = await read('response-times.html')
  const agentAnalytics = await read('agent-analytics.html')

  assert.doesNotMatch(dashboard, /href="\.\/response-times\.html"/)
  assert.match(dashboard, /Google Sheet/)
  assert.match(responseTimes, /url=\.\/dashboard\.html/)
  assert.match(agentAnalytics, /report-details\.html\?report=agent-productivity/)
})

test('report details strips Zendesk filters, hides source UI, and blocks Zendesk reporting RPCs', async () => {
  const bootstrap = await read('scripts/report-details-agent-redirect.js')
  const policy = await read('scripts/reporting-source-cutover.js')

  for (const key of ['app', 'platform', 'country', 'driver', 'agent', 'priority', 'channel']) {
    assert.match(bootstrap, new RegExp(`'${key}'`))
  }

  assert.match(bootstrap, /#reportSourceBadge/)
  assert.match(bootstrap, /reporting-source-cutover\.js/)
  assert.match(bootstrap, /Google Sheet dataset/)
  assert.match(policy, /get_dashboard_filtered_data/)
  assert.match(policy, /supabase\.rpc =/)
  assert.match(policy, /field\.hidden = true/)
})
