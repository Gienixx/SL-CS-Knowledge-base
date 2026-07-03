import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(path, import.meta.url), 'utf8')

const removedBrowserFiles = [
  '../scripts/report-details-agent-redirect.js',
  '../scripts/reporting-source-cutover.js',
  '../scripts/response-times-base.js'
]

const forbiddenActiveReporting = /ticket_events|ticket_dimension_profiles|agent_identity_map|zendesk_agent_directory|source:\s*zendesk|zendesk_mapped|zendesk_agent_key/i

test('Step 12 migration adds audit history, alerts, freshness monitoring, and export auditing', async () => {
  const migration = await read('../supabase/migrations/2026070402_phase3_step12_reporting_operations.sql')

  assert.match(migration, /create table if not exists public\.dashboard_audit_events/)
  assert.match(migration, /create table if not exists public\.dashboard_alert_events/)
  assert.match(migration, /create or replace view public\.dashboard_active_alerts/)
  assert.match(migration, /interval '30 hours'/)
  assert.match(migration, /create trigger dashboard_sync_operations_trigger/)
  assert.match(migration, /create trigger dashboard_quality_operations_trigger/)
  assert.match(migration, /create or replace function public\.record_dashboard_export/)
  assert.match(migration, /auth\.jwt\(\) ->> 'email'/)
  assert.doesNotMatch(migration, forbiddenActiveReporting)
})

test('Reporting Operations page exposes monitoring, history, alerts, and CSV exports', async () => {
  const [html, script, css] = await Promise.all([
    read('../reporting-operations.html'),
    read('../scripts/reporting-operations.js'),
    read('../reporting-operations.css')
  ])

  assert.match(html, /Reporting Operations/)
  assert.match(html, /id="operationsAlerts"/)
  assert.match(html, /id="operationsQualityBody"/)
  assert.match(html, /id="operationsSyncBody"/)
  assert.match(html, /id="operationsAuditBody"/)
  assert.match(html, /id="operationsExportForm"/)
  assert.match(script, /dashboard_active_alerts/)
  assert.match(script, /dashboard_data_quality_results/)
  assert.match(script, /dashboard_audit_events/)
  assert.match(script, /record_dashboard_export/)
  assert.match(script, /requireApprovedUser/)
  assert.match(css, /operations-alert/)
})

test('CSV exporter supports every synchronized reporting and operations dataset', async () => {
  const script = await read('../scripts/csv-export.js')

  for (const dataset of [
    'daily_ticket_metrics',
    'daily_distribution_metrics',
    'agent_productivity',
    'ticket_driver_metrics',
    'agent_dimension_metrics',
    'dashboard_sync_runs',
    'dashboard_data_quality_results',
    'dashboard_alert_events',
    'dashboard_audit_events'
  ]) {
    assert.match(script, new RegExp(dataset))
  }

  assert.match(script, /PAGE_SIZE = 1000/)
  assert.match(script, /text\/csv/)
  assert.match(script, /replaceAll\('"', '""'\)/)
})

test('dashboard links to the final operations page', async () => {
  const dashboard = await read('../dashboard.html')
  assert.match(dashboard, /href="\.\/reporting-operations\.html"/)
})

test('obsolete browser cutover shims are removed', async () => {
  for (const path of removedBrowserFiles) {
    await assert.rejects(access(new URL(path, import.meta.url)))
  }

  const [step7Workflow, step8Workflow] = await Promise.all([
    read('../.github/workflows/phase3-step7.yml'),
    read('../.github/workflows/phase3-step8.yml')
  ])
  const workflows = `${step7Workflow}\n${step8Workflow}`
  assert.doesNotMatch(workflows, /report-details-agent-redirect|reporting-source-cutover|response-times-base/)
})

test('active reporting UI remains Google Sheet-only', async () => {
  const contents = (await Promise.all([
    '../dashboard.html',
    '../report-details.html',
    '../agent-analytics.html',
    '../response-times.html',
    '../reporting-operations.html',
    '../scripts/sheet-reporting.js',
    '../scripts/report-details.js',
    '../scripts/agent-analytics.js',
    '../scripts/response-times.js',
    '../scripts/reporting-operations.js',
    '../scripts/csv-export.js'
  ].map(read))).join('\n')

  assert.doesNotMatch(contents, forbiddenActiveReporting)
  assert.doesNotMatch(contents, /sync-zendesk|get_sla_response_dashboard/i)
  assert.match(contents, /Synchronized Google Sheet|Google Sheet/)
})

test('Step 12 includes final verification, documentation, CI, and package command', async () => {
  const [verification, documentation, workflow, pkg] = await Promise.all([
    read('../supabase/verification/phase3_step12_final_acceptance_check.sql'),
    read('../docs/phase-3-step-12-final-operations.md'),
    read('../.github/workflows/phase3-step12.yml'),
    read('../package.json')
  ])

  assert.match(verification, /active_dashboard_rpc_sheet_only/)
  assert.match(verification, /active_agent_rpc_sheet_only/)
  assert.match(verification, /latest_sync_quality/)
  assert.match(documentation, /Google Sheet is the only active reporting source/)
  assert.match(documentation, /No new workbook tabs are required/)
  assert.match(workflow, /npm run test:phase3-step12/)
  assert.match(pkg, /test:phase3-step12/)
})
