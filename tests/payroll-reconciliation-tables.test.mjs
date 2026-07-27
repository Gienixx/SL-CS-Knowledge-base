import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const migrationPath =
  'supabase/migrations/20260727105739_extend_payroll_reconciliation_tables.sql'
const indexMigrationPath =
  'supabase/migrations/20260727110511_index_payroll_foreign_keys.sql'

test('adds a monotonic schedule version for exact payroll snapshots', async () => {
  const migration = await read(migrationPath)

  assert.match(
    migration,
    /alter table public\.work_schedules\s+add column schedule_version bigint not null default 1/
  )
  assert.match(
    migration,
    /new\.schedule_version := old\.schedule_version \+ 1/
  )
  assert.match(
    migration,
    /create trigger work_schedules_increment_version\s+before update on public\.work_schedules/
  )
})

test('creates the three employee-safe prepaid reconciliation tables', async () => {
  const migration = await read(migrationPath)

  for (const tableName of [
    'payroll_schedule_snapshots',
    'payroll_prepaid_hours',
    'payroll_hour_allocations'
  ]) {
    assert.match(
      migration,
      new RegExp(`create table public\\.${tableName} \\(`)
    )
    assert.match(
      migration,
      new RegExp(`alter table public\\.${tableName} enable row level security`)
    )
  }

  assert.match(
    migration,
    /foreign key \(payroll_record_id, employee_id\)[\s\S]*?references public\.payroll_records\(id, employee_id\)/
  )
  assert.match(
    migration,
    /foreign key \(\s*source_schedule_snapshot_id,\s*source_payroll_record_id,\s*employee_id\s*\)[\s\S]*?references public\.payroll_schedule_snapshots/
  )
  assert.match(
    migration,
    /foreign key \(\s*attendance_snapshot_id,\s*destination_payroll_record_id,\s*employee_id\s*\)[\s\S]*?references public\.payroll_attendance_snapshots/
  )
})

test('prepaid balances derive remaining minutes and status consistently', async () => {
  const migration = await read(migrationPath)

  assert.match(
    migration,
    /remaining_minutes integer generated always as \(\s*prepaid_minutes - settled_minutes\s*\) stored/
  )
  assert.match(
    migration,
    /status text generated always as \([\s\S]*?'partially_settled'[\s\S]*?\) stored/
  )
  assert.match(
    migration,
    /prepaid_minutes > 0[\s\S]*?settled_minutes <= prepaid_minutes/
  )
  assert.match(
    migration,
    /create index payroll_prepaid_hours_employee_fifo_idx[\s\S]*?where voided_at is null and settled_minutes < prepaid_minutes/
  )
})

test('allocations are append-only and exclude guaranteed special-day minutes', async () => {
  const migration = await read(migrationPath)

  for (const category of [
    'regular',
    'pre_shift_overtime',
    'post_shift_overtime'
  ]) {
    assert.match(migration, new RegExp(`'${category}'`))
  }
  assert.doesNotMatch(
    migration.match(
      /constraint payroll_hour_allocations_category_check[\s\S]*?\)\s*,/
    )?.[0] || '',
    /rest_day|holiday/
  )
  assert.match(
    migration,
    /allocation_type in \('settlement', 'reversal'\)/
  )
  assert.match(
    migration,
    /create trigger payroll_hour_allocations_immutable\s+before update or delete/
  )
})

test('attendance snapshots preserve special-day detail from the exact source version', async () => {
  const migration = await read(migrationPath)

  for (const column of [
    'rest_day_overtime_minutes',
    'holiday_overtime_minutes',
    'is_rest_day',
    'is_holiday',
    'special_day_type'
  ]) {
    assert.match(migration, new RegExp(`add column ${column}`))
  }

  assert.match(
    migration,
    /attendance_row\.attendance_version = new\.attendance_version/
  )
  assert.match(
    migration,
    /create trigger payroll_attendance_snapshot_capture_special_details\s+before insert/
  )
})

test('browser roles cannot write reconciliation tables', async () => {
  const migration = await read(migrationPath)

  for (const tableName of [
    'payroll_schedule_snapshots',
    'payroll_prepaid_hours',
    'payroll_hour_allocations'
  ]) {
    assert.match(
      migration,
      new RegExp(
        `revoke all on table public\\.${tableName}[\\s\\S]*?from public, anon, authenticated`
      )
    )
    assert.match(
      migration,
      new RegExp(`grant select on table public\\.${tableName} to authenticated`)
    )
  }

  assert.match(
    migration,
    /workforce_has_permission\('create_payroll'\)/
  )
  assert.match(
    migration,
    /workforce_has_permission\('review_payroll'\)/
  )
  assert.match(
    migration,
    /workforce_has_permission\('finalize_payroll'\)/
  )
  assert.match(
    migration,
    /workforce_has_permission\('reopen_payroll'\)/
  )
})

test('Step 1 verification checks tables, security, triggers, and integrity', async () => {
  const verification = await read(
    'supabase/verification/payroll_reconciliation_tables_check.sql'
  )

  assert.match(verification, /Every blocker query in section 5 must return zero rows/)
  assert.match(verification, /schedule_snapshots_table_should_be_true/)
  assert.match(verification, /authenticated_schedule_write_blocked_should_be_true/)
  assert.match(verification, /schedule_snapshot_immutable_should_be_true/)
  assert.match(verification, /unknown_special_snapshot_count/)
})

test('all payroll foreign keys reported by the advisor receive covering indexes', async () => {
  const migration = await read(indexMigrationPath)

  for (const indexName of [
    'agent_rates_created_by_idx',
    'payroll_periods_created_by_idx',
    'payroll_periods_approved_by_idx',
    'payroll_periods_finalized_by_idx',
    'payroll_periods_reopened_by_idx',
    'payroll_records_calculated_by_idx',
    'payroll_records_reviewed_by_idx',
    'payroll_items_snapshot_idx',
    'payroll_items_created_by_idx',
    'payroll_attendance_snapshots_schedule_idx',
    'payslips_generated_by_idx',
    'payroll_schedule_snapshots_record_employee_idx',
    'payroll_prepaid_hours_source_composite_idx',
    'payroll_hour_allocations_prepaid_employee_idx',
    'payroll_hour_allocations_attendance_record_employee_idx'
  ]) {
    assert.match(migration, new RegExp(`create index ${indexName}`))
  }
})
