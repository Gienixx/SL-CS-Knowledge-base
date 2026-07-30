import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const migrationPath =
  'supabase/migrations/20260730093130_add_payroll_employee_eligibility.sql'

test('payroll eligibility is separate from workforce account status', async () => {
  const migration = await read(migrationPath)

  assert.match(
    migration,
    /alter table public\.profiles[\s\S]*?add column is_payroll_eligible boolean not null default true/
  )
  assert.match(
    migration,
    /profile\.employment_status in \('active', 'on_leave'\)[\s\S]*?profile\.is_payroll_eligible is true/
  )
  assert.match(
    migration,
    /create trigger payroll_records_employee_eligibility[\s\S]*?before insert or update of employee_id/
  )
})

test('payroll eligibility changes are authorized, audited, and protected', async () => {
  const migration = await read(migrationPath)

  assert.match(
    migration,
    /create or replace function public\.payroll_set_employee_eligibility\(/
  )
  assert.match(
    migration,
    /not public\.workforce_has_permission\('create_payroll'\)/
  )
  assert.match(
    migration,
    /'payroll_employee_included'[\s\S]*?'payroll_employee_excluded'/
  )
  assert.match(migration, /'removed_empty_draft_record_ids'/)
  assert.match(
    migration,
    /create trigger profiles_payroll_eligibility_guard[\s\S]*?before update of is_payroll_eligible/
  )
  assert.match(
    migration,
    /revoke all on function public\.payroll_set_employee_eligibility\([\s\S]*?from public, anon/
  )
})

test('only untouched open payroll shells can be removed during exclusion', async () => {
  const migration = await read(migrationPath)

  for (const protectedEvidence of [
    'record.calculated_at is not null',
    'public.payroll_items',
    'public.payroll_attendance_snapshots',
    'public.payroll_schedule_snapshots',
    'public.payroll_prepaid_hours',
    'public.payroll_hour_allocations',
    'public.payslips',
    'public.payroll_audit_logs'
  ]) {
    assert.match(migration, new RegExp(protectedEvidence.replaceAll('.', '\\.')))
  }

  assert.match(
    migration,
    /delete from public\.payroll_records[\s\S]*?period\.status in \('draft', 'reopened'\)[\s\S]*?record\.status = 'draft'[\s\S]*?record\.calculated_at is null/
  )
})
