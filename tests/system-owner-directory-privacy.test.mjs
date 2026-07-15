import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Employee Profiles requests only non-owner profiles and permissions', async () => {
  const script = await read('scripts/workforce.js')

  assert.match(script, /\.eq\('is_system_admin', false\)/)
  assert.match(script, /const visibleUserIds = visibleProfiles\.map/)
  assert.match(script, /\.in\('user_id', visibleUserIds\)/)
  assert.doesNotMatch(script, /select\('id, name, description, supervisor_id/)
})

test('canonical account mutation endpoints delegate owner protection to guarded database services', async () => {
  const [update, lifecycle, ownerGuard] = await Promise.all([
    read('functions/update-employee.js'),
    read('functions/employee-lifecycle.js'),
    read('supabase/migrations/20260714172911_protect_hidden_system_owner.sql')
  ])

  assert.match(update, /protected system owner/i)
  assert.match(lifecycle, /workforce_admin_change_employee_lifecycle/)
  assert.match(ownerGuard, /before update or delete on public\.profiles/)
})

test('database trigger protects the owner without removing permissions', async () => {
  const [migration, verification] = await Promise.all([
    read('supabase/migrations/20260714172911_protect_hidden_system_owner.sql'),
    read('supabase/verification/hidden_system_owner_check.sql')
  ])

  assert.match(migration, /old\.is_system_admin is true and auth\.uid\(\) is not null/)
  assert.match(migration, /before update or delete on public\.profiles/)
  assert.match(migration, /revoke all[\s\S]*from authenticated/)
  assert.match(migration, /system_owner_directory_hidden/)
  assert.match(verification, /granted_permissions/)
})
