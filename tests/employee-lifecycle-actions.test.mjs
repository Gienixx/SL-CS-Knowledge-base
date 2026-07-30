import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Step 7 adds protected employee lifecycle actions without deleting workforce history', async () => {
  const [migration, endpoint, client, middleware, verification] = await Promise.all([
    read('supabase/migrations/20260715141155_employee_lifecycle_actions.sql'),
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
  assert.doesNotMatch(endpoint, /should_soft_delete=true/)
  assert.match(endpoint, /auth\/v1\/admin\/users/)
  assert.match(endpoint, /allowNotFound: true/)
  assert.match(endpoint, /confirmation !== 'DELETE'/)
  assert.match(client, /'Deactivate', 'deactivate'/)
  assert.match(client, /'Reactivate', 'reactivate'/)
  assert.match(client, /'Delete account', 'delete'/)
  assert.match(client, /Reinvite employee/)
  assert.doesNotMatch(client, /\.is\('account_deleted_at', null\)/)
  assert.match(middleware, /'\/employee-lifecycle'/)
  assert.match(verification, /deleted_system_owners/)
})

test('deleting an account releases its email while retaining workforce history', async () => {
  const migration = await read(
    'supabase/migrations/20260730173046_release_deleted_employee_email.sql'
  )

  assert.match(migration, /v_deleted_email := 'deleted-' \|\| replace\(p_user_id::text, '-', ''\) \|\| '@deleted\.invalid'/)
  assert.match(migration, /delete from public\.login[\s\S]*lower\(email\) = lower\(v_profile\.email\)/)
  assert.match(migration, /update public\.workforce_identity_links[\s\S]*where profile_user_id = p_user_id/)
  assert.match(migration, /email_released/)
  assert.match(migration, /where account_deleted_at is not null/)
  assert.doesNotMatch(migration, /delete from public\.profiles/)
})

test('lifecycle cleanup cannot indirectly update the protected owner', async () => {
  const fix = await read('supabase/migrations/20260715142943_fix_lifecycle_owner_supervisor_cleanup.sql')
  assert.match(fix, /where is_system_admin is true[\s\S]*supervisor_id is not null/)
  assert.match(fix, /where supervisor_id = p_user_id[\s\S]*is_system_admin is false/)
  assert.match(fix, /system_owner_reporting_hierarchy_corrected/)
})
