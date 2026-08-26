import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(path, 'utf8')
const migrationPath =
  'supabase/migrations/20260826202522_prepaid_hour_corrections.sql'
const hardeningMigrationPath =
  'supabase/migrations/20260826210223_prepaid_hour_correction_hardening.sql'
const readerRetirementMigrationPath =
  'supabase/migrations/20260826215013_retire_stale_prepaid_exception_base.sql'

test('corrections use an append-only versioned prepaid balance', async () => {
  const migration = await read(migrationPath)

  for (const column of [
    'prepaid_version',
    'correction_of_id',
    'effective_work_date',
    'effective_shift_start',
    'effective_shift_end',
    'effective_timezone',
    'correction_reason',
    'corrected_by',
    'corrected_at'
  ]) {
    assert.match(migration, new RegExp(`add column ${column}`))
  }
  assert.match(
    migration,
    /unique \(source_schedule_snapshot_id, prepaid_version\)/
  )
  assert.match(
    migration,
    /on conflict \(source_schedule_snapshot_id, prepaid_version\) do nothing/
  )
  assert.match(
    migration,
    /Only the current active prepaid version can be edited\./
  )
  assert.match(
    migration,
    /Payroll prepaid-hour balances cannot be deleted\./
  )
  assert.match(
    migration,
    /source and correction details are immutable\./
  )
})

test('correction RPC enforces permission, exact ten-day window, and required reason', async () => {
  const migration = await read(migrationPath)

  assert.match(
    migration,
    /create or replace function public\.payroll_correct_prepaid_hours\(/
  )
  assert.match(
    migration,
    /not public\.workforce_has_permission\('create_payroll'\)/
  )
  assert.match(migration, /A correction reason is required\./)
  assert.match(
    migration,
    /p_work_date < public\.payroll_prepaid_eligibility_start\(v_period\.period_end\)/
  )
  assert.match(migration, /p_work_date > v_period\.period_end/)
  assert.match(
    migration,
    /within ten calendar days before and on the payroll cutoff/
  )
  assert.match(
    migration,
    /Prepaid times must create a positive shift of no more than 24 hours\./
  )
})

test('settled prepaid balances are blocked without destructive reversal', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /if v_old\.settled_minutes > 0 then/)
  assert.match(
    migration,
    /already been partially or fully settled and cannot be edited safely/
  )
  assert.doesNotMatch(
    migration,
    /delete from public\.payroll_hour_allocations|delete from public\.payroll_prepaid_hours/i
  )
  assert.match(
    migration,
    /and other\.voided_at is null\n      and coalesce\(other\.effective_work_date, other_snapshot\.work_date\)/
  )
})

test('correction creates a new active balance, supersedes the old one, and audits old/new values', async () => {
  const migration = await read(migrationPath)

  assert.match(
    migration,
    /insert into public\.payroll_prepaid_hours \([\s\S]*?v_old\.prepaid_version \+ 1[\s\S]*?v_old\.id[\s\S]*?p_work_date/
  )
  assert.match(
    migration,
    /update public\.payroll_prepaid_hours\n  set[\s\S]*?superseded_by_id = v_new_id\n  where id = v_old\.id/
  )
  assert.match(migration, /'payroll_prepaid_hours_corrected'/)
  assert.match(migration, /before_data/)
  assert.match(migration, /after_data/)
  assert.match(migration, /'source_snapshot_unchanged', true/)
  assert.match(migration, /'live_schedule_unchanged', true/)
  assert.doesNotMatch(
    migration,
    /update public\.work_schedules|insert into public\.work_schedules/
  )
})

test('only active corrected values feed reconciliation, calculation, finalization, and readiness', async () => {
  const migration = await read(migrationPath)

  assert.match(
    migration,
    /coalesce\(prepaid\.effective_work_date, source_snapshot\.work_date\) <= new\.work_date/
  )
  assert.match(
    migration,
    /coalesce\(prepaid\.effective_work_date, snapshot\.work_date\)/
  )
  assert.match(
    migration,
    /coalesce\(prepaid\.effective_work_date, source_snapshot\.work_date\) < period\.period_start/
  )
  assert.match(
    migration,
    /coalesce\(prepaid\.effective_work_date, source_snapshot\.work_date\)[\s\S]*?between period\.period_start and period\.period_end/
  )
  assert.match(migration, /prepaid\.voided_at is null/)
  assert.match(
    migration,
    /requires_recalculation = true[\s\S]*?Prepaid hours were corrected/
  )
  assert.match(
    migration,
    /v_period\.status not in \('draft', 'reopened'\)/
  )
  assert.match(
    migration,
    /v_record\.status in \('approved', 'finalized', 'void'\)/
  )
})

test('attendance, schedule, duplicate, overnight, and payroll-lock guards remain explicit', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /from public\.attendance as attendance_row/)
  assert.match(
    migration,
    /Attendance already exists for this employee and date\. Prepaid hours cannot be corrected onto attendance\./
  )
  assert.match(migration, /Multiple schedules exist for this employee and date/)
  assert.match(migration, /Rest days do not create prepaid-hour debt/)
  assert.match(migration, /Guaranteed special days do not create prepaid-hour debt/)
  assert.match(migration, /Cancelled or completed schedules cannot receive corrected prepaid hours/)
  assert.match(
    migration,
    /when p_prepaid_logout <= p_prepaid_login then interval '1 day'/
  )
  assert.match(
    migration,
    /Prepaid corrections are protected after payroll review, finalization, or lock\./
  )
})

