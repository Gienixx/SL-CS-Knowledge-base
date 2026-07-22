import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath = 'supabase/migrations/20260722084820_harden_attendance_payroll_readiness.sql'
const aclMigrationPath = 'supabase/migrations/20260722084947_restrict_attendance_payroll_readiness_acl.sql'

test('Step 15 exposes payroll readiness and blocker codes through a secure view', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /workforce_attendance_payroll_readiness/)
  assert.match(migration, /security_invoker = true/)
  assert.match(migration, /is_payroll_ready/)
  assert.match(migration, /payroll_readiness_blockers/)
  assert.match(migration, /revoke all .* from public, anon/)
  assert.match(migration, /grant select .* to authenticated, service_role/)
})

test('Step 15 checks every payroll-readiness gate', async () => {
  const migration = await read(migrationPath)

  for (const blocker of [
    'missing_clock_in',
    'missing_clock_out',
    'missing_schedule',
    'schedule_employee_mismatch',
    'schedule_work_date_mismatch',
    'invalid_schedule_status',
    'calculations_missing',
    'total_worked_mismatch',
    'total_overtime_mismatch',
    'work_date_overtime_limit_exceeded',
    'invalid_attendance_status',
    'review_required'
  ]) {
    assert.match(migration, new RegExp(`'${blocker}'`))
  }

  assert.match(migration, /partition by attendance_row\.user_id, attendance_row\.work_date/)
  assert.match(migration, /not in \('approved', 'locked'\)/)
})

test('Step 15 verification is limited to the requested July 1-15 window', async () => {
  const verification = await read('supabase/verification/attendance_payroll_readiness_check.sql')

  assert.match(verification, /date '2026-07-01' and date '2026-07-15'/)
  assert.match(verification, /readiness_matches_blockers/)
  assert.match(verification, /readiness_view_acl_is_safe/)
})

test('payroll readiness is read-only for authenticated consumers', async () => {
  const migration = await read(aclMigrationPath)
  const verification = await read('supabase/verification/attendance_payroll_readiness_check.sql')

  assert.match(migration, /revoke all .*\s+from public, anon, authenticated, service_role/s)
  assert.match(migration, /grant select .*\s+to authenticated, service_role/s)
  assert.match(verification, /not has_table_privilege\('authenticated', c\.oid, 'update'\)/)
})
