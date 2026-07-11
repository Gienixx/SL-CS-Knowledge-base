import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(
  new URL('../supabase/migrations-legacy/2026070702_workforce_admin_payroll_access.sql', import.meta.url),
  'utf8'
)

const verification = await readFile(
  new URL('../supabase/verification/workforce_admin_payroll_access_check.sql', import.meta.url),
  'utf8'
)

test('visible and hidden administrators always receive payroll access', () => {
  assert.match(migration, /new\.base_role = 'admin' or new\.is_system_admin is true/)
  assert.match(migration, /new\.can_manage_payroll := true/)
  assert.match(migration, /'manage_payroll'/)
  assert.match(migration, /Automatically granted to administrator/)
})

test('existing administrators are backfilled', () => {
  assert.match(migration, /update public\.profiles[\s\S]*can_manage_payroll = true/)
  assert.match(migration, /where base_role = 'admin'[\s\S]*or is_system_admin is true/)
  assert.match(migration, /on conflict \(user_id, permission_key\) do update[\s\S]*is_granted = true/)
})

test('verification blocks administrators without payroll access', () => {
  assert.match(verification, /Blocker: should return 0 rows/)
  assert.match(verification, /profile\.can_manage_payroll is not true/)
  assert.match(verification, /permission\.is_granted is not true/)
})
