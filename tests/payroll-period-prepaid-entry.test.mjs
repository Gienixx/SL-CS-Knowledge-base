import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(path, 'utf8')
const migrationPath =
  'supabase/migrations/20260728162713_complete_payroll_prepaid_entry.sql'

test('prepaid entry uses a secured payroll RPC and never writes attendance', async () => {
  const migration = await read(migrationPath)

  assert.match(
    migration,
    /create function public\.payroll_save_and_approve_prepaid_schedule\(/
  )
  assert.match(migration, /security definer\s+set search_path = ''/)
  assert.match(
    migration,
    /not public\.workforce_has_permission\('create_payroll'\)/
  )
  assert.match(
    migration,
    /public\.workforce_can_manage_user\(\s*p_employee_id,\s*'manage_schedules'/
  )
  assert.doesNotMatch(migration, /insert into public\.attendance\b/)
  assert.match(
    migration,
    /Attendance already exists for this employee and date\. Import approved attendance instead\./
  )
  assert.match(
    migration,
    /revoke all on function public\.payroll_save_and_approve_prepaid_schedule\([\s\S]*?from public, anon/
  )
  assert.match(
    migration,
    /grant execute on function public\.payroll_save_and_approve_prepaid_schedule\([\s\S]*?to authenticated, service_role/
  )
})

test('prepaid entry preserves an exact approved schedule version with audit logs', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /insert into public\.work_schedules/)
  assert.match(
    migration,
    /insert into public\.payroll_schedule_snapshots/
  )
  assert.match(migration, /schedule_version/)
  assert.match(
    migration,
    /'payroll_prepaid_source_schedule_' \|\| v_schedule_action/
  )
  assert.match(migration, /'payroll_preplots_approved'/)
  assert.match(migration, /'entry_mode', 'payroll_prepaid_form'/)
  assert.match(
    migration,
    /Another prepaid schedule is already approved for this employee and date\./
  )
})

test('payroll period exposes the permission-aware prepaid schedule form', async () => {
  const [html, script] = await Promise.all([
    read('payroll-period.html'),
    read('scripts/payroll-period.js')
  ])

  for (const id of [
    'addPayrollPrepaidButton',
    'payrollPrepaidEmployee',
    'payrollPrepaidDate',
    'payrollPrepaidLogin',
    'payrollPrepaidLogout',
    'payrollPrepaidTimezone',
    'payrollPrepaidApprovalReason',
    'savePayrollPrepaidButton'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`))
  }

  assert.match(
    script,
    /hasWorkforcePermission\(\s*access,\s*'manage_schedules'/
  )
  assert.match(
    script,
    /supabase\.rpc\(\s*'payroll_save_and_approve_prepaid_schedule'/
  )
  assert.match(
    script,
    /A schedule manager must create it before payroll can approve prepaid hours\./
  )
  assert.match(
    script,
    /No attendance entry was created\./
  )
})
