import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const migrationPaths = [
  'supabase/migrations/20260724112455_payroll_attendance_import.sql',
  'supabase/migrations/20260808090150_payroll_import_billed_timestamps.sql',
  'supabase/migrations/20260808090459_payroll_import_billed_snapshot_fields.sql',
  'supabase/migrations/20260808090955_employee_scoped_payroll_attendance_reimport.sql',
  'supabase/migrations/20260808093641_latest_snapshot_recalculation_transition.sql'
]

const readImportMigrations = () => Promise.all(migrationPaths.map(read)).then(parts => parts.join('\n'))

test('attendance receives a monotonic payroll source version', async () => {
  const migration = await readImportMigrations()

  assert.match(
    migration,
    /alter table public\.attendance\s+add column attendance_version bigint not null default 1/
  )
  assert.match(
    migration,
    /create or replace function public\.workforce_increment_attendance_version\(\)/
  )
  assert.match(
    migration,
    /new\.attendance_version := old\.attendance_version \+ 1/
  )
  assert.match(
    migration,
    /create trigger attendance_increment_version\s+before update on public\.attendance/
  )
})

test('payroll attendance snapshots are append-only and versioned', async () => {
  const migration = await readImportMigrations()

  assert.match(
    migration,
    /unique \(payroll_record_id, attendance_id, attendance_version\)/
  )
  assert.match(
    migration,
    /create trigger payroll_attendance_snapshots_immutable\s+before update or delete/
  )
  assert.match(
    migration,
    /message = 'Payroll attendance snapshots are immutable\.'/
  )
})

