import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

function read(path) {
  return readFileSync(new URL(path, `file://${ROOT}/`), 'utf8')
}

test('Step 5 migration exposes an authenticated comparison RPC', () => {
  const sql = read(
    'supabase/migrations/20260702_phase3_step5_period_comparisons.sql'
  )

  for (const requiredText of [
    'create or replace function public.get_dashboard_period_comparison',
    'p_period_kind text',
    'returns jsonb',
    'security definer',
    'to authenticated, service_role'
  ]) {
    assert.equal(sql.includes(requiredText), true, requiredText)
  }
})

test('comparison RPC reuses the Step 4 filtered contract for both periods', () => {
  const sql = read(
    'supabase/migrations/20260702_phase3_step5_period_comparisons.sql'
  )

  assert.equal(
    sql.match(/public\.get_dashboard_filtered_data\(/g)?.length,
    2
  )
  assert.equal(sql.includes('v_current :='), true)
  assert.equal(sql.includes('v_previous :='), true)
})

test('period rules cover rolling, MTD, partial, and full-month comparisons', () => {
  const sql = read(
    'supabase/migrations/20260702_phase3_step5_period_comparisons.sql'
  )

  for (const requiredText of [
    "v_effective_kind := 'previous_period'",
    "v_effective_kind := 'mtd'",
    "v_effective_kind := 'month'",
    'v_previous_end := p_start_date - 1',
    'v_previous_month_start + v_elapsed_days',
    'least(',
    'dashboard_comparison_month_range_invalid',
    'dashboard_comparison_mtd_range_invalid'
  ]) {
    assert.equal(sql.includes(requiredText), true, requiredText)
  }
})

test('zero baselines and missing values avoid invalid percentages', () => {
  const sql = read(
    'supabase/migrations/20260702_phase3_step5_period_comparisons.sql'
  )

  assert.equal(sql.includes('when previous_value = 0 then null'), true)
  assert.equal(sql.includes("then 'new'"), true)
  assert.equal(sql.includes("then 'missing'"), true)
  assert.equal(sql.includes("'zeroBaseline', zero_baseline"), true)
})

test('browser reuses current data and requests only the previous period', () => {
  const source = read('scripts/dashboard-period-comparisons.js')

  for (const valueId of [
    'newTicketsValue',
    'solvedTicketsValue',
    'unsolvedTicketsValue',
    'oneTouchResolutionValue',
    'reopenedRateValue'
  ]) {
    assert.equal(source.includes(valueId), true, valueId)
  }

  assert.equal(source.includes("'get_dashboard_filtered_data'"), true)
  assert.equal(source.includes("'get_dashboard_period_comparison'"), false)
  assert.equal(source.includes('buildComparisonPayload'), true)
  assert.equal(source.includes('currentSummary'), true)
  assert.equal(source.includes('previousSummary'), true)
  assert.equal(source.includes('percentChange'), true)
  assert.equal(source.includes('prev ${formatNumber(metric.previous)}'), true)
})

test('browser deduplicates repeated comparison events', () => {
  const source = read('scripts/dashboard-period-comparisons.js')

  assert.equal(source.includes('inFlightSignature'), true)
  assert.equal(source.includes('lastSuccessfulSignature'), true)
  assert.equal(
    source.includes('signature === lastSuccessfulSignature || signature === inFlightSignature'),
    true
  )
  assert.equal(source.includes('requestId !== comparisonRequest'), true)
})

test('dashboard loads loop-safe Step 5 script after global filters', () => {
  const dashboard = read('dashboard.html')
  const filtersPosition = dashboard.indexOf(
    './scripts/dashboard-global-filters.js?v=1'
  )
  const comparisonPosition = dashboard.indexOf(
    './scripts/dashboard-period-comparisons.js?v=2'
  )

  assert.equal(
    dashboard.includes('./dashboard-period-comparisons.css?v=1'),
    true
  )
  assert.ok(filtersPosition >= 0)
  assert.ok(comparisonPosition > filtersPosition)
})

test('verification checks function existence and access boundaries', () => {
  const sql = read(
    'supabase/verification/phase3_step5_period_comparisons_check.sql'
  )

  for (const checkName of [
    'required_function',
    'authenticated_execute',
    'anonymous_denied',
    'reuses_filtered_contract',
    'zero_baseline_handling'
  ]) {
    assert.equal(sql.includes(checkName), true, checkName)
  }
})
