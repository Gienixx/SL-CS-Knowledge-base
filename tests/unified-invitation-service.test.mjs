import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('invitation is server-owned and hides temporary credentials', async () => {
  const [endpoint, browser] = await Promise.all([
    read('functions/create-user.js'),
    read('scripts/workforce.js')
  ])

  assert.match(endpoint, /requireWorkforcePermission/)
  assert.match(endpoint, /manage_employees/)
  assert.match(endpoint, /auth\/v1\/invite/)
  assert.match(endpoint, /workforce_service_create_invitation/)
  assert.match(endpoint, /deleteAuthUser/)
  assert.doesNotMatch(endpoint, /password\s*:/)
  assert.doesNotMatch(browser, /resetPasswordForEmail\(\s*email/)
  assert.doesNotMatch(browser, /password:\s*createTemporaryCredential/)
})

test('transactional provisioning creates the complete invited employee contract', async () => {
  const migration = await read(
    'supabase/migrations/20260715123908_unified_invitation_service.sql'
  )

  assert.match(migration, /security definer/i)
  assert.match(migration, /to service_role/i)
  assert.match(migration, /from public, anon, authenticated/i)
  assert.match(migration, /'SL-'\s*\|\|/)
  assert.match(migration, /onboarding_status[\s\S]*'invited'/i)
  assert.match(migration, /insert into public\.login/i)
  assert.match(migration, /insert into public\.workforce_identity_links/i)
  assert.match(migration, /foreach v_permission_key/i)
  assert.match(migration, /'employee_invited'/)
})
