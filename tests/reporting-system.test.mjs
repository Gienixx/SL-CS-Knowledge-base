import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

async function absent(path) {
  await assert.rejects(access(new URL(`../${path}`, import.meta.url)))
}

test('active reporting is synchronized Google Sheet-only', async () => {
  const paths = [
    'dashboard.html', 'report-details.html', 'agent-analytics.html',
    'response-times.html', 'reporting-operations.html',
    'scripts/sheet-reporting.js', 'scripts/report-details.js',
    'scripts/agent-analytics.js', 'scripts/response-times.js',
    'scripts/reporting-operations.js', 'scripts/reporting-operations-entry.js',
    'functions/api/sync-dashboard.js'
  ]
  const contents = (await Promise.all(paths.map(read))).join('\n')
  assert.match(contents, /Google Sheet/)
  assert.doesNotMatch(contents, /sync-zendesk|zendesk_agent|ticket_events|ticket_dimension_profiles/i)
})

test('the workbook script targets the current synchronization endpoint', async () => {
  const script = await read('apps-script/dashboard-sync.gs')
  assert.match(script, /syncAllDashboardData/)
  assert.match(script, /\/api\/sync-dashboard/)
  assert.match(script, /Daily Volume/)
  assert.match(script, /Ticket Productivity/)
  assert.match(script, /Daily Drivers/)
})

test('retired V3 and Zendesk synchronization routes are removed', async () => {
  for (const path of [
    'functions/api/sync-dashboard-v3.js',
    'functions/_shared/dashboard-sync-contract-v3.js',
    'functions/api/sync-zendesk.js',
    'functions/api/sync-zendesk-events.js',
    'functions/api/sync-zendesk-sla.js'
  ]) await absent(path)
})

test('current database operations and verification files are present', async () => {
  const paths = [
    'supabase/migrations-legacy/2026070301_google_sheet_reporting_contract.sql',
    'supabase/migrations-legacy/2026070302_sheet_only_reporting_schema.sql',
    'supabase/migrations-legacy/2026070303_sheet_only_dashboard_rpc.sql',
    'supabase/migrations-legacy/2026070304_sheet_only_agent_rpc.sql',
    'supabase/migrations-legacy/2026070401_dashboard_features.sql',
    'supabase/migrations-legacy/2026070402_reporting_operations.sql',
    'supabase/migrations-legacy/2026070403_sync_history_visibility_fix.sql',
    'supabase/migrations-legacy/2026070607_reporting_operations_admin_access.sql',
    'supabase/verification/google_sheet_contract_check.sql',
    'supabase/verification/sheet_only_reporting_check.sql',
    'supabase/verification/reporting_acceptance_check.sql',
    'supabase/verification/sync_history_visibility_check.sql',
    'supabase/verification/reporting_operations_admin_access_check.sql'
  ]
  for (const path of paths) assert.ok((await read(path)).trim().length > 0, `${path} should not be empty`)
})
