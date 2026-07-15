import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Step 7 adds protected employee lifecycle actions without deleting workforce history', async () => {
  const [migration, endpoint, client, middleware, verification] = await Promise.all([
    read('supabase/migrations/20260715134940_employee_lifecycle_actions.sql'),
    read('functions/employee-lifecycle.js'),
    read('scripts/workforce.js'),
    read('functions/_middleware.js'),
    read('supabase/verification/employee_lifecycle_actions_check.sql')
  ])

  assert.match(migration, /workforce_admin_change_employee_lifecycle/)
  assert.match(migration, /is_system_admin[\s\S]*cannot be deactivated or deleted/i)
  assert.match(migration, /p_user_id = auth\.uid\(\)/)
  assert.match(migration, /employment_status = v_after_status/)
  assert.doesNotMatch(migration, /delete\s+from\s+public\.(attendance|user_schedules|workforce_audit_logs)/i)
  assert.match(endpoint, /should_soft_delete=true/)
  assert.match(endpoint, /confirmation !== 'DELETE'/)
  assert.match(client, /'Deactivate', 'deactivate'/)
  assert.match(client, /'Reactivate', 'reactivate'/)
  assert.match(client, /'Delete account', 'delete'/)
  assert.match(middleware, /'\/employee-lifecycle'/)
  assert.match(verification, /deleted_system_owners/)
})