test('prepaid balance RPC exposes current values and immutable correction history', async () => {
  const [migration, html, script] = await Promise.all([
    read(migrationPath),
    read('payroll-period.html'),
    read('scripts/payroll-period.js')
  ])

  for (const field of [
    'prepaid_version',
    'correction_of_id',
    'effective_shift_start',
    'effective_shift_end',
    'effective_timezone',
    'correction_reason',
    'corrected_by',
    'corrected_at',
    'original_work_date',
    'created_by_name',
    'corrected_by_name',
    'original_approval_reason'
  ]) {
    assert.match(migration, new RegExp(field))
  }
  assert.match(html, /id="payrollPrepaidHistory"/)
  assert.match(html, /id="payrollPrepaidReasonLabel"/)
  assert.match(script, /Edit Prepaid/)
  assert.match(script, /Correction history/)
  assert.match(script, /Save prepaid correction/)
  assert.match(script, /state\.prepaidMode === 'edit'/)
  assert.match(script, /payroll_correct_prepaid_hours/)
  assert.match(script, /payroll-prepaid-edit-button/)
  assert.match(script, /editButton\.disabled =/)
})

test('UI preserves duplicate prevention and disables settled or locked edits', async () => {
  const script = await read('scripts/payroll-period.js')

  assert.match(script, /candidate\.can_approve/)
  assert.match(script, /balance\.balance_status !== 'void'/)
  assert.match(script, /Number\(prepaidBalance\.settled_minutes \|\| 0\) > 0/)
  assert.match(script, /!periodCanApprove/)
  assert.match(script, /Attendance already exists|attendance conflict|cannot be corrected safely/i)
})

test('hardening migration protects active versions and stale readers', async () => {
  const migration = await read(hardeningMigrationPath)

  assert.match(
    migration,
    /create unique index payroll_prepaid_hours_one_active_version_idx[\s\S]*where voided_at is null/
  )
  assert.match(migration, /v_profile\.is_agent is not true/)
  assert.match(
    migration,
    /v_profile\.employment_status not in \('active', 'on_leave'\)/
  )
  assert.match(
    migration,
    /A source schedule is required for the corrected prepaid work date\./
  )
  assert.match(migration, /Pending audited prepaid correction version\./)
  assert.match(migration, /voided_at = null/)

  for (const functionName of [
    'workforce_list_my_prepaid_balances',
    'workforce_list_my_attendance_log',
    'workforce_admin_assist_snapshot'
  ]) {
    assert.match(migration, new RegExp(functionName))
  }
  assert.match(
    migration,
    /coalesce\(prepaid\.effective_work_date, snapshot\.work_date\)/
  )
  assert.match(
    migration,
    /coalesce\(prepaid\.effective_shift_start, snapshot\.shift_start\)/
  )
  assert.match(migration, /prepaid\.voided_at is null/)
  assert.match(
    migration,
    /Leave\/VL remains governed by the existing prepaid policy/ 
  )
})

test('stale exception base reader is retained for compatibility but retired from API use', async () => {
  const migration = await read(readerRetirementMigrationPath)

  assert.match(
    migration,
    /revoke all on function public\.payroll_get_period_exceptions_complete_base\(uuid\)/
  )
  assert.match(
    migration,
    /from public, anon, authenticated, service_role/
  )
  assert.match(
    migration,
    /Retained for database compatibility only; retired from application use\./
  )
  assert.doesNotMatch(
    migration,
    /drop function public\.payroll_get_period_exceptions_complete_base/i
  )
})
