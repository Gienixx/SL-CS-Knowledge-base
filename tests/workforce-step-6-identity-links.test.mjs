import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Step 6 explicitly verifies workforce identity-link table security', async () => {
  const [migration, identityVerification, step6SecurityCheck] = await Promise.all([
    read('supabase/migrations-legacy/2026070705_workforce_identity_links.sql'),
    read('supabase/verification/workforce_identity_links_check.sql'),
    read('supabase/verification/workforce_identity_links_security_check.sql')
  ])

  assert.match(migration, /create table if not exists public\.workforce_identity_links/i)
  assert.match(migration, /alter table public\.workforce_identity_links enable row level security/i)
  assert.match(migration, /revoke all on table public\.workforce_identity_links from anon/i)
  assert.match(migration, /revoke all on table public\.workforce_identity_links from authenticated/i)
  assert.match(migration, /revoke execute on function public\.workforce_is_current_identity\(uuid\) from anon/i)
  assert.match(migration, /grant execute on function public\.workforce_is_current_identity\(uuid\) to authenticated/i)

  assert.match(identityVerification, /Exact Auth\/profile links missing: should return 0 rows/i)
  assert.match(identityVerification, /Orphaned or inactive links: should return 0 rows/i)
  assert.match(identityVerification, /anon_cannot_execute_identity_helper/i)

  assert.match(step6SecurityCheck, /public\.workforce_identity_links/)
  assert.match(step6SecurityCheck, /relrowsecurity/)
  assert.match(step6SecurityCheck, /has_table_privilege/)
  assert.match(step6SecurityCheck, /'anon'/)
  assert.match(step6SecurityCheck, /'authenticated'/)
  assert.match(step6SecurityCheck, /public\.workforce_is_current_identity\(uuid\)/)
  assert.match(step6SecurityCheck, /should return 0 rows/gi)
  assert.match(step6SecurityCheck, /rollback;/i)
})
