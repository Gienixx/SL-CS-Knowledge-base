import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('onboarding lifecycle remains separate from employment status', async () => {
  const migration = await read('supabase/migrations/20260715071028_add_onboarding_lifecycle.sql')

  assert.match(migration, /add column if not exists onboarding_status text/)
  assert.match(migration, /onboarding_status in \('invited', 'active'\)/)
  assert.match(migration, /add column if not exists invited_at timestamptz/)
  assert.match(migration, /add column if not exists invited_by uuid/)
  assert.match(migration, /add column if not exists activated_at timestamptz/)
  assert.match(migration, /add column if not exists invitation_last_sent_at timestamptz/)
  assert.doesNotMatch(migration, /set employment_status\s*=/)
})

test('existing profiles are activated and new profiles default to invited', async () => {
  const migration = await read('supabase/migrations/20260715071028_add_onboarding_lifecycle.sql')

  assert.match(migration, /set onboarding_status = 'active'/)
  assert.match(migration, /alter column onboarding_status set default 'invited'/)
  assert.match(migration, /alter column onboarding_status set not null/)
  assert.match(migration, /workforce_set_onboarding_timestamps/)
})

test('invited profiles are rejected by the shared workforce gate', async () => {
  const [migration, verification] = await Promise.all([
    read('supabase/migrations/20260715071028_add_onboarding_lifecycle.sql'),
    read('supabase/verification/onboarding_lifecycle_check.sql')
  ])

  assert.match(migration, /create or replace function public\.workforce_current_user_is_active\(\)/)
  assert.match(migration, /profile\.employment_status in \('active', 'on_leave'\)[\s\S]*profile\.onboarding_status = 'active'/)
  assert.match(verification, /shared workforce access gate does not require onboarding activation/i)
})
