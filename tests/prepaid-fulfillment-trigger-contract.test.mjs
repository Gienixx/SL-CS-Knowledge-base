import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('approval makes attendance eligible but payroll import is the prepaid fulfillment trigger', async () => {
  const [approval, importMigrations, reconciliation, teamScript, payrollScript, documentation] =
    await Promise.all([
      read('supabase/migrations/20260825090000_fix_approval_canonical_billed_duration.sql'),
      Promise.all([
        read('supabase/migrations/20260724112455_payroll_attendance_import.sql'),
        read('supabase/migrations/20260808090150_payroll_import_billed_timestamps.sql'),
        read('supabase/migrations/20260808090955_employee_scoped_payroll_attendance_reimport.sql'),
        read('supabase/migrations/20260808093641_latest_snapshot_recalculation_transition.sql')
      ]).then(parts => parts.join('\n')),
      read('supabase/migrations/20260728053329_payroll_prepaid_hour_reconciliation.sql'),
      read('scripts/team-attendance.js'),
      read('scripts/payroll-period.js'),
      read('docs/payroll-attendance-import.md')
    ])

  assert.doesNotMatch(approval, /payroll_import_attendance|payroll_reconcile_prepaid_hours/)
  assert.match(approval, /review_status = p_review_status/)
  assert.match(approval, /payroll_approved_at = case/)

  assert.match(importMigrations, /insert into public\.payroll_attendance_snapshots/)
  assert.match(importMigrations, /on conflict \(\s*payroll_record_id,\s*attendance_id,\s*attendance_version\s*\) do nothing/)
  assert.match(reconciliation, /create trigger payroll_attendance_snapshot_reconcile_prepaid_hours\s+after insert on public\.payroll_attendance_snapshots/)
  assert.match(reconciliation, /insert into public\.payroll_hour_allocations/)
  assert.match(reconciliation, /settled_minutes\s*=\s*settled_minutes\s*\+/)

  assert.match(teamScript, /Payroll import is still required before prepaid fulfillment is recorded/)
  assert.match(payrollScript, /Approved attendance will not fulfill prepaid balances until import runs/)
  assert.match(documentation, /Approval makes attendance payroll-ready;/)
  assert.match(documentation, /it does not itself create a payroll[\s\S]*attendance snapshot or settle a prepaid balance/)
})

test('the approved snapshot path preserves billed timestamps and approval guardrails', async () => {
  const [latest, importMigrations] = await Promise.all([
    read('supabase/migrations/20260828082817_fix_prepaid_import_canonical_timestamps.sql'),
    Promise.all([
      read('supabase/migrations/20260724112455_payroll_attendance_import.sql'),
      read('supabase/migrations/20260808090150_payroll_import_billed_timestamps.sql'),
      read('supabase/migrations/20260808093641_latest_snapshot_recalculation_transition.sql')
    ]).then(parts => parts.join('\n'))
  ])

  assert.match(importMigrations, /attendance_row\.billed_clock_in as billed_clock_in/)
  assert.match(importMigrations, /attendance_row\.billed_clock_out as billed_clock_out/)
  assert.match(latest, /coalesce\(source\.billed_clock_in, source\.captured_clock_in\)/)
  assert.match(latest, /coalesce\(source\.billed_clock_out, source\.captured_clock_out\)/)
  assert.match(latest, /review_status not in \(''approved'', ''locked''\)/)
})
