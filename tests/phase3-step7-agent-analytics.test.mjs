import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('historical Step 7 migrations remain available for audit context', async () => {
  const identitySql = await read('supabase/migrations/2026070202_phase3_step7_agent_identity_map.sql')
  const analyticsSql = await read('supabase/migrations/2026070203_phase3_step7_agent_analytics_rpc.sql')
  const sql = `${identitySql}\n${analyticsSql}`

  assert.match(sql, /create table if not exists public\.agent_identity_map/i)
  assert.match(sql, /create or replace function public\.get_agent_analytics_dashboard/i)
  assert.match(sql, /workload_adjusted_index/i)
})

test('active Agent Analytics page is the synchronized Google Sheet implementation', async () => {
  const [html, script, shared] = await Promise.all([
    read('agent-analytics.html'),
    read('scripts/agent-analytics.js'),
    read('scripts/sheet-reporting.js')
  ])

  assert.match(html, /Expanded Agent Analytics/)
  assert.match(html, /Synchronized Google Sheet|Google Sheet/)
  assert.match(html, /id="agentAnalyticsFilterForm"/)
  assert.match(html, /id="agentAnalyticsSummary"/)
  assert.match(html, /id="agentAnalyticsTrendChart"/)
  assert.match(html, /id="agentAnalyticsRanking"/)
  assert.match(html, /id="agentAnalyticsTableBody"/)
  assert.match(script, /agent_productivity/)
  assert.match(script, /loadAgentDimensionRows/)
  assert.match(script, /workload_adjusted_index/)
  assert.match(shared, /agent_dimension_metrics/)
  assert.doesNotMatch(
    `${html}\n${script}\n${shared}`,
    /ticket_events|ticket_dimension_profiles|agent_identity_map|zendesk_agent_directory|get_sla_response_dashboard/i
  )
})

test('Agent Productivity detailed reporting remains directly available without redirect shims', async () => {
  const [html, script] = await Promise.all([
    read('report-details.html'),
    read('scripts/report-details.js')
  ])

  assert.doesNotMatch(html, /report-details-agent-redirect/)
  assert.match(script, /'agent-productivity'/)
  assert.match(script, /agent_productivity/)
  assert.match(script, /sheet-reporting\.js/)
})
