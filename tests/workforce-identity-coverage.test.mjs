import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('coverage migration applies to every current site login', async () => {
  const migration = await read('supabase/migrations/2026070706_workforce_identity_coverage.sql')

  assert.match(migration, /from public\.login login_user/)
  assert.match(migration, /join auth\.users auth_user/)
  assert.match(migration, /Unlinked site account\(s\)/)
  assert.doesNotMatch(migration, /arby@|test@/i)
})

test('coverage migration blocks active workforce record owners without an Auth link', async () => {
  const migration = await read('supabase/migrations/2026070706_workforce_identity_coverage.sql')

  assert.match(migration, /public\.work_schedules/)
  assert.match(migration, /public\.attendance/)
  assert.match(migration, /public\.leave_requests/)
  assert.match(migration, /Unlinked workforce-record owner\(s\)/)
})

test('future profile changes synchronize exact links and disable stale email links', async () => {
  const migration = await read('supabase/migrations/2026070706_workforce_identity_coverage.sql')

  assert.match(migration, /function public\.workforce_sync_identity_link_from_profile/)
  assert.match(migration, /match_method = 'exact_email'/)
  assert.match(migration, /set is_active = false/)
  assert.match(migration, /profiles_workforce_identity_link/)
  assert.match(migration, /after insert or update of email on public\.profiles/)
})

test('identity linking does not change employment status', async () => {
  const migration = await read('supabase/migrations/2026070706_workforce_identity_coverage.sql')

  assert.doesNotMatch(migration, /set employment_status/)
  assert.doesNotMatch(migration, /employment_status\s*=\s*'active'/)
})

test('verification reports every account and requires zero unresolved or ambiguous rows', async () => {
  const verification = await read('supabase/verification/workforce_identity_coverage_check.sql')

  assert.match(verification, /Every site Auth account and its active links/)
  assert.match(verification, /Unlinked site accounts: must return 0 rows/)
  assert.match(verification, /Active workforce-record owners without an Auth link: must return 0 rows/)
  assert.match(verification, /Ambiguous inferred aliases: must return 0 rows/)
})
