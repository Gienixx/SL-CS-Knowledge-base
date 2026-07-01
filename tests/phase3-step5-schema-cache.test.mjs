import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

function read(path) {
  return readFileSync(new URL(path, `file://${ROOT}/`), 'utf8')
}

test('Step 5b refreshes the PostgREST schema cache and reapplies RPC access', () => {
  const sql = read(
    'supabase/migrations/20260702_phase3_step5b_refresh_period_comparison_rpc.sql'
  )

  assert.equal(
    sql.includes("notify pgrst, 'reload schema'"),
    true
  )
  assert.equal(
    sql.includes('get_dashboard_period_comparison'),
    true
  )
  assert.equal(
    sql.includes('to authenticated, service_role'),
    true
  )
})

test('Step 5b runtime check executes the comparison RPC as authenticated', () => {
  const sql = read(
    'supabase/verification/phase3_step5b_period_comparison_runtime_check.sql'
  )

  assert.equal(sql.includes('set local role authenticated'), true)
  assert.equal(
    sql.includes('public.get_dashboard_period_comparison('),
    true
  )
  assert.equal(sql.includes("'runtime_comparison_rpc'"), true)
  assert.equal(sql.includes("then 'PASS'"), true)
})

test('comparison badges expose actionable RPC errors', () => {
  const source = read('scripts/dashboard-period-comparisons.js')

  assert.equal(source.includes('comparisonErrorPresentation'), true)
  assert.equal(source.includes("'PGRST202'"), true)
  assert.equal(source.includes("'Reload Supabase schema'"), true)
  assert.equal(source.includes("'Comparison permission denied'"), true)
  assert.equal(source.includes('element.title = detail'), true)
})

test('Step 5 documentation includes schema-cache recovery instructions', () => {
  const documentation = read(
    'docs/phase-3-step-5-period-comparisons.md'
  )

  assert.equal(
    documentation.includes(
      '20260702_phase3_step5b_refresh_period_comparison_rpc.sql'
    ),
    true
  )
  assert.equal(
    documentation.includes("NOTIFY pgrst, 'reload schema'"),
    true
  )
  assert.equal(
    documentation.includes(
      'phase3_step5b_period_comparison_runtime_check.sql'
    ),
    true
  )
})
