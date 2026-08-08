import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migrationPath = 'supabase/migrations/20260808100000_billed_attendance_timestamps.sql'

test('billed attendance keeps captures immutable and stores editable payroll values', async () => {
  const sql = await read(migrationPath)
  assert.match(sql, /add column if not exists billed_clock_in/)
  assert.match(sql, /add column if not exists billed_clock_out/)
  assert.match(sql, /original_clock_in, v_old\.original_clock_out/)
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
  const sql = await read(migrationPath)
  assert.match(sql, /previous_billed_clock_in, previous_billed_clock_out/)
  assert.match(sql, /new_billed_clock_in, new_billed_clock_out/)
  assert.match(sql, /'review_status', v_old\.review_status/)
  assert.doesNotMatch(sql, /review_status = 'corrected'/)
  assert.match(sql, /billed_clock_in is null or v_row\.billed_clock_out is null/)
})
