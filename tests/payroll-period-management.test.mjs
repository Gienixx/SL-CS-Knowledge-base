import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const migrationPath =
  'supabase/migrations/20260724095921_payroll_period_management.sql'

test('payroll periods are created through one authorized atomic workflow', async () => {
  const migration = await read(migrationPath)

  assert.match(
    migration,
    /create or replace function public\.payroll_create_period\(\s*p_period_start date,\s*p_period_end date,\s*p_payment_date date\s*\)/
  )
  assert.match(
    migration,
    /not public\.workforce_has_permission\('create_payroll'\)/
  )
  assert.match(migration, /pg_advisory_xact_lock/)
  assert.match(
    migration,
    /daterange\(period\.period_start, period\.period_end, '\[\]'\)[\s\S]*?&& daterange\(p_period_start, p_period_end, '\[\]'\)/
  )
  assert.match(migration, /insert into public\.payroll_periods/)
  assert.match(
    migration,
    /insert into public\.payroll_records[\s\S]*?profile\.is_agent is true[\s\S]*?profile\.employment_status in \('active', 'on_leave'\)/
  )
  assert.match(migration, /'payroll_period_created'/)
  assert.match(migration, /'attendance_imported', false/)
  assert.doesNotMatch(
    migration,
    /grant\s+insert\s+on\s+(?:table\s+)?public\.payroll_periods\s+to\s+authenticated/i
  )
})

