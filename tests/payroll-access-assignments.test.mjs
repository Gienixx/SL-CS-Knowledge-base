import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationUrl = new URL(
  '../supabase/migrations/20260723061950_assign_payroll_access.sql',
  import.meta.url
)

test('payroll access is assigned only to Almar and the protected system administrator', async () => {
  const migration = await readFile(migrationUrl, 'utf8')

  assert.match(migration, /lower\(profile\.email\) = 'almar@eurekasurveys\.com'/)
  assert.match(migration, /profile\.is_system_admin is true/)
  assert.match(migration, /v_approved_count <> 2/)

  for (const permissionKey of [
    'manage_agent_rates',
    'create_payroll',
    'review_payroll',
    'finalize_payroll',
    'view_all_payslips',
    'view_own_payslips',
    'export_payslips',
    'reopen_payroll'
  ]) {
    assert.match(migration, new RegExp(`'${permissionKey}'`))
  }
})

test('rates and employee payroll reads use explicit RLS permissions and identity scope', async () => {
  const migration = await readFile(migrationUrl, 'utf8')

  assert.match(
    migration,
    /create policy "Payroll rate managers can view rates"[\s\S]*workforce_has_permission\('manage_agent_rates'\)/
  )
  assert.match(
    migration,
    /create policy "Authorized users can view payroll records"[\s\S]*view_own_payslips[\s\S]*workforce_is_current_identity\(employee_id\)/
  )
  assert.match(
    migration,
    /create policy "Authorized users can view payslips"[\s\S]*view_own_payslips[\s\S]*workforce_is_current_identity\(employee_id\)/
  )
})

test('payroll assignment does not grant attendance correction', async () => {
  const migration = await readFile(migrationUrl, 'utf8')
  const permissionInsert = migration.match(
    /payroll_permissions\(permission_key\) as \(([\s\S]*?)\)\s*insert into public\.user_permissions/
  )?.[1] || ''

  assert.doesNotMatch(permissionInsert, /correct_attendance/)
  assert.match(migration, /'attendance_permission_implied', false/)
})
