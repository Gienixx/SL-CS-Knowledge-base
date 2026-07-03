import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(path, import.meta.url), 'utf8')

const activePages = [
  '../report-details.html',
  '../agent-analytics.html',
  '../response-times.html'
]

const activeScripts = [
  '../scripts/sheet-reporting.js',
  '../scripts/report-details.js',
  '../scripts/agent-analytics.js',
  '../scripts/response-times.js'
]

const forbidden = /ticket_events|ticket_dimension_profiles|agent_identity_map|zendesk_agent_directory|source:\s*zendesk|zendesk_mapped|zendesk_agent_key/i

test('Step 11 restores all dedicated synchronized reporting pages', async () => {
  const [dashboard, report, agent, response] = await Promise.all([
    read('../dashboard.html'),
    read('../report-details.html'),
    read('../agent-analytics.html'),
    read('../response-times.html')
  ])

  assert.match(dashboard, /href="\.\/agent-analytics\.html"/)
  assert.match(dashboard, /href="\.\/response-times\.html"/)
  assert.doesNotMatch(agent, /http-equiv="refresh"/i)
  assert.doesNotMatch(response, /http-equiv="refresh"/i)
  assert.match(report, /Synchronized Google Sheet/)
  assert.match(agent, /Synchronized Google Sheet/)
  assert.match(response, /Synchronized Google Sheet/)
})

test('active Step 11 browser code contains no Zendesk reporting dependencies', async () => {
  const contents = (await Promise.all([...activePages, ...activeScripts].map(read))).join('\n')
  assert.doesNotMatch(contents, forbidden)
  assert.doesNotMatch(contents, /switches to Zendesk|Source: Zendesk|Zendesk mapping/i)
})

test('detailed reports implement period, target, and synchronized cross-filter comparisons', async () => {
  const [report, shared] = await Promise.all([
    read('../scripts/report-details.js'),
    read('../scripts/sheet-reporting.js')
  ])

  assert.match(report, /previousRange/)
  assert.match(report, /Absolute change/)
  assert.match(report, /Percentage change/)
  assert.match(report, /targetStatus/)
  assert.match(report, /Configured target/)
  assert.match(shared, /agent_dimension_metrics/)
  assert.match(shared, /dashboard_targets/)
  assert.match(shared, /Choose only one App, Platform, Country, Concern, Priority, or Channel filter at a time/)
})

test('agent analytics removes mapping readiness and uses synchronized dimensions', async () => {
  const [html, script] = await Promise.all([
    read('../agent-analytics.html'),
    read('../scripts/agent-analytics.js')
  ])

  assert.match(html, /dimension drill-downs/i)
  assert.match(script, /loadAgentDimensionRows/)
  assert.match(script, /workload_adjusted_index/)
  assert.match(script, /Matched Tickets/)
  assert.doesNotMatch(html, /mapping readiness|Zendesk Mapping/i)
})

test('response-time reporting requires populated synchronized counts', async () => {
  const script = await read('../scripts/response-times.js')
  assert.match(script, /responded_tickets/)
  assert.match(script, /first_response_minutes_total/)
  assert.match(script, /resolved_tickets/)
  assert.match(script, /resolution_minutes_total/)
  assert.match(script, /Values remain unavailable rather than being inferred/)
})

test('Step 11 migration adds optional targets and filter capability reporting', async () => {
  const migration = await read('../supabase/migrations/2026070401_phase3_step11_dashboard_features.sql')
  assert.match(migration, /create table if not exists public\.dashboard_targets/)
  assert.match(migration, /enable row level security/)
  assert.match(migration, /create or replace view public\.dashboard_filter_capabilities/)
  assert.match(migration, /public\.agent_dimension_metrics/)
  assert.doesNotMatch(migration, forbidden)
})

test('Step 11 includes deployment documentation, verification, CI, and package command', async () => {
  const [documentation, verification, workflow, pkg] = await Promise.all([
    read('../docs/phase-3-step-11-dashboard-migration.md'),
    read('../supabase/verification/phase3_step11_dashboard_check.sql'),
    read('../.github/workflows/phase3-step11.yml'),
    read('../package.json')
  ])

  assert.match(documentation, /No new Google Sheet tabs/)
  assert.match(documentation, /one dimension can be selected at a time/)
  assert.match(verification, /agent_dimension_data/)
  assert.match(verification, /sheet_only_dashboard_rpc/)
  assert.match(workflow, /npm run test:phase3-step11/)
  assert.match(pkg, /test:phase3-step11/)
})
