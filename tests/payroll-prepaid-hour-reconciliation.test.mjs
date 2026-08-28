import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath =
  'supabase/migrations/20260728053329_payroll_prepaid_hour_reconciliation.sql'

test('future paid time cannot be inserted as completed live attendance', async () => {
  const migration = await read(migrationPath)

  assert.match(
    migration,
    /create or replace function public\.workforce_reject_future_attendance_timestamps\(\)/
  )
  assert.match(migration, /statement_timestamp\(\) \+ interval '5 minutes'/)
  assert.match(
    migration,
    /before insert or update of clock_in, clock_out on public\.attendance/
  )
  assert.match(migration, /Use a payroll pre-plot for prepaid hours/)
})

test('approved ordinary schedule snapshots create one prepaid balance', async () => {
  const migration = await read(migrationPath)

  assert.match(
    migration,
    /create or replace function public\.payroll_create_prepaid_balance\(\)/
  )
  assert.match(
    migration,
    /new\.is_rest_day[\s\S]*?new\.is_holiday[\s\S]*?new\.scheduled_minutes <= 0/
  )
  assert.match(
    migration,
    /insert into public\.payroll_prepaid_hours[\s\S]*?new\.scheduled_minutes/
  )
  assert.match(
    migration,
    /on conflict \(source_schedule_snapshot_id\) do nothing/
  )
  assert.match(
    migration,
    /after insert on public\.payroll_schedule_snapshots/
  )
  assert.match(
    migration,
    /settled_minutes > 0[\s\S]*?cannot be reapproved/
  )
  assert.match(migration, /superseded_by_id = v_new_prepaid_hour_id/)
})

test('approved attendance settles prepaid minutes FIFO and carries shortfalls', async () => {
  const migration = await read(migrationPath)

  assert.match(
    migration,
    /create or replace function public\.payroll_reconcile_prepaid_hours\(\)/
  )
  assert.match(
    migration,
    /\('regular'::text, new\.regular_minutes\)/
  )
  assert.match(migration, /\('pre_shift_overtime'::text, new\.pre_shift_overtime_minutes\)/)
  assert.match(migration, /\('post_shift_overtime'::text, new\.post_shift_overtime_minutes\)/)
  assert.match(
    migration,
    /source_snapshot\.work_date <= new\.work_date/
  )
  assert.match(
    migration,
    /order by\s*source_snapshot\.work_date,\s*prepaid\.created_at,\s*prepaid\.id/
  )
  assert.match(
    migration,
    /least\(v_available_minutes, v_balance\.remaining_minutes\)/
  )
  assert.match(
    migration,
    /settled_minutes = settled_minutes \+ v_allocated_minutes/
  )
  assert.match(
    migration,
    /new\.special_day_type <> 'ordinary'[\s\S]*?new\.is_rest_day[\s\S]*?new\.is_holiday/
  )
  assert.match(migration, /new\.regular_minutes/)
})

test('canonical billed duration is imported for prepaid reconciliation', async () => {
  const [reconciliation, importFix] = await Promise.all([
    read(migrationPath),
    read('supabase/migrations/20260828082817_fix_prepaid_import_canonical_timestamps.sql')
  ])

  assert.match(reconciliation, /new\.regular_minutes/)
  assert.match(reconciliation, /least\(v_available_minutes, v_balance\.remaining_minutes\)/)
  assert.match(importFix, /coalesce\(source\.billed_clock_in, source\.captured_clock_in\)/)
  assert.match(importFix, /coalesce\(source\.billed_clock_out, source\.captured_clock_out\)/)
})

test('new attendance versions reverse prior allocations before recalculation', async () => {
  const migration = await read(migrationPath)

  assert.match(
    migration,
    /allocation\.allocation_type = 'settlement'[\s\S]*?not exists \([\s\S]*?reversal\.reverses_allocation_id = allocation\.id/
  )
  assert.match(migration, /'reversal'/)
  assert.match(
    migration,
    /settled_minutes - v_previous_allocation\.allocated_minutes/
  )
  assert.match(
    migration,
    /after insert on public\.payroll_attendance_snapshots/
  )
})

test('payroll admins can review balances without exposing rates', async () => {
  const [migration, page, script] = await Promise.all([
    read(migrationPath),
    read('payroll-period.html'),
    read('scripts/payroll-period.js')
  ])

  assert.match(
    migration,
    /create or replace function public\.payroll_get_period_prepaid_hours\(/
  )
  assert.match(migration, /workforce_has_permission\('create_payroll'\)/)
  assert.match(
    migration,
    /revoke all on function public\.payroll_get_period_prepaid_hours\(uuid\)[\s\S]*?from public, anon/
  )
  assert.doesNotMatch(
    migration.match(
      /create or replace function public\.payroll_get_period_prepaid_hours\([\s\S]*?\nend;\n\$\$;/
    )?.[0] || '',
    /hourly_rate|daily_rate|monthly_rate|salary/
  )

  assert.match(page, /id="payrollPreplotRemainingHours"/)
  assert.match(page, /Actual approved hours settle the oldest balance first/)
  assert.match(script, /safePayrollRpc\('prepaidBalances', 'payroll_get_period_prepaid_hours'/)
  assert.match(script, /remaining_minutes/)
  assert.match(script, /rendered ·/)
})

test('light theme gives payroll pre-plot row text readable semantic colors', async () => {
  const theme = await read('styles/payroll-periods.css')

  assert.match(theme, /html\[data-site-theme="light"\] \.payroll-preplot-table/)
  assert.match(theme, /color: #17233f/)
  assert.match(theme, /color: #4f6178/)
  assert.match(theme, /\.payroll-employee-cell strong[\s\S]*?payroll-preplot-shift/)
  assert.match(theme, /\.payroll-employee-cell small[\s\S]*?payroll-cell-note[\s\S]*?payroll-prepaid-balance-note/)
  assert.match(theme, /\.payroll-prepaid-review-link[\s\S]*?color: #155a92/)
  assert.match(theme, /html\[data-site-theme="dark"\] \.payroll-preplot-table/)
})

test('updated payroll period browser module has valid JavaScript syntax', () => {
  const result = spawnSync(
    process.execPath,
    ['--check', 'scripts/payroll-period.js'],
    {
      cwd: new URL('../', import.meta.url),
      encoding: 'utf8'
    }
  )

  assert.equal(result.status, 0, result.stderr)
})
