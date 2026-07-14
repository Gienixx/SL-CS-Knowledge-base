import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('ownership transfer targets the verified dedicated admin identity', async () => {
  const migration = await read('supabase/migrations/20260714160959_transfer_system_ownership_to_admin.sql')

  assert.match(migration, /arby\.benito10@gmail\.com/)
  assert.match(migration, /SL-7859DCC5/)
  assert.match(migration, /7859dcc5-7a77-4850-bc91-1db5d9e0dd90/)
  assert.match(migration, /arby@eurekasurveys\.com/)
  assert.match(migration, /SL-F69A9E68/)
  assert.match(migration, /f69a9e68-5507-4132-af60-e7cc1255d8c2/)
})

test('ownership transfer revokes the employee owner override and grants the admin account', async () => {
  const migration = await read('supabase/migrations/20260714160959_transfer_system_ownership_to_admin.sql')

  assert.match(migration, /set is_system_admin = false,[\s\S]*base_role = 'agent'/)
  assert.match(migration, /set is_system_admin = true,[\s\S]*base_role = 'admin'/)
  assert.match(migration, /update public\.user_permissions[\s\S]*set is_granted = false/)
  assert.match(migration, /'manage_employees'[\s\S]*'manage_payroll'/)
  assert.match(migration, /system_ownership_transferred/)
})

test('database enforces exactly one active protected owner', async () => {
  const migration = await read('supabase/migrations/20260714160959_transfer_system_ownership_to_admin.sql')

  assert.match(migration, /create unique index if not exists profiles_single_system_owner_idx/)
  assert.match(migration, /create constraint trigger profiles_require_single_active_system_owner/)
  assert.match(migration, /deferrable initially deferred/)
  assert.match(migration, /Exactly one active system owner is required/)
  assert.match(migration, /revoke all on function public\.workforce_require_single_active_system_owner\(\) from authenticated/)
})

test('ownership transfer includes verification and a manual rollback', async () => {
  const [verification, rollback] = await Promise.all([
    read('supabase/verification/system_ownership_transfer_check.sql'),
    read('supabase/rollback/20260714160959_restore_arby_system_ownership.sql')
  ])

  assert.match(verification, /active_system_owners/)
  assert.match(verification, /profiles_single_system_owner_idx/)
  assert.match(verification, /system_ownership_transferred/)
  assert.match(rollback, /system_ownership_transfer_rolled_back/)
  assert.match(rollback, /set is_system_admin = true,[\s\S]*base_role = 'agent'/)
})
