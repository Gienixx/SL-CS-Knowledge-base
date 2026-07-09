import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  LEGACY_ADMIN_PERMISSION_KEYS,
  WORKFORCE_PERMISSION_KEYS,
  createLegacyWorkforceAccess,
  normalizeWorkforceAccess
} from '../shared/workforce-access.js'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath = 'supabase/migrations/2026070903_attendance_correction_permissions.sql'

test('Step 11 adds correction and approval to the explicit permission model', () => {
  assert.ok(WORKFORCE_PERMISSION_KEYS.includes('correct_attendance'))
  assert.ok(WORKFORCE_PERMISSION_KEYS.includes('approve_attendance'))

  assert.ok(!LEGACY_ADMIN_PERMISSION_KEYS.includes('correct_attendance'))
  assert.ok(!LEGACY_ADMIN_PERMISSION_KEYS.includes('approve_attendance'))
})

test('legacy admin compatibility does not grant payroll-sensitive attendance rights', () => {
  const access = createLegacyWorkforceAccess(
    {
      email: 'legacy-admin@example.com',
      name: 'Legacy Admin',
      is_admin: true,
      can_edit_articles: false
    },
    {
      user: {
        id: '00000000-0000-4000-8000-000000000001',
        email: 'legacy-admin@example.com'
      }
    }
  )

  assert.equal(access.permissions.view_team_attendance, true)
  assert.equal(access.permissions.correct_attendance, false)
  assert.equal(access.permissions.approve_attendance, false)
  assert.equal(access.can_correct_attendance, false)
  assert.equal(access.can_approve_attendance, false)
})

test('shared access normalization exposes both attendance permissions', () => {
  const access = normalizeWorkforceAccess(
    {
      user_id: '00000000-0000-4000-8000-000000000002',
      is_active: true,
      is_admin: true,
      base_role: 'admin',
      permissions: {
        correct_attendance: true,
        approve_attendance: true,
        manage_payroll: false
      }
    }
  )

  assert.equal(access.permissions.correct_attendance, true)
  assert.equal(access.permissions.approve_attendance, true)
  assert.equal(access.can_correct_attendance, true)
  assert.equal(access.can_approve_attendance, true)
  assert.equal(access.can_manage_payroll, false)
})

test('Workforce Management can assign both permissions independently from payroll', async () => {
  const page = await read('workforce.html')

  assert.match(page, /value="correct_attendance"/)
  assert.match(page, /value="approve_attendance"/)
  assert.match(page, />Correct attendance</)
  assert.match(page, />Approve attendance</)
  assert.match(page, /Payroll access does not include either permission/)
})

test('database migration accepts, publishes, and saves the new permission keys', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /permission_key in \([\s\S]*'correct_attendance'/)
  assert.match(migration, /permission_key in \([\s\S]*'approve_attendance'/)
  assert.match(migration, /'correct_attendance',[\s\S]*'approve_attendance'/)
  assert.match(migration, /'can_correct_attendance'/)
  assert.match(migration, /'can_approve_attendance'/)
  assert.match(migration, /p_permissions \? v_permission_key/)
})

test('correction and approval require an admin plus the specific explicit grant', async () => {
  const migration = await read(migrationPath)
  const authorizer = migration.match(
    /create or replace function public\.workforce_is_authorized_attendance_admin\([\s\S]*?\n\$\$;/
  )?.[0] || ''
  const correctionHelper = migration.match(
    /create or replace function public\.workforce_can_correct_attendance\([\s\S]*?\n\$\$;/
  )?.[0] || ''

  assert.match(authorizer, /workforce_current_user_is_active\(\)/)
  assert.match(authorizer, /workforce_is_admin\(\)/)
  assert.match(authorizer, /workforce_has_permission\(p_permission_key\)/)
  assert.doesNotMatch(authorizer, /manage_payroll/)
  assert.doesNotMatch(correctionHelper, /workforce_is_assigned_supervisor/)
})

test('non-admin targets are forced to lose correction and approval grants', async () => {
  const migration = await read(migrationPath)

  assert.match(
    migration,
    /v_permission_key in \('correct_attendance', 'approve_attendance'\)[\s\S]*not \(v_base_role = 'admin' or v_profile\.is_system_admin is true\)[\s\S]*v_is_granted := false/
  )
})

test('Step 11 includes deployment verification and documents the Step 12 boundary', async () => {
  const verification = await read('supabase/verification/attendance_correction_permissions_check.sql')
  const documentation = await read('docs/workforce-step-11-attendance-permissions.md')

  assert.match(verification, /Every blocker query in section 5 must return zero rows/)
  assert.match(verification, /supervisor_scope_does_not_grant_correction/)
  assert.match(verification, /payroll_permission_is_not_used/)
  assert.match(documentation, /Step 12 must use a security-definer correction RPC/)
})
