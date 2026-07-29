import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const migrationPath =
  'supabase/migrations/20260729103000_complete_payroll_exception_review.sql'
const versionCorrectionPath =
  'supabase/migrations/20260729111500_use_schedule_version_for_preplot_change.sql'

test('Step 8 adds every prepaid balance and allocation exception', async () => {
  const migration = await read(migrationPath)

  for (const code of [
    'schedule_changed_after_preplot_approval',
    'preplot_missing_payroll_approval',
    'invalid_preplot_minutes',
    'duplicate_hour_allocation',
    'prepaid_balance_missing_source',
    'duplicate_prepaid_balance',
    'unaudited_prepaid_balance',
    'unresolved_prepaid_balance'
  ]) {
    assert.match(migration, new RegExp(`'${code}'::text`))
  }

  assert.match(
    migration,
    /'unresolved_prepaid_balance'::text,[\s\S]*?'warning'::text,[\s\S]*?false/
  )
  assert.match(
    migration,
    /'duplicate_hour_allocation'::text,[\s\S]*?'blocking'::text,[\s\S]*?true/
  )
  assert.match(
    migration,
    /schedule\.schedule_version as current_schedule_version/
  )
  assert.match(
    migration,
    /allocation\.allocation_type = 'settlement'[\s\S]*?reversal\.reverses_allocation_id/
  )
  assert.match(
    migration,
    /from public\.payroll_schedule_snapshots as snapshot/
  )
  assert.match(migration, /join public\.payroll_prepaid_hours as prepaid/)
  assert.match(
    migration,
    /from public\.payroll_hour_allocations as allocation/
  )
})

test('completed exception RPC remains permission-scoped and metadata-only', async () => {
  const migration = await read(migrationPath)
  const signature = migration.match(
    /returns table \([\s\S]*?\)\s*language plpgsql\s*stable\s*security definer/
  )?.[0] || ''

  assert.match(migration, /auth\.uid\(\) is null/)
  for (const permission of [
    'create_payroll',
    'review_payroll',
    'finalize_payroll',
    'reopen_payroll'
  ]) {
    assert.match(
      migration,
      new RegExp(`workforce_has_permission\\('${permission}'\\)`)
    )
  }
  assert.match(
    migration,
    /revoke all on function public\.payroll_get_period_exceptions\(uuid\)[\s\S]*?from public, anon/
  )
  assert.match(
    migration,
    /grant execute on function public\.payroll_get_period_exceptions\(uuid\)[\s\S]*?to authenticated, service_role/
  )
  assert.doesNotMatch(
    signature,
    /hourly_rate|daily_rate|monthly_rate|overtime_rate|holiday_rate|gross_pay|net_pay/
  )
})

test('schedule-change review uses the authoritative monotonic version', async () => {
  const correction = await read(versionCorrectionPath)

  assert.match(
    correction,
    /issue\.exception_code <> 'schedule_changed_after_preplot_approval'/
  )
  assert.match(
    correction,
    /approved_schedule_version[\s\S]*?::bigint is distinct from[\s\S]*?current_schedule_version/
  )
  assert.match(correction, /auth\.uid\(\) is null/)
  assert.match(
    correction,
    /revoke all on function public\.payroll_get_period_exceptions_complete_base\(uuid\)[\s\S]*?from public, anon, authenticated/
  )
})

test('payroll review links prepaid, attendance, and rate exceptions to exact targets', async () => {
  const [periodScript, periodPage, periodStyles, rateScript, ratePage] =
    await Promise.all([
      read('scripts/payroll-period.js'),
      read('payroll-period.html'),
      read('styles/payroll-periods.css'),
      read('scripts/agent-rates.js'),
      read('agent-rates.html')
    ])

  assert.match(periodScript, /const PREPLOT_EXCEPTION_CODES = new Set/)
  assert.match(
    periodScript,
    /row\.id = `payroll-preplot-\$\{candidate\.schedule_id\}`/
  )
  assert.match(
    periodScript,
    /reviewLink\.dataset\.exceptionFilter = 'unresolved_prepaid_balance'/
  )
  assert.match(
    periodScript,
    /agentRatesUrl\(issue\.employee_user_id, issue\.work_date\)/
  )
  assert.match(
    periodScript,
    /teamAttendanceUrl\(issue\.employee_user_id, issue\.work_date\)/
  )
  assert.match(periodStyles, /\.payroll-preplot-table tr:target/)
  assert.match(periodPage, /non-blocking prepaid carry-forward balances/)
  assert.match(periodPage, /scripts\/payroll-period\.js\?v=8/)
  assert.match(
    rateScript,
    /const requestedEmployeeId = pageParams\.get\('employee'\)/
  )
  assert.match(
    rateScript,
    /const requestedEffectiveDate = pageParams\.get\('effectiveDate'\)/
  )
  assert.match(ratePage, /scripts\/agent-rates\.js\?v=6/)

  for (const script of [
    'scripts/payroll-period.js',
    'scripts/agent-rates.js'
  ]) {
    const syntax = spawnSync(process.execPath, ['--check', script], {
      cwd: new URL('../', import.meta.url),
      encoding: 'utf8'
    })
    assert.equal(syntax.status, 0, syntax.stderr)
  }
})
