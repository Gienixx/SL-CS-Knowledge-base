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

test('active navigation and dedicated reporting pages use synchronized Google Sheet data', async () => {
  const dashboard = await read('dashboard.html')
  const responseTimes = await read('response-times.html')
  const agentAnalytics = await read('agent-analytics.html')

  assert.match(dashboard, /href="\.\/response-times\.html"/)
  assert.match(dashboard, /href="\.\/agent-analytics\.html"/)
  assert.match(dashboard, /Google Sheet/)

  assert.doesNotMatch(responseTimes, /http-equiv="refresh"/i)
  assert.match(responseTimes, /Synchronized Google Sheet/)
  assert.match(responseTimes, /scripts\/response-times\.js/)

  assert.doesNotMatch(agentAnalytics, /http-equiv="refresh"/i)
  assert.match(agentAnalytics, /Synchronized Google Sheet/)
  assert.match(agentAnalytics, /scripts\/agent-analytics\.js/)
})

test('detailed reporting remains sheet-only after the Step 11 dashboard migration', async () => {
  const html = await read('report-details.html')
  const report = await read('scripts/report-details.js')
  const shared = await read('scripts/sheet-reporting.js')

  assert.doesNotMatch(html, /report-details-agent-redirect\.js/)
  assert.match(html, /Synchronized Google Sheet/)
  assert.match(report, /sheet-reporting\.js/)
  assert.doesNotMatch(
    report,
    /get_dashboard_filtered_data|ticket_events|ticket_dimension_profiles|agent_identity_map|zendesk_agent_directory/i
  )
  assert.match(shared, /agent_dimension_metrics/)
  assert.match(shared, /dashboard_targets/)
})
