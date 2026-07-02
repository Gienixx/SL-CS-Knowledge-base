import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(path, import.meta.url), 'utf8')

const schemaMigrationPath =
  '../supabase/migrations/2026070302_phase3_step10_sheet_only_schema.sql'
const dashboardMigrationPath =
  '../supabase/migrations/2026070303_phase3_step10_sheet_only_dashboard_rpc.sql'
const agentMigrationPath =
  '../supabase/migrations/2026070304_phase3_step10_sheet_only_agent_rpc.sql'

const forbiddenReportingSources = [
  'ticket_events',
  'ticket_dimension_profiles',
  'agent_identity_map',
  'zendesk_agent_directory'
]

test('Step 10 adds sheet-only sync observability objects', async () => {
  const migration = await read(schemaMigrationPath)

  assert.match(migration, /add column if not exists reporting_source/)
  assert.match(migration, /add column if not exists quality_status/)
  assert.match(migration, /create table if not exists public\.agent_dimension_metrics/)
  assert.match(migration, /create table if not exists public\.dashboard_data_quality_results/)
  assert.match(migration, /create or replace view public\.dashboard_sync_runs/)
  assert.match(migration, /create trigger sheet_sync_quality_results_trigger/)
})

test('active Step 10 RPC definitions use only sheet-backed reporting tables', async () => {
  const migration = (await Promise.all([
    read(dashboardMigrationPath),
    read(agentMigrationPath)
  ])).join('\n').toLowerCase()

  for (const table of [
    'public.daily_ticket_metrics',
    'public.daily_distribution_metrics',
    'public.agent_productivity',
    'public.ticket_driver_metrics'
  ]) {
    assert.match(migration, new RegExp(table.replace('.', '\\.')))
  }

  for (const source of forbiddenReportingSources) {
    assert.doesNotMatch(migration, new RegExp(`public\\.${source}`))
  }

  assert.match(migration, /create or replace function public\.get_dashboard_reporting_status/)
  assert.match(migration, /sheet_only_dimension_filters_unavailable/)
  assert.match(migration, /'first_response_minutes', null/)
  assert.match(migration, /'avg_first_response_minutes', null/)
  assert.match(migration, /'avg_resolution_minutes', null/)
  assert.match(migration, /'reopen_rate', null/)
})

test('the existing v2 synchronization remains the only active ingestion path', async () => {
  const [endpoint, policy] = await Promise.all([
    read('../functions/api/sync-dashboard.js'),
    read('../config/phase3-reporting-source-policy.js')
  ])

  assert.match(endpoint, /payloadVersion: 2/)
  assert.match(endpoint, /result\.dailyMetrics\.importedRecords/)
  assert.match(endpoint, /result\.distributions\.importedRecords/)
  assert.match(endpoint, /result\.productivity\.importedRecords/)
  assert.match(endpoint, /result\.drivers\.importedRecords/)
  assert.doesNotMatch(endpoint, /ticket_events|zendesk/i)

  assert.match(policy, /reportingSource: 'google_sheet'/)
  assert.match(policy, /zendeskReportingEnabled: false/)
  assert.match(policy, /preserveZendeskTables: true/)
})

test('Step 10 documentation requires no replacement workbook tabs', async () => {
  const documentation = await read(
    '../docs/phase-3-step-10-sheet-only-supabase-reporting.md'
  )

  assert.match(documentation, /Daily Volume/)
  assert.match(documentation, /Daily Drivers/)
  assert.match(documentation, /Ticket Productivity/)
  assert.match(documentation, /does not add or require any new workbook tabs/i)
  assert.match(documentation, /syncAllDashboardData\(\)/)
  assert.match(documentation, /Zendesk tables and historical records remain unchanged/i)
})

test('Step 10 verification checks live function definitions for Zendesk references', async () => {
  const verification = await read(
    '../supabase/verification/phase3_step10_sheet_only_reporting_check.sql'
  )

  assert.match(verification, /pg_get_functiondef/)
  assert.match(verification, /active_rpcs_are_sheet_only/)
  assert.match(verification, /latest_google_sheet_sync/)
  assert.match(verification, /latest_sync_quality_checks/)

  for (const source of forbiddenReportingSources) {
    assert.match(verification, new RegExp(source))
  }
})
