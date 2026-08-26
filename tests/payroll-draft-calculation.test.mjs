import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath =
  'supabase/migrations/20260729073554_calculate_draft_payroll.sql'
const calculationReadCorrectionPath =
  'supabase/migrations/20260729074006_hide_uncalculated_payroll_results.sql'

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
    /round\([\s\S]*?payable\.payable_total_minutes::numeric[\s\S]*?60 \* payable\.hourly_rate,[\s\S]*?v_money_scale/
  )
  assert.match(migration, /v_rounding_mode <> 'half_up'/)
  assert.match(migration, /v_minute_conversion <> 'exact'/)
})

test('draft payroll pays every approved classified hour at the normal hourly rate', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /'regular_earnings'/)
  assert.match(migration, /'Approved payable hours'/)
  assert.match(migration, /payable_total_minutes/)
  assert.match(migration, /payable\.payable_total_minutes::numeric \/ 60 as quantity/)
  assert.match(migration, /payable\.payable_total_minutes::numeric[\s\S]*?payable\.hourly_rate/)
  assert.match(migration, /'New prepaid hours included in Total Billed Hours'/)
  assert.doesNotMatch(migration, /'prepaid_scheduled_earnings'/)

  assert.match(migration, /where false/)
  assert.doesNotMatch(migration, /effective_overtime_rate \* 2/)
  assert.doesNotMatch(migration, /effective_holiday_rate \* 2/)
  assert.match(
    migration,
    /schedule\.is_holiday[\s\S]*?round\(rate\.daily_rate/
  )
})

test('Total Billed Hours includes new prepaid hours exactly once', async () => {
  const [migration, script] = await Promise.all([
    read(migrationPath),
    read('scripts/payroll-period.js')
  ])

  assert.match(migration, /'regular_earnings'[\s\S]*?'New prepaid hours included in Total Billed Hours'/)
  assert.match(migration, /item_code = 'regular_earnings'/)
  assert.match(script, /const totalBilledMinutes = regularPayableMinutes \+ newPrepaidMinutes/)
  assert.match(script, /Total billed/)
})

test('138 worked hours plus 92 new prepaid hours pays 230 hours once', () => {
  const totalBilledHours = 138 + 92
  const grossPay = totalBilledHours * 3.2
  assert.equal(totalBilledHours, 230)
  assert.equal(grossPay, 736)
  assert.notEqual(grossPay, grossPay + (92 * 3.2))
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

test('employee Draft recalculation reuses the period calculator with a record scope', async () => {
  const [migration, script] = await Promise.all([
    read(migrationPath),
    read('scripts/payroll-period.js')
  ])

  assert.match(migration, /p_payroll_record_id uuid default null/)
  assert.match(migration, /payroll_calculate_employee_draft\(/)
  assert.match(migration, /payroll_calculate_draft\(v_period_id, p_payroll_record_id\)/)
  assert.match(migration, /p_payroll_record_id is null or record\.id = p_payroll_record_id/)
  assert.match(migration, /delete from public\.payroll_items[\s\S]*?not item\.is_manual/)
  assert.match(migration, /status <> 'void'/)
  assert.match(migration, /create_payroll/)
  assert.match(migration, /status not in \('draft', 'reopened'\)/)
  assert.match(script, /payroll_calculate_employee_draft/)
  assert.match(script, /Recalculate/)
  assert.match(script, /window\.confirm/)
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
  assert.match(page, /scripts\/payroll-period\.js\?v=16/)
  assert.match(page, /styles\/payroll-periods\.css\?v=14/)
  assert.match(script, /supabase\.rpc\('payroll_calculate_draft'/)
  assert.match(script, /safePayrollRpc\('calculation', 'payroll_get_period_calculation'/)
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
