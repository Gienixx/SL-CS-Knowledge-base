import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('identity migration creates auditable Auth-to-profile links', async () => {
  const migration = await read('supabase/migrations/2026070705_workforce_identity_links.sql')

  assert.match(migration, /create table if not exists public\.workforce_identity_links/)
  assert.match(migration, /primary key \(auth_user_id, profile_user_id\)/)
  assert.match(migration, /'auth_user_id'/)
  assert.match(migration, /'exact_email'/)
  assert.match(migration, /'unique_name_alias'/)
  assert.match(migration, /local_part_auth_count = 1/)
})

test('self-service helpers use linked identities instead of raw auth UID only', async () => {
  const migration = await read('supabase/migrations/2026070705_workforce_identity_links.sql')

  assert.match(migration, /function public\.workforce_is_current_identity/)
  assert.match(migration, /identity_link\.auth_user_id = auth\.uid\(\)/)
  assert.match(migration, /workforce_is_current_identity\(p_target_user_id\)/)
  assert.match(migration, /workforce_is_current_identity\(profile\.user_id\)/)
  assert.match(migration, /Users can view permitted work schedules/)
})

test('new login records synchronize exact identity links', async () => {
  const migration = await read('supabase/migrations/2026070705_workforce_identity_links.sql')

  assert.match(migration, /function public\.workforce_sync_identity_link_from_login/)
  assert.match(migration, /zz_login_workforce_identity_link/)
  assert.match(migration, /after insert or update of email on public\.login/)
})

test('current access payload and browser normalization expose linked profile IDs', async () => {
  const [migration, accessModule] = await Promise.all([
    read('supabase/migrations/2026070705_workforce_identity_links.sql'),
    read('shared/workforce-access.js')
  ])

  assert.match(migration, /'linked_profile_ids', v_linked_profile_ids/)
  assert.match(migration, /'auth_user_id', v_auth_user_id/)
  assert.match(accessModule, /linked_profile_ids: linkedProfileIds/)
  assert.match(accessModule, /auth_user_id: data\.auth_user_id/)
})

test('verification covers missing exact links, safe aliases, policies, and execution privileges', async () => {
  const verification = await read('supabase/verification/workforce_identity_links_check.sql')

  assert.match(verification, /Exact Auth\/profile links missing/)
  assert.match(verification, /Safe legacy alias links missing/)
  assert.match(verification, /Multi-profile identities/)
  assert.match(verification, /Published schedules attached to a linked non-Auth UUID/)
  assert.match(verification, /anon_cannot_execute_identity_helper/)
})
