import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const migrationPath =
  'supabase/migrations/20260727092358_align_agent_payslip_permissions.sql'

test('all current and future agents receive own-payslip access', async () => {
  const migration = await read(migrationPath)

  assert.match(
    migration,
    /create or replace function public\.payroll_sync_agent_own_payslip_permission\(\)/
  )
  assert.match(
    migration,
    /after insert or update of is_agent[\s\S]*on public\.profiles/
  )
  assert.match(
    migration,
    /where profile\.is_agent is true[\s\S]*on conflict \(user_id, permission_key\) do update[\s\S]*is_granted = true/
  )
  assert.match(
    migration,
    /new\.permission_key = 'view_own_payslips'[\s\S]*new\.is_granted := true/
  )
})

test('payslip export is restricted to approved payroll administrators', async () => {
  const migration = await read(migrationPath)

  assert.match(
    migration,
    /new\.permission_key = 'export_payslips'[\s\S]*new\.is_granted/
  )
  assert.match(migration, /profile\.is_system_admin is true/)
  assert.match(migration, /lower\(profile\.email\) = 'almar@eurekasurveys\.com'/)
  assert.match(
    migration,
    /permission\.permission_key in \(\s*'finalize_payroll',\s*'view_all_payslips'\s*\)/
  )
  assert.match(
    migration,
    /message = 'Payslip export is restricted to approved payroll administrators\.'/
  )
  assert.match(
    migration,
    /update public\.user_permissions as permission[\s\S]*permission\.permission_key = 'export_payslips'[\s\S]*permission\.is_granted is true/
  )
})

test('agent printing does not imply bulk payslip export', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /'scope', 'own_finalized_payslips'/)
  assert.match(migration, /'export_implied', false/)
  assert.match(migration, /'own_payslip_printing_affected', false/)
})

test('verification checks own access, export scope, triggers, and RLS', async () => {
  const verification = await read(
    'supabase/verification/agent_payslip_permissions_check.sql'
  )

  assert.match(
    verification,
    /agents_without_own_payslip_access_should_be_empty/
  )
  assert.match(
    verification,
    /unauthorized_payslip_export_grants_should_be_empty/
  )
  assert.match(
    verification,
    /profiles_sync_agent_own_payslip_permission/
  )
  assert.match(
    verification,
    /tablename = 'payslips'/
  )
})
