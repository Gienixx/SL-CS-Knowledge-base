import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath =
  'supabase/migrations/20260727122715_complete_payroll_period_preplot_approval.sql'

test('Step 5 supports controlled early payment with a documented override', async () => {
  const [migration, page, script] = await Promise.all([
    read(migrationPath),
    read('payroll-dashboard.html'),
    read('scripts/payroll-dashboard.js')
  ])

  assert.match(
    migration,
    /add column early_payment_window_days integer not null default 3/
  )
  assert.match(
    migration,
    /early_payment_days integer generated always as \(\s*period_end - payment_date/
  )
  assert.match(
    migration,
    /check \(payment_date <= period_end\)/
  )
  assert.match(
    migration,
    /v_early_payment_days > 3 and v_override_reason is null/
  )
  assert.match(migration, /'early_payment_override', v_override_reason is not null/)
  assert.match(page, /id="payrollEarlyPaymentReason"/)
  assert.match(page, /id="payrollPaymentTimingResult"/)
  assert.match(script, /const STANDARD_EARLY_PAYMENT_DAYS = 3/)
  assert.match(script, /p_early_payment_override_reason:/)
  assert.doesNotMatch(
    script,
    /Payment date cannot be before the payroll end date/
  )
})

test('pre-plot candidates are limited to post-payment schedules in the period', async () => {
  const migration = await read(migrationPath)

  assert.match(
    migration,
    /create function public\.payroll_get_preplot_candidates\(/
  )
  assert.match(
    migration,
    /schedule\.shift_date > v_period\.payment_date[\s\S]*?schedule\.shift_date <= v_period\.period_end/
  )
  assert.match(
    migration,
    /schedule\.status in \('published', 'changed'\)/
  )
  assert.match(migration, /and not schedule\.is_rest_day/)
  assert.match(migration, /and not schedule\.is_holiday/)
  assert.match(
    migration,
    /schedule\.shift_start is not null[\s\S]*?schedule\.shift_end is not null/
  )
  assert.match(
    migration,
    /snapshot\.schedule_version = schedule\.schedule_version/
  )
  assert.doesNotMatch(
    migration.match(
      /create function public\.payroll_get_preplot_candidates\([\s\S]*?\nend;\n\$\$;/
    )?.[0] || '',
    /hourly_rate|daily_rate|monthly_rate|overtime_rate|holiday_rate/
  )
})

test('pre-plot approval snapshots trusted current schedule values atomically', async () => {
  const migration = await read(migrationPath)

  assert.match(
    migration,
    /create function public\.payroll_approve_preplots\([\s\S]*?p_schedule_ids uuid\[\][\s\S]*?p_approval_reason text/
  )
  assert.match(migration, /workforce_has_permission\('create_payroll'\)/)
  assert.match(migration, /pg_advisory_xact_lock/)
  assert.match(
    migration,
    /from public\.work_schedules as schedule[\s\S]*?order by schedule\.id[\s\S]*?for update/
  )
  assert.match(
    migration,
    /insert into public\.payroll_schedule_snapshots[\s\S]*?schedule\.schedule_version[\s\S]*?schedule\.updated_at/
  )
  assert.match(migration, /'payroll_preplots_approved'/)
  assert.match(migration, /v_period\.status not in \('draft', 'reopened'\)/)
  assert.match(migration, /schedule\.is_rest_day[\s\S]*?prepaid-hour debt/)
  assert.match(
    migration,
    /schedule\.is_holiday[\s\S]*?Guaranteed special days do not create prepaid-hour debt/
  )
})

test('approved current pre-plots do not remain missing-attendance blockers', async () => {
  const migration = await read(migrationPath)

  assert.match(
    migration,
    /create function public\.payroll_get_period_employee_readiness\([\s\S]*?adjusted_missing_attendance_count/
  )
  assert.match(
    migration,
    /create function public\.payroll_get_period_missing_attendance\([\s\S]*?payroll_schedule_snapshots/
  )
  assert.match(
    migration,
    /create function public\.payroll_get_period_exceptions\([\s\S]*?issue\.exception_code <> 'missing_attendance'/
  )
  assert.match(
    migration,
    /snapshot\.schedule_version = schedule\.schedule_version/
  )
})

test('payroll period page exposes explicit batch approval without pay rates', async () => {
  const [page, script] = await Promise.all([
    read('payroll-period.html'),
    read('scripts/payroll-period.js')
  ])

  for (const id of [
    'payrollPreplotBody',
    'payrollPreplotEligibleCount',
    'payrollPreplotSelectedCount',
    'payrollPreplotApprovedCount',
    'payrollPreplotReason',
    'approvePayrollPreplotsButton'
  ]) {
    assert.match(page, new RegExp(`id="${id}"`))
  }

  assert.match(
    script,
    /supabase\.rpc\('payroll_get_preplot_candidates'/
  )
  assert.match(
    script,
    /supabase\.rpc\('payroll_approve_preplots'/
  )
  assert.match(script, /state\.canApprovePreplots = hasWorkforcePermission\(/)
  assert.match(script, /'create_payroll'/)
  assert.doesNotMatch(page, /Hourly rate|Daily rate|Monthly rate|Salary/)
})

test('new privileged RPCs deny anonymous execution', async () => {
  const migration = await read(migrationPath)

  for (const signature of [
    'public.payroll_get_preplot_candidates\\(uuid\\)',
    'public.payroll_approve_preplots\\(uuid, uuid\\[\\], text\\)'
  ]) {
    assert.match(
      migration,
      new RegExp(`revoke all on function ${signature}[\\s\\S]*?from public, anon`)
    )
  }

  assert.doesNotMatch(
    migration,
    /grant\s+(?:insert|update|delete)\s+on\s+(?:table\s+)?public\.payroll_schedule_snapshots\s+to\s+authenticated/i
  )
})

test('Step 5 verification covers timing, snapshot integrity, and audit evidence', async () => {
  const verification = await read(
    'supabase/verification/payroll_period_preplot_approval_check.sql'
  )

  assert.match(verification, /Every query in section 3 must return zero rows/)
  assert.match(verification, /payment_date > period_end/)
  assert.match(
    verification,
    /early_payment_days > early_payment_window_days/
  )
  assert.match(
    verification,
    /authenticated_can_insert_snapshots_should_be_false/
  )
  assert.match(
    verification,
    /schedule\.schedule_version\s*=\s*snapshot\.schedule_version/
  )
  assert.match(verification, /action = 'payroll_preplots_approved'/)
})
