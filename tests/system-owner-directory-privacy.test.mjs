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

test('User Management omits the protected owner on the server', async () => {
  const listUsers = await read('functions/list-users.js')

  assert.match(listUsers, /function getSystemOwnerEmail/)
  assert.match(listUsers, /is_system_admin', 'eq\.true'/)
  assert.match(listUsers, /filter\(loginUser => normalizeEmail\(loginUser\.email\) !== systemOwnerEmail\)/)
})

test('legacy account mutation endpoints reject the protected owner', async () => {
  const [settings, remove] = await Promise.all([
    read('functions/user-settings.js'),
    read('functions/remove-account.js')
  ])

  assert.match(settings, /function isProtectedSystemOwner/)
  assert.match(settings, /protected system owner cannot be viewed or changed/)
  assert.match(remove, /function isProtectedSystemOwner/)
  assert.match(remove, /protected system owner cannot be deleted/)
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
