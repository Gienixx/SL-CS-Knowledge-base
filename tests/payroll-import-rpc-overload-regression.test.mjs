import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const migrationPath =
  'supabase/migrations/20260829180057_payroll_import_attendance_unambiguous_api.sql'

test('full-period attendance import has one unambiguous public RPC', async () => {
  const [migration, verification, script] = await Promise.all([
    read(migrationPath),
    read('supabase/verification/payroll_attendance_import_check.sql'),
    read('scripts/payroll-period.js')
  ])

  assert.match(
    migration,
    /'public\.payroll_import_attendance\(uuid,uuid\)'::regprocedure/
  )
  assert.match(migration, /public\.payroll_import_attendance_for_record\(/)
  assert.match(migration, /' DEFAULT NULL::uuid'/)
  assert.match(migration, /drop function public\.payroll_import_attendance\(uuid, uuid\)/)
  assert.match(
    migration,
    /create or replace function public\.payroll_import_attendance\(\s*p_payroll_period_id uuid\s*\)/
  )
  assert.match(
    verification,
    /to_regprocedure\('public\.payroll_import_attendance\(uuid,uuid\)'\) is null/
  )
  assert.match(
    verification,
    /to_regprocedure\('public\.payroll_import_attendance_for_record\(uuid,uuid\)'\) is not null/
  )
  assert.match(
    script,
    /supabase\.rpc\('payroll_import_attendance',\s*\{\s*p_payroll_period_id: state\.periodId\s*\}\)/
  )
})

test('record-specific attendance import remains available through distinct RPC names', async () => {
  const migration = await read(migrationPath)

  assert.match(
    migration,
    /public\.payroll_import_attendance_for_record\(/
  )
  assert.match(
    migration,
    /return public\.payroll_import_attendance_for_record\(v_period_id, p_payroll_record_id\)/
  )
  assert.match(
    migration,
    /grant execute on function public\.payroll_import_attendance_for_record\(uuid, uuid\)\s+to authenticated, service_role/
  )
})

test('the RPC migration preserves import authorization, idempotency, and reconciliation contracts', async () => {
  const [migration, importMigrations, prepaidMigration] = await Promise.all([
    read(migrationPath),
    read('supabase/migrations/20260808093641_latest_snapshot_recalculation_transition.sql'),
    read('supabase/migrations/20260728053329_payroll_prepaid_hour_reconciliation.sql')
  ])

  assert.match(migration, /security definer/)
  assert.match(migration, /to authenticated, service_role/)
  assert.match(importMigrations, /workforce_has_permission\('create_payroll'\)/)
  assert.match(importMigrations, /on conflict \(\s*payroll_record_id,\s*attendance_id,\s*attendance_version\s*\) do nothing/)
  assert.match(importMigrations, /attendance_row\.attendance_version/)
  assert.match(prepaidMigration, /create trigger payroll_attendance_snapshot_reconcile_prepaid_hours\s+after insert on public\.payroll_attendance_snapshots/)
  assert.match(prepaidMigration, /payroll_reconcile_prepaid_hours/)
  assert.doesNotMatch(migration, /insert into public\.(?:payroll_attendance_snapshots|payroll_hour_allocations|payroll_prepaid_hours)/)
})
