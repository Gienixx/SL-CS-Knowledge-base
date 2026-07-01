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

test('Step 5 dependency check requires the exact Step 4 aggregate RPC', () => {
  const sql = read(
    'supabase/verification/phase3_step5_dependency_check.sql'
  )

  assert.equal(
    sql.includes(
      'public.get_dashboard_filtered_data(date,date,text,text,text,text,text,text,text,text)'
    ),
    true
  )
  assert.equal(sql.includes("'step4_filtered_dashboard_rpc'"), true)
  assert.equal(
    sql.includes('20260701_phase3_step4_global_filter_rpc.sql'),
    true
  )
})

test('Step 5 verification checks readiness without executing the expensive aggregation', () => {
  const sql = read(
    'supabase/verification/phase3_step5b_period_comparison_runtime_check.sql'
  )

  assert.equal(sql.includes('to_regprocedure('), true)
  assert.equal(sql.includes('has_function_privilege'), true)
  assert.equal(sql.includes("'runtime_comparison_rpc'"), true)
  assert.equal(
    sql.includes('full data execution intentionally skipped'),
    true
  )
  assert.equal(sql.includes('execute $sql$'), false)
  assert.equal(
    sql.includes('select public.get_dashboard_period_comparison('),
    false
  )
})

test('comparison badges expose actionable RPC errors', () => {
  const source = read('scripts/dashboard-period-comparisons.js')

  assert.equal(source.includes('comparisonErrorPresentation'), true)
  assert.equal(source.includes("'PGRST202'"), true)
  assert.equal(source.includes("'Reload Supabase schema'"), true)
  assert.equal(source.includes("'Comparison permission denied'"), true)
  assert.equal(source.includes("'Comparison timed out'"), true)
  assert.equal(source.includes('element.title = detail'), true)
})

test('Step 5 documentation includes dependency and schema-cache recovery', () => {
  const documentation = read(
    'docs/phase-3-step-5-period-comparisons.md'
  )

  assert.equal(
    documentation.includes('20260701_phase3_step4_global_filter_rpc.sql'),
    true
  )
  assert.equal(
    documentation.includes('phase3_step5_dependency_check.sql'),
    true
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
  assert.equal(
    documentation.includes('does not execute the full dashboard aggregation'),
    true
  )
})
