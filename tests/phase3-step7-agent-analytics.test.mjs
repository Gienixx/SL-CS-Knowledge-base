import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Step 7 migration exposes combined agent analytics without SLA dependencies', async () => {
  const identitySql = await read('supabase/migrations/2026070202_phase3_step7_agent_identity_map.sql')
  const analyticsSql = await read('supabase/migrations/2026070203_phase3_step7_agent_analytics_rpc.sql')
  const sql = `${identitySql}\n${analyticsSql}`

  assert.match(sql, /create table if not exists public\.agent_identity_map/i)
  assert.match(sql, /create or replace function public\.get_agent_analytics_dashboard/i)
  assert.match(sql, /capture_agent_identity_from_productivity/i)
  assert.match(sql, /avg_aht_minutes/i)
  assert.match(sql, /median_aht_minutes/i)
  assert.match(sql, /avg_first_response_minutes/i)
  assert.match(sql, /avg_resolution_minutes/i)
  assert.match(sql, /reopen_rate/i)
  assert.match(sql, /team_output_share/i)
  assert.match(sql, /workload_adjusted_index/i)
  assert.doesNotMatch(sql, /sync-zendesk-sla|get_sla_response_dashboard/i)
})

test('Step 7 page includes filters, summaries, trends, ranking, and details', async () => {
  const html = await read('agent-analytics.html')

  assert.match(html, /Expanded Agent Analytics/)
  assert.match(html, /id="agentAnalyticsFilterForm"/)
  assert.match(html, /id="agentAnalyticsSummary"/)
  assert.match(html, /id="agentAnalyticsTrendChart"/)
  assert.match(html, /id="agentAnalyticsRanking"/)
  assert.match(html, /id="agentAnalyticsTableBody"/)
  assert.match(html, /team level/i)
  assert.doesNotMatch(html, /SLA compliance|SLA breach/i)
})

test('Step 7 client uses the bounded analytics RPC and approved-user guard', async () => {
  const script = await read('scripts/agent-analytics.js')

  assert.match(script, /get_agent_analytics_dashboard/)
  assert.match(script, /p_start_date/)
  assert.match(script, /p_end_date/)
  assert.match(script, /p_agent_key/)
  assert.match(script, /requiresFirstLoginPasswordChange/)
  assert.match(script, /from\('login'\)/)
  assert.doesNotMatch(script, /sync-zendesk-sla|get_sla_response_dashboard/)
})

test('Existing Agent Productivity report redirects to Step 7', async () => {
  const html = await read('report-details.html')
  const redirect = await read('scripts/report-details-agent-redirect.js')

  assert.match(html, /report-details-agent-redirect\.js\?v=1/)
  assert.match(redirect, /agent-productivity/)
  assert.match(redirect, /agent-analytics\.html/)
  assert.match(redirect, /searchParams\.delete\('report'\)/)
})

test('Step 7 rollout guide keeps Zendesk SLA synchronization disabled', async () => {
  const guide = await read('docs/phase-3-step-7-agent-analytics.md')
  const verification = await read('supabase/verification/phase3_step7_agent_analytics_check.sql')

  assert.match(guide, /ZENDESK_SLA_SYNC_ENABLED/)
  assert.match(guide, /do not call `\/api\/sync-zendesk-sla`/i)
  assert.match(verification, /get_agent_analytics_dashboard/)
  assert.match(verification, /manual mapping required/i)
})
