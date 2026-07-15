import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const expectedPermissions = [
  'manage_employees',
  'manage_schedules',
  'view_team_attendance',
  'approve_leave',
  'view_workforce_reports',
  'edit_articles',
  'manage_payroll'
]

test('Arby migration preserves the visible Regular Agent role and enables hidden owner access', async () => {
  const migration = await read('supabase/migrations-legacy/2026070704_arby_full_access.sql')

  assert.match(migration, /base_role\s*=\s*'agent'/)
  assert.match(migration, /is_agent\s*=\s*true/)
  assert.match(migration, /is_system_admin\s*=\s*true/)
  assert.match(migration, /can_edit_articles\s*=\s*true/)
  assert.match(migration, /can_manage_payroll\s*=\s*true/)
  assert.match(migration, /employment_status\s*=\s*'active'/)
})

test('Arby migration grants every current workforce permission and legacy admin compatibility', async () => {
  const migration = await read('supabase/migrations-legacy/2026070704_arby_full_access.sql')

  for (const permission of expectedPermissions) {
    assert.match(migration, new RegExp(`'${permission}'`))
  }

  assert.match(migration, /set is_admin\s*=\s*true/)
  assert.match(migration, /can_edit_articles\s*=\s*true/)
  assert.match(migration, /v_permission_count\s*<>\s*7/)
})

test('Arby identity resolution is deterministic and aborts on missing or ambiguous matches', async () => {
  const migration = await read('supabase/migrations-legacy/2026070704_arby_full_access.sql')

  assert.match(migration, /count\(distinct profile\.user_id\)/)
  assert.match(migration, /v_candidate_count\s*<>\s*1/)
  assert.match(migration, /requires exactly one profile/)
  assert.doesNotMatch(migration, /@[a-z0-9.-]+\.[a-z]{2,}/i)
})

test('verification checks profile, permissions, login compatibility, and audit evidence', async () => {
  const verification = await read('supabase/verification/arby_full_access_check.sql')

  assert.match(verification, /Profile attribute blocker/)
  assert.match(verification, /Permission blocker/)
  assert.match(verification, /Login compatibility blocker/)
  assert.match(verification, /granted_permission_count/)
  assert.match(verification, /arby_full_access_assignment/)
})

test('frontend access normalization derives the visible type from canonical role and agent fields', async () => {
  const accessModule = await read('shared/workforce-access.js')

  assert.doesNotMatch(accessModule, /if \(isSystemAdmin\) \{\s*return 'regular_agent'/)
  assert.match(accessModule, /const isAdmin = isActive && \([\s\S]*isSystemAdmin/)
})
