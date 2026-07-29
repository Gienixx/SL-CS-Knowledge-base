import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath =
  'supabase/migrations/20260729151931_calculate_draft_payroll.sql'
const calculationReadCorrectionPath =
  'supabase/migrations/20260729153924_hide_uncalculated_payroll_results.sql'

test('Step 7 calculates draft payroll from exact snapshots and work-date rates', async () => {
  const migration = await read(migrationPath)

  assert.match(
    migration,
    /effective_rate\.effective_date <= snapshot\.work_date[\s\S]*?order by effective_rate\.effective_date desc/
  )
  assert.match(
    migration,
    /snapshot\.regular_minutes -[\s\S]*?regular_allocation\.minute_category = 'regular'/
  )
  assert.match(
    migration,
    /snapshot\.pre_shift_overtime_minutes -[\s\S]*?pre_allocation\.minute_category = 'pre_shift_overtime'/
  )
  assert.match(
    migration,
    /snapshot\.post_shift_overtime_minutes -[\s\S]*?post_allocation\.minute_category = 'post_shift_overtime'/
  )
  assert.match(
    migration,
    /round\([\s\S]*?payable\.payable_regular_minutes::numeric[\s\S]*?60 \* payable\.hourly_rate,[\s\S]*?v_money_scale/
  )
  assert.match(migration, /v_rounding_mode <> 'half_up'/)
  assert.match(migration, /v_minute_conversion <> 'exact'/)
})

test('Step 7 separates prepaid, overtime, and special-day earnings', async () => {
  const migration = await read(migrationPath)

  for (const code of [
    'regular_earnings',
    'prepaid_scheduled_earnings',
    'pre_shift_overtime',
    'post_shift_overtime',
    'rest_day_work',
    'rest_day_excess',
    'holiday_guarantee',
    'holiday_work',
    'holiday_excess'
  ]) {
    assert.match(migration, new RegExp(`'${code}'`))
  }

  assert.match(
    migration,
    /least\([\s\S]*?payable\.rest_day_overtime_minutes[\s\S]*?480/
  )
  assert.match(
    migration,
    /greatest\([\s\S]*?payable\.rest_day_overtime_minutes[\s\S]*?- 480/
  )
  assert.match(migration, /payable\.effective_overtime_rate \* 2/)
  assert.match(migration, /payable\.effective_holiday_rate \* 2/)
  assert.match(
    migration,
    /schedule\.is_holiday[\s\S]*?round\(rate\.daily_rate/
  )
})

test('Step 7 is atomic, permission-scoped, auditable, and protects finalized payroll', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /pg_advisory_xact_lock/)
  assert.match(migration, /for update/)
  assert.match(migration, /workforce_has_permission\('create_payroll'\)/)
  assert.match(migration, /v_period\.status not in \('draft', 'reopened'\)/)
  assert.match(
    migration,
    /insert into public\.payroll_audit_logs[\s\S]*?'payroll_draft_calculated'/
  )
  assert.match(
    migration,
    /Payroll deductions cannot make an employee net pay negative/
  )
  assert.match(migration, /government|statutory/)
  assert.match(
    migration,
    /own_record\.status = 'finalized'[\s\S]*?workforce_is_current_identity\(own_record\.employee_id\)/
  )
  assert.match(
    migration,
    /revoke all on function public\.payroll_calculate_draft\(uuid\)[\s\S]*?from public, anon/
  )
})

test('payroll period exposes permission-aware calculation totals and line details', async () => {
  const [page, script, styles, readCorrection] = await Promise.all([
    read('payroll-period.html'),
    read('scripts/payroll-period.js'),
    read('styles/payroll-periods.css'),
    read(calculationReadCorrectionPath)
  ])

  assert.match(page, /id="calculatePayrollButton"/)
  assert.match(page, /id="payrollCalculationBody"/)
  assert.match(page, /scripts\/payroll-period\.js\?v=9/)
  assert.match(page, /styles\/payroll-periods\.css\?v=9/)
  assert.match(script, /supabase\.rpc\('payroll_calculate_draft'/)
  assert.match(script, /supabase\.rpc\('payroll_get_period_calculation'/)
  assert.match(
    script,
    /state\.exceptions\.filter\([\s\S]*?issue => issue\.is_blocking/
  )
  assert.match(script, /new Intl\.NumberFormat\('en-US'/)
  assert.doesNotMatch(script, /console\.(?:log|debug|info).*gross|console\.(?:log|debug|info).*net/i)
  assert.match(styles, /\.payroll-calculation-table/)
  assert.match(styles, /\.payroll-calculation-details/)
  assert.match(readCorrection, /record\.calculated_at is not null/)
  assert.match(
    readCorrection,
    /revoke all on function public\.payroll_get_period_calculation\(uuid\)[\s\S]*?from public, anon/
  )

  const syntax = spawnSync(process.execPath, ['--check', 'scripts/payroll-period.js'], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8'
  })
  assert.equal(syntax.status, 0, syntax.stderr)
})

test('Step 7 verification covers functions, grants, privacy, and stored totals', async () => {
  const verification = await read(
    'supabase/verification/payroll_draft_calculation_check.sql'
  )

  assert.match(verification, /draft_calculator_exists_should_be_true/)
  assert.match(verification, /anon_can_calculate_should_be_false/)
  assert.match(verification, /authenticated_can_calculate_should_be_true/)
  assert.match(verification, /own_draft_record_policy_count_should_be_zero/)
  assert.match(verification, /record_total_mismatch_count_should_be_zero/)
  assert.match(verification, /negative_net_pay_count_should_be_zero/)
})