test('overlap checks are available before create and enforced again during create', async () => {
  const [migration, page, script] = await Promise.all([
    read(migrationPath),
    read('payroll-dashboard.html'),
    read('scripts/payroll-dashboard.js')
  ])

  assert.match(
    migration,
    /create or replace function public\.payroll_check_period_overlap\(/
  )
  assert.match(
    migration,
    /create index if not exists payroll_periods_active_range_idx[\s\S]*?using gist/
  )
  assert.match(page, /id="payrollOverlapResult"/)
  assert.match(script, /supabase\.rpc\(\s*'payroll_check_period_overlap'/)
  assert.match(script, /await checkOverlap\(\)/)
  assert.match(script, /supabase\.rpc\('payroll_create_period'/)
})

test('payroll dashboard and period pages expose the complete Step 5 workflow', async () => {
  const [dashboard, period, dashboardScript, periodScript] = await Promise.all([
    read('payroll-dashboard.html'),
    read('payroll-period.html'),
    read('scripts/payroll-dashboard.js'),
    read('scripts/payroll-period.js')
  ])

  for (const id of [
    'payrollPeriodStart',
    'payrollPeriodEnd',
    'payrollPaymentDate',
    'createPayrollPeriodButton',
    'payrollPeriodList'
  ]) {
    assert.match(dashboard, new RegExp(`id="${id}"`))
  }

  for (const id of [
    'payrollEmployeeCount',
    'payrollRatesReadyCount',
    'payrollAttendanceReadyCount',
    'payrollAttentionCount',
    'payrollReadinessBody'
  ]) {
    assert.match(period, new RegExp(`id="${id}"`))
  }

  assert.match(
    dashboardScript,
    /supabase\.rpc\('payroll_get_period_dashboard'\)/
  )
  assert.match(
    periodScript,
    /supabase\.rpc\('payroll_get_period_employee_readiness'/
  )
  assert.match(
    period,
    /Imported counts show the current attendance versions preserved/
  )
  assert.doesNotMatch(period, /Hourly rate|Daily rate|Monthly rate|Salary/)
})

test('employee readiness identifies missing rates and incomplete attendance', async () => {
  const migration = await read(migrationPath)

  assert.match(
    migration,
    /create or replace function public\.payroll_get_period_employee_readiness\(/
  )
  assert.match(
    migration,
    /from public\.workforce_attendance_payroll_readiness as attendance_row/
  )
  assert.match(
    migration,
    /not attendance_row\.is_payroll_ready/
  )
  assert.match(
    migration,
    /'missing_clock_out' = any\(attendance_row\.payroll_readiness_blockers\)/
  )
  assert.match(
    migration,
    /'review_required' = any\(attendance_row\.payroll_readiness_blockers\)/
  )
  assert.match(
    migration,
    /not exists \(\s*select 1\s*from public\.agent_rates as rate[\s\S]*?rate\.effective_date <= attendance_row\.work_date/
  )
  assert.doesNotMatch(
    migration.match(
      /returns table \([\s\S]*?\)\s*language plpgsql\s*stable\s*security definer\s*set search_path = ''\s*as \$\$/
    )?.[0] || '',
    /hourly_rate|daily_rate|monthly_rate|overtime_rate|holiday_rate/
  )
})

test('missing attendance links open the exact employee and work date only for attendance viewers', async () => {
  const [migration, periodPage, periodScript, attendancePage, attendanceScript] =
    await Promise.all([
      read('supabase/migrations/20260724103215_payroll_missing_attendance_links.sql'),
      read('payroll-period.html'),
      read('scripts/payroll-period.js'),
      read('team-attendance.html'),
      read('scripts/team-attendance.js')
    ])

  assert.match(
    migration,
    /create or replace function public\.payroll_get_period_missing_attendance\(/
  )
  assert.match(
    migration,
    /not exists \([\s\S]*?attendance_row\.schedule_id = schedule\.id/
  )
  assert.match(
    migration,
    /revoke all on function public\.payroll_get_period_missing_attendance\(uuid\)[\s\S]*?from public, anon/
  )
  assert.doesNotMatch(migration, /hourly_rate|daily_rate|monthly_rate|salary/)

  assert.match(periodPage, /scripts\/payroll-period\.js\?v=3/)
  assert.match(
    periodScript,
    /supabase\.rpc\('payroll_get_period_missing_attendance'/
  )
  assert.match(
    periodScript,
    /state\.canViewAttendance = hasWorkforcePermission\(\s*access,\s*'view_team_attendance'/
  )
  assert.match(periodScript, /source: 'payroll-missing'/)
  assert.match(attendancePage, /scripts\/team-attendance\.js\?v=7/)
  assert.match(attendanceScript, /function payrollAttendanceLinkFilters\(\)/)
  assert.match(
    attendanceScript,
    /elements\.employeeFilter\.value = linkedFilters\.employee/
  )
})

test('payroll pages require explicit processing permissions and Home hides the link', async () => {
  const [dashboardScript, periodScript, home, homeNavigation] =
    await Promise.all([
      read('scripts/payroll-dashboard.js'),
      read('scripts/payroll-period.js'),
      read('home.html'),
      read('scripts/home-workforce-nav.js')
    ])

  for (const script of [dashboardScript, periodScript]) {
    assert.match(script, /const PROCESS_PERMISSIONS = \[/)
    assert.match(script, /'create_payroll'/)
    assert.match(script, /'review_payroll'/)
    assert.match(script, /'finalize_payroll'/)
    assert.match(script, /'reopen_payroll'/)
    assert.doesNotMatch(script, /access\.is_admin\s*===\s*true/)
  }

  assert.match(
    home,
    /id="homePayrollDashboardBtn"[\s\S]*?href="\.\/payroll-dashboard\.html"[\s\S]*?hidden/
  )
  assert.match(home, /home-workforce-nav\.js\?v=5/)
  assert.match(
    homeNavigation,
    /canAccessPayrollDashboard = \[[\s\S]*?'create_payroll'[\s\S]*?\.some\(permission => hasWorkforcePermission\(access, permission\)\)/
  )
  assert.match(
    homeNavigation,
    /payrollDashboardButton\.hidden = !canAccessPayrollDashboard/
  )
})

test('payroll period browser modules have valid JavaScript syntax', async () => {
  for (const path of [
    'scripts/payroll-dashboard.js',
    'scripts/payroll-period.js'
  ]) {
    const result = spawnSync(process.execPath, ['--check', path], {
      cwd: new URL('../', import.meta.url),
      encoding: 'utf8'
    })
    assert.equal(result.status, 0, result.stderr)
  }
})

test('payroll period verification covers permissions, overlaps, and audit evidence', async () => {
  const verification = await read(
    'supabase/verification/payroll_period_management_check.sql'
  )

  assert.match(verification, /Every blocker query in section 3 must return zero rows/)
  assert.match(
    verification,
    /authenticated_can_insert_periods_should_be_false/
  )
  assert.match(verification, /anon_can_create_period_should_be_false/)
  assert.match(
    verification,
    /daterange\(earlier\.period_start, earlier\.period_end, '\[\]'\)[\s\S]*?&& daterange\(later\.period_start, later\.period_end, '\[\]'\)/
  )
  assert.match(verification, /audit\.action = 'payroll_period_created'/)
})
