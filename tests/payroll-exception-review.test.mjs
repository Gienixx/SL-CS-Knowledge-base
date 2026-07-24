import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const migrationPath =
  'supabase/migrations/20260724114356_payroll_exception_review.sql'

test('exception review covers every required Step 8 category', async () => {
  const migration = await read(migrationPath)

  for (const code of [
    'missing_rate',
    'incomplete_attendance',
    'unapproved_attendance',
    'missing_clock_out',
    'overtime_above_limit',
    'duplicate_attendance',
    'overlapping_schedules',
    'payroll_period_overlap',
    'changed_attendance_after_import'
  ]) {
    assert.match(migration, new RegExp(`'${code}'::text`))
  }

  assert.match(
    migration,
    /max\(snapshot\.attendance_version\) as attendance_version/
  )
  assert.match(migration, /having count\(\*\) > 1/)
  assert.match(migration, /tstzrange\([\s\S]*?\) && tstzrange\(/)
  assert.match(migration, /daterange\([\s\S]*?\) && daterange\(/)
  assert.match(
    migration,
    /snapshot\.attendance_version < attendance_row\.attendance_version/
  )
})

test('exception RPC is payroll-permission scoped and does not return rates', async () => {
  const migration = await read(migrationPath)
  const signature = migration.match(
    /returns table \([\s\S]*?\)\s*language plpgsql\s*stable\s*security definer/
  )?.[0] || ''

  assert.match(
    migration,
    /create or replace function public\.payroll_get_period_exceptions\(\s*p_payroll_period_id uuid\s*\)/
  )
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
    /hourly_rate|daily_rate|monthly_rate|overtime_rate|holiday_rate/
  )
})

test('payroll period displays filterable exceptions and permission-safe actions', async () => {
  const [page, script, styles] = await Promise.all([
    read('payroll-period.html'),
    read('scripts/payroll-period.js'),
    read('styles/payroll-periods.css')
  ])

  for (const id of [
    'payrollExceptionReviewTitle',
    'payrollExceptionFilter',
    'payrollExceptionCount',
    'payrollExceptionBody'
  ]) {
    assert.match(page, new RegExp(`id="${id}"`))
  }

  assert.match(page, /scripts\/payroll-period\.js\?v=4/)
  assert.match(page, /styles\/payroll-periods\.css\?v=4/)
  assert.match(
    script,
    /supabase\.rpc\('payroll_get_period_exceptions'/
  )
  assert.match(
    script,
    /state\.canManageRates = hasWorkforcePermission\(\s*access,\s*'manage_agent_rates'/
  )
  assert.match(
    script,
    /state\.canViewAttendance[\s\S]*?teamAttendanceUrl\(issue\.employee_user_id, issue\.work_date\)/
  )
  assert.match(script, /issue\.exception_code === 'payroll_period_overlap'/)
  assert.match(styles, /\.payroll-exception-table/)
  assert.match(styles, /\.payroll-exception-severity\.blocking/)

  const syntax = spawnSync(process.execPath, ['--check', 'scripts/payroll-period.js'], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8'
  })
  assert.equal(syntax.status, 0, syntax.stderr)
})

test('Step 8 verification checks function access and live exception evidence', async () => {
  const verification = await read(
    'supabase/verification/payroll_exception_review_check.sql'
  )

  assert.match(
    verification,
    /exception_review_rpc_exists_should_be_true/
  )
  assert.match(
    verification,
    /anon_can_review_exceptions_should_be_false/
  )
  assert.match(
    verification,
    /authenticated_can_review_exceptions_should_be_true/
  )
  assert.match(
    verification,
    /select \*[\s\S]*?from public\.payroll_get_period_exceptions/
  )
})
