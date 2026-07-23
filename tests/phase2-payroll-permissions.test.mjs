import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  PAYROLL_PERMISSION_KEYS,
  WORKFORCE_PERMISSION_KEYS,
  createPermissionMap,
  hasWorkforcePermission
} from '../shared/workforce-access.js'

const expectedPayrollPermissions = [
  'manage_agent_rates',
  'create_payroll',
  'review_payroll',
  'finalize_payroll',
  'view_all_payslips',
  'view_own_payslips',
  'export_payslips',
  'reopen_payroll'
]

test('registers all Phase 2 payroll permissions without treating them as defaults', () => {
  assert.deepEqual(PAYROLL_PERMISSION_KEYS, expectedPayrollPermissions)

  const permissions = createPermissionMap()
  for (const permissionKey of expectedPayrollPermissions) {
    assert.equal(WORKFORCE_PERMISSION_KEYS.includes(permissionKey), true)
    assert.equal(permissions[permissionKey], false)
    assert.equal(
      hasWorkforcePermission({ allowed: true, permissions }, permissionKey),
      false
    )
  }
})

test('administrator invitation defaults do not auto-select payroll access', async () => {
  const workforceScript = await readFile(
    new URL('../scripts/workforce.js', import.meta.url),
    'utf8'
  )
  const defaultBlock = workforceScript.match(
    /const adminPermissions = new Set\(\[([\s\S]*?)\]\)/
  )?.[1] || ''

  for (const permissionKey of [...expectedPayrollPermissions, 'manage_payroll']) {
    assert.doesNotMatch(defaultBlock, new RegExp(`['"]${permissionKey}['"]`))
  }
})

test('employee permission forms expose every granular payroll permission', async () => {
  const workforcePage = await readFile(
    new URL('../workforce.html', import.meta.url),
    'utf8'
  )

  for (const permissionKey of expectedPayrollPermissions) {
    const matches = workforcePage.match(
      new RegExp(`value="${permissionKey}"`, 'g')
    ) || []
    assert.equal(matches.length, 2)
  }
})

test('legacy payroll trigger helpers are not exposed as browser RPCs', async () => {
  const migration = await readFile(
    new URL(
      '../supabase/migrations/20260723055652_secure_payroll_permission_helpers.sql',
      import.meta.url
    ),
    'utf8'
  )

  assert.match(
    migration,
    /workforce_sync_admin_payroll_permission\(\)[\s\S]*from public, anon, authenticated/
  )
  assert.match(
    migration,
    /workforce_enforce_admin_payroll_profile\(\)[\s\S]*from public, anon, authenticated/
  )
})
