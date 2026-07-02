import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')

test('Step 6 is presented as response-time reporting only', async () => {
  const [dashboard, wrapper, guide, verification] = await Promise.all([
    read('dashboard.html'),
    read('scripts/response-times.js'),
    read('docs/phase-3-step-6-response-times-only.md'),
    read('supabase/verification/phase3_step6_response_times_check.sql')
  ])

  assert.match(dashboard, />Response Times</)
  assert.doesNotMatch(dashboard, />SLA &amp; Response Times</)
  assert.match(wrapper, /response-times-base\.js/)
  assert.match(wrapper, /response-summary-card:last-child/)
  assert.match(wrapper, /detail-table td:nth-child\(4\)/)
  assert.match(guide, /Zendesk SLA policies are not required/)
  assert.match(guide, /ZENDESK_SLA_SYNC_ENABLED/)
  assert.match(verification, /response_time_dashboard_rpc/)
})
