import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('historical prepaid restore is scoped, audited, and permits approved RDOT attendance', async () => {
  const sql = await read('supabase/migrations/20260808095630_restore_historical_prepaid_attendance.sql')
  assert.match(sql, /payroll_restore_historical_prepaid_attendance\(/)
  assert.match(sql, /review_status = 'approved'/)
  assert.match(sql, /source_type, source_reference, source_metadata/)
  assert.match(sql, /'historical_restore'/)
  assert.match(sql, /payroll_historical_prepaid_restored/)
  assert.match(sql, /prepaid_minutes, settled_minutes/) 
  assert.match(sql, /v_schedule\.is_rest_day/)
  assert.match(sql, /An active historical prepaid source already exists/)
  assert.match(sql, /v_period\.status not in \('draft','reopened'\)/)
  assert.match(sql, /workforce_has_permission\('create_payroll'\)/)
})

test('restore creates no attendance and does not alter billed-hour calculation', async () => {
  const sql = await read('supabase/migrations/20260808095630_restore_historical_prepaid_attendance.sql')
  assert.doesNotMatch(sql, /insert into public\.attendance|update public\.attendance/)
  assert.doesNotMatch(sql, /payroll_records[\s\S]*total_billed|billed_minutes|billed_hours/)
  assert.match(sql, /insert into public\.payroll_schedule_snapshots/)
  assert.match(sql, /insert into public\.payroll_prepaid_hours/)
})

test('settled prepaid with matching approved billed attendance is audit-only after schedule changes', async () => {
  const sql = await read('supabase/migrations/20260729070252_complete_payroll_exception_review.sql')
  assert.match(sql, /prepaid\.remaining_minutes = 0/)
  assert.match(sql, /rendered\.review_status in \('approved', 'locked'\)/)
  assert.match(sql, /rendered\.billed_clock_in is not null/)
  assert.match(sql, /rendered\.billed_clock_out is not null/)
  assert.match(sql, /prepaid\.prepaid_minutes/)
  assert.doesNotMatch(sql, /current_shift_start is distinct from\s+prepaid\.shift_start/)
})

test('unsettled schedule conflicts remain blocking and history is not rewritten', async () => {
  const sql = await read('supabase/migrations/20260729070252_complete_payroll_exception_review.sql')
  assert.match(sql, /prepaid\.remaining_minutes > 0/)
  assert.match(sql, /schedule_changed_after_preplot_approval/)
  assert.doesNotMatch(sql, /update public\.payroll_schedule_snapshots/)
})

test('restored prepaid settlement allocates existing attendance and excludes only restored sources from new pay', async () => {
  const settlement = await read('supabase/migrations/20260808102519_settle_restored_prepaid_attendance.sql')
  const calculator = await read('supabase/migrations/20260729073554_calculate_draft_payroll.sql')
  assert.match(settlement, /payroll_settle_restored_prepaid_attendance/)
  assert.match(settlement, /payroll_hour_allocations/)
  assert.match(settlement, /settled_minutes=settled_minutes\+v_minutes/)
  assert.match(settlement, /already allocated to the attendance snapshot/)
  assert.match(calculator, /snapshot\.source_metadata ->> 'historical_restore'/)
  assert.match(calculator, /New prepaid hours included in Total Billed Hours/)
})

test('prepaid duration variance and carry-forward are not schedule-source blockers', async () => {
  const sql = await read('supabase/migrations/20260729070252_complete_payroll_exception_review.sql')
  assert.match(sql, /prepaid\.current_schedule_version is distinct from\s+prepaid\.snapshot_schedule_version/)
  assert.match(sql, /prepaid\.current_schedule_status is distinct from\s+prepaid\.schedule_status/)
  assert.doesNotMatch(sql, /prepaid\.current_shift_start is distinct from\s+prepaid\.shift_start/)
  assert.doesNotMatch(sql, /prepaid\.current_shift_end is distinct from\s+prepaid\.shift_end/)
  assert.match(sql, /prepaid\.remaining_minutes = 0/)
})
