import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationPath = 'supabase/migrations/20260722105109_ensure_internal_test_access_matrix.sql'
const verificationPath = 'supabase/verification/internal_test_access_matrix_check.sql'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('internal test deployment has all six required access categories', async () => {
  const verification = await read(verificationPath)

  for (const category of [
    'regular_agent',
    'agent_editor',
    'admin_agent',
    'admin_only',
    'supervisor',
    'payroll_authorized'
  ]) {
    assert.match(verification, new RegExp(`'${category}'`))
  }

  assert.match(verification, /where candidate_count = 0/)
  assert.match(verification, /has_auth_user/)
})

test('supervisor test access is explicit and excludes payroll-sensitive changes', async () => {
  const migration = await read(migrationPath)
  const verification = await read(verificationPath)
  const grantedPermissions = migration.match(
    /foreach v_permission in array array\[([\s\S]*?)\] loop/
  )?.[1] || ''

  assert.match(grantedPermissions, /'manage_schedules'/)
  assert.match(grantedPermissions, /'view_team_attendance'/)
  assert.match(grantedPermissions, /'approve_leave'/)
  assert.doesNotMatch(grantedPermissions, /'correct_attendance'/)
  assert.doesNotMatch(grantedPermissions, /'approve_attendance'/)
  assert.doesNotMatch(grantedPermissions, /'manage_payroll'/)
  assert.match(verification, /not correct_attendance/)
  assert.match(verification, /not approve_attendance/)
  assert.match(verification, /not manage_payroll/)
})

test('internal test supervisor assignment is deterministic and audited', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /team\.name = 'Test Team'/)
  assert.match(migration, /v_candidate_count <> 1/)
  assert.match(migration, /internal_test_supervisor_scope_prepared/)
  assert.match(migration, /workforce_audit_logs/)
})
