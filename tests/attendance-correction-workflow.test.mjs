import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath = 'supabase/migrations-legacy/2026070904_attendance_correction_workflow.sql'
const totalsFixMigrationPath = 'supabase/migrations/20260714092037_fix_attendance_correction_totals.sql'
const closedRecalculationMigrationPath = 'supabase/migrations/20260714102250_allow_closed_attendance_recalculation.sql'

test('Step 12 migration creates the correction history table and correction RPC', async () => {
  const migration = await read(migrationPath)

  assert.match(migration, /create table if not exists public\.attendance_corrections/)
  assert.match(migration, /create or replace function public\.workforce_correct_attendance\(/)
  assert.match(migration, /reason_code/)
  assert.match(migration, /insert into public\.attendance_corrections/)
  assert.match(migration, /review_status = 'corrected'/)
})

test('closed historical corrections allow a separate current open session', async () => {
  const migration = await read(closedRecalculationMigrationPath)

  assert.match(migration, /if v_attendance\.clock_out is null and exists \(/)
  assert.match(migration, /Only one attendance session may remain open at a time\./)
  assert.match(migration, /closed_rows_allow_separate_open_session/)
  assert.match(migration, /open_row_single_session_guard_retained/)
  assert.match(migration, /revoke all on function public\.workforce_recalculate_attendance\(uuid\) from authenticated/)
})

test('attendance corrections atomically recalculate RDOT and holiday totals', async () => {
  const migration = await read(totalsFixMigrationPath)

  assert.match(migration, /create or replace function public\.workforce_correct_attendance\(/)
  assert.match(migration, /rest_day_overtime_minutes = 0/)
  assert.match(migration, /holiday_overtime_minutes = 0/)
  assert.match(migration, /v_result := public\.workforce_recalculate_attendance\(v_attendance\.id\)/)
  assert.match(migration, /'rest_day_overtime_minutes', coalesce\(v_result\.rest_day_overtime_minutes, 0\)/)
  assert.match(migration, /revoke all on function public\.workforce_correct_attendance[\s\S]*from anon/)
  assert.match(migration, /grant execute on function public\.workforce_correct_attendance[\s\S]*to authenticated/)
})
