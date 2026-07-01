import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('dashboard constrains long concern and productivity lists', async () => {
  const [html, css] = await Promise.all([
    read('dashboard.html'),
    read('dashboard-overflow-fixes.css')
  ])

  assert.match(html, /dashboard-overflow-fixes\.css\?v=1/)
  assert.match(css, /#productivityChart[\s\S]*#ticketDriverChart/)
  assert.match(css, /overflow-y:\s*auto/)
  assert.match(css, /max-height:\s*360px/)
  assert.match(css, /max-height:\s*260px/)
})

test('dashboard resolves Zendesk agent IDs with cache and live fallback', async () => {
  const [
    html,
    compatibilityScript,
    migration,
    syncEndpoint,
    liveLookupEndpoint
  ] = await Promise.all([
    read('dashboard.html'),
    read('scripts/dashboard-concern-compat.js'),
    read('supabase/migrations/20260702_dashboard_agent_directory.sql'),
    read('functions/api/sync-zendesk-events.js'),
    read('functions/api/zendesk-agent-names.js')
  ])

  assert.match(html, /dashboard-concern-compat\.js\?v=5/)
  assert.match(compatibilityScript, /zendesk_agent_directory/)
  assert.match(compatibilityScript, /\/api\/zendesk-agent-names/)
  assert.match(compatibilityScript, /row\.agent_name = resolvedName/)
  assert.match(migration, /create table if not exists public\.zendesk_agent_directory/)
  assert.match(migration, /get_unresolved_zendesk_agent_ids/)
  assert.match(syncEndpoint, /syncZendeskAgentDirectory/)
  assert.match(liveLookupEndpoint, /users\/show_many\.json/)
  assert.match(liveLookupEndpoint, /requireDashboardUser/)
})
