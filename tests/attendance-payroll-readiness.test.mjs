import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath = 'supabase/migrations/20260716062407_attendance_payroll_readiness.sql'

test('Step 15 payroll readiness is reproducible from the recorded migration', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /create or replace view public\.workforce_attendance_payroll_readiness/)
  assert.match(migration, /with \(security_invoker = true\)/)
  assert.match(migration, /sum\(total_overtime_minutes\) over \([\s\S]*partition by user_id, work_date/)
  assert.match(migration, /total_overtime_minutes <= 1200/)
  assert.match(migration, /review_status in \('approved', 'locked'\)/)
  assert.match(migration, /revoke all on public\.workforce_attendance_payroll_readiness from anon/)
  assert.match(migration, /grant select on public\.workforce_attendance_payroll_readiness to authenticated/)
})

test('Step 15 includes a live verification script', async () => {
  const verification = await read('supabase/verification/attendance_payroll_readiness_check.sql')

  assert.match(verification, /security_invoker=true/)
  assert.match(verification, /has_table_privilege\('anon'/)
  assert.match(verification, /where is_payroll_ready/)
  assert.match(verification, /having sum\(total_overtime_minutes\) > 1200/)
})
