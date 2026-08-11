import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('attendance correction history exposes explicit schedule transitions', async () => {
  const migration = await read('supabase/migrations/20260810120000_complete_attendance_correction_history_contract.sql')
  const baseline = await read('supabase/migrations/20260711083340_remote_schema_baseline.sql')

  for (const column of [
    'attendance_id', 'employee_user_id', 'schedule_id',
    'new_schedule_id', 'previous_clock_in', 'previous_clock_out',
    'new_clock_in', 'new_clock_out', 'previous_status', 'new_status',
    'previous_calculations', 'new_calculations', 'reason_code', 'reason_notes',
    'corrected_by', 'corrected_at'
  ]) {
    assert.match(column === 'new_schedule_id' ? migration : baseline, new RegExp(`"?${column}"?`))
  }

  assert.match(migration, /previous_schedule_id/)
  assert.match(migration, /add column if not exists new_schedule_id/)
  assert.match(migration, /new\.new_schedule_id := new\.schedule_id/)
  assert.match(migration, /attendance_corrections_sync_schedule_history/)
})

test('correction RPCs require reasons, Other notes, and write structured plus summary audit history', async () => {
  const [correction, billed, assignment] = await Promise.all([
    read('supabase/migrations/20260714092037_fix_attendance_correction_totals.sql'),
    read('supabase/migrations/20260808141000_fix_billed_attendance_correction.sql'),
    read('supabase/migrations/20260810100000_unscheduled_attendance_schedule_assignment.sql')
  ])

  for (const sql of [correction, billed, assignment]) {
    assert.match(sql, /p_reason_code/)
    assert.match(sql, /p_reason_notes/)
    assert.match(sql, /attendance_corrections/)
    assert.match(sql, /workforce_audit_logs/)
  }
  assert.match(billed, /Written notes are required when reason is other/)
  assert.match(assignment, /Remarks are required|reason/i)
})
