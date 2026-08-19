import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath = 'supabase/migrations/20260808090036_billed_attendance_timestamps.sql'
const liveDefinitionsPath = 'supabase/reconciliation-archive/pre-canonical-migrations-20260819/live-production-definitions-20260819.sql'

test('billed attendance keeps captures immutable and stores editable payroll values', async () => {
  const sql = await read(migrationPath)
  assert.match(sql, /add column if not exists billed_clock_in/)
  assert.match(sql, /add column if not exists billed_clock_out/)
  assert.match(sql, /original_clock_in', v_old\.original_clock_in/)
  assert.match(sql, /original_clock_out', v_old\.original_clock_out/)
  assert.match(sql, /billed_clock_in = p_new_clock_in/)
  assert.match(sql, /billed_clock_out = p_new_clock_out/)
})

test('billed corrections require authorization and a reason', async () => {
  const sql = await read(migrationPath)
  assert.match(sql, /workforce_can_correct_attendance/)
  assert.match(sql, /A correction reason is required/)
  assert.match(sql, /workforce_can_manage_user\(v_old\.user_id, 'correct_attendance'\)/)
  assert.match(sql, /revoke all on function public\.workforce_correct_attendance/)
})

test('billed correction history records before and after values and preserves approval', async () => {
  const sql = await read(liveDefinitionsPath)
  assert.match(sql, /previous_billed_clock_in, previous_billed_clock_out/)
  assert.match(sql, /new_billed_clock_in, new_billed_clock_out/)
  assert.match(sql, /'review_status', v_old\.review_status/)
  assert.match(sql, /review_status = 'corrected'/)
  assert.match(sql, /billed_clock_in/)
})

test('correction preserves originals, marks pending rows corrected, and records billed history', async () => {
  const sql = await read(liveDefinitionsPath)
  assert.match(sql, /review_status = 'corrected'/)
  assert.match(sql, /v_old\.billed_clock_in, v_old\.billed_clock_out,\s*v_new\.billed_clock_in, v_new\.billed_clock_out/)
  assert.match(sql, /Billed clock-out cannot be earlier than billed clock-in/)
  assert.match(sql, /workforce_recalculate_attendance\(v_new\.id\)/)
})