test('attendance import accepts only payroll-ready records through an authorized RPC', async () => {
  const migration = await readImportMigrations()

  assert.match(
    migration,
    /create (?:or replace )?function public\.payroll_import_attendance\(\s*p_payroll_period_id uuid[\s\S]*?p_payroll_record_id uuid default null/
  )
  assert.match(
    migration,
    /not public\.workforce_has_permission\('create_payroll'\)/
  )
  assert.match(migration, /v_period\.status not in \('draft', 'reopened'\)/)
  assert.match(migration, /pg_advisory_xact_lock/)
  assert.match(
    migration,
    /join public\.workforce_attendance_payroll_readiness as readiness[\s\S]*?readiness\.is_payroll_ready/
  )
  assert.match(
    migration,
    /insert into public\.payroll_attendance_snapshots \([\s\S]*?attendance_version,[\s\S]*?attendance_updated_at,[\s\S]*?imported_at/
  )
  assert.match(
    migration,
    /on conflict \(\s*payroll_record_id,\s*attendance_id,\s*attendance_version\s*\) do nothing/
  )
  assert.match(migration, /'payroll_attendance_imported'/)
  assert.doesNotMatch(
    migration,
    /hourly_rate|daily_rate|monthly_rate|overtime_rate|holiday_rate/
  )
})

test('employee attendance reimport reuses the import body with a Draft-only record scope', async () => {
  const migration = await readImportMigrations()

  assert.match(migration, /payroll_import_employee_attendance\(\s*p_payroll_record_id uuid\s*\)/)
  assert.match(migration, /payroll_import_attendance\(v_period_id, p_payroll_record_id\)/)
  assert.match(migration, /p_payroll_record_id is null or record\.id = p_payroll_record_id/)
  assert.match(migration, /selected_record\.status not in \('finalized', 'void'\)/)
  assert.match(migration, /billed_clock_in,\s*billed_clock_out,/)
  assert.match(migration, /source\.billed_clock_in,\s*source\.billed_clock_out,/)
  assert.match(migration, /payroll_import_employee_attendance\(uuid\)[\s\S]*?to authenticated, service_role/)
})

test('employee reimport clears only the stale recalculation flag after latest snapshots match', async () => {
  const migration = await readImportMigrations()

  assert.match(migration, /set\s+requires_recalculation\s*=\s*false/)
  assert.match(migration, /readiness\.is_payroll_ready/)
  assert.match(
    migration,
    /snapshot\.attendance_id = attendance_row\.id[\s\S]*?snapshot\.attendance_version = attendance_row\.attendance_version/
  )
  assert.match(migration, /and not exists \([\s\S]*?payroll_attendance_snapshots as snapshot/)
  assert.match(migration, /record\.status not in \('finalized', 'void'\)/)
})

test('attendance import snapshots approved billed timestamps only', async () => {
  const [importMigration, readinessMigration] = await Promise.all([
    readImportMigrations(),
    read('supabase/migrations/20260722084820_harden_attendance_payroll_readiness.sql')
  ])

  assert.match(readinessMigration, /clock_in is null then 'missing_clock_in'/)
  assert.match(readinessMigration, /clock_out is null then 'missing_clock_out'/)
  assert.match(readinessMigration, /review_status not in \('approved', 'locked'\)/)
  assert.match(importMigration, /attendance_row\.billed_clock_in as billed_clock_in/)
  assert.match(importMigration, /attendance_row\.billed_clock_out as billed_clock_out/)
  assert.match(importMigration, /source\.billed_clock_in/)
  assert.match(importMigration, /source\.billed_clock_out/)
  assert.doesNotMatch(importMigration, /source\.original_clock_in|source\.original_clock_out/)
})

test('changed attendance flags only non-finalized payroll for recalculation', async () => {
  const migration = await readImportMigrations()

  assert.match(
    migration,
    /create or replace function public\.payroll_flag_changed_attendance\(\)/
  )
  assert.match(
    migration,
    /snapshot\.attendance_version < new\.attendance_version/
  )
  assert.match(
    migration,
    /period\.status not in \('finalized', 'void'\)/
  )
  assert.match(
    migration,
    /record\.status not in \('finalized', 'void'\)/
  )
  assert.match(migration, /requires_recalculation = true/)
  assert.match(
    migration,
    /'payroll_attendance_changed_after_import'/
  )
})

test('payroll period page imports and displays snapshot status', async () => {
  const [page, script, styles] = await Promise.all([
    read('payroll-period.html'),
    read('scripts/payroll-period.js'),
    read('styles/payroll-periods.css')
  ])

  for (const id of [
    'importPayrollAttendanceButton',
    'payrollCurrentSnapshotCount',
    'payrollImportedEmployeeCount',
    'payrollRecalculationFlagCount',
    'payrollImportStatus'
  ]) {
    assert.match(page, new RegExp(`id="${id}"`))
  }

  assert.match(page, /scripts\/payroll-period\.js\?v=16/)
  assert.match(page, /styles\/payroll-periods\.css\?v=14/)
  assert.match(
    script,
    /safePayrollRpc\('importStatus', 'payroll_get_period_attendance_import_status'/
  )
  assert.match(script, /supabase\.rpc\('payroll_import_attendance'/)
  assert.match(
    script,
    /state\.canImportAttendance = hasWorkforcePermission\(\s*access,\s*'create_payroll'/
  )
  assert.match(styles, /\.payroll-import-stats/)

  const syntax = spawnSync(process.execPath, ['--check', 'scripts/payroll-period.js'], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8'
  })
  assert.equal(syntax.status, 0, syntax.stderr)
})

test('employee attendance refresh imports only the selected record before recalculation', async () => {
  const script = await read('scripts/payroll-period.js')

  assert.match(
    script,
    /refreshEmployeeAttendanceAndRecalculate[\s\S]*?supabase\.rpc\(\s*'payroll_import_employee_attendance',[\s\S]*?p_payroll_record_id: payrollRecordId[\s\S]*?\)[\s\S]*?supabase\.rpc\(\s*'payroll_calculate_employee_draft'/
  )
  assert.match(script, /if \(importError\)[\s\S]*?return/)
  assert.match(
    script,
    /state\.refreshingEmployee \|\|[\s\S]*?state\.canImportAttendance[\s\S]*?state\.canCalculatePayroll/
  )
  assert.match(script, /Only this employee will be refreshed\./)
  assert.match(script, /Historical snapshots remain preserved/)
  assert.match(script, /payroll will not be approved or finalized/)
  assert.match(script, /dataset\.payrollAction = 'refresh-employee'/)
  assert.match(script, /state\.canImportAttendance &&[\s\S]*?state\.canCalculatePayroll/)
  assert.match(script, /supabase\.rpc\('payroll_import_attendance'/)
  const employeeRefresh = script.slice(
    script.indexOf('async function refreshEmployeeAttendanceAndRecalculate'),
    script.indexOf('function renderAdjustments')
  )
  assert.doesNotMatch(employeeRefresh, /payroll_import_attendance\s*'/)
})

test('Step 6 verification checks security, immutability, and stale flags', async () => {
  const verification = await read(
    'supabase/verification/payroll_attendance_import_check.sql'
  )

  assert.match(verification, /Every blocker query in section 3 must return zero rows/)
  assert.match(
    verification,
    /anon_can_import_attendance_should_be_false/
  )
  assert.match(
    verification,
    /snapshot_mutation_trigger_enabled_should_be_true/
  )
  assert.match(
    verification,
    /unflagged_changed_attendance_should_be_empty/
  )
})
