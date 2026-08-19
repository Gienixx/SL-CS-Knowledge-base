import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('historical schedule corrections require a reason and preserve audit/recalculation workflow', async () => {
  const sql = await read('supabase/migrations/20260810140000_enable_audited_historical_schedule_corrections.sql')
  assert.match(sql, /auth\.uid\(\)/)
  assert.match(sql, /workforce_can_manage_user\(p_user_id, 'manage_schedules'\)/)
  assert.match(sql, /A reason is required for schedule corrections/)
  assert.match(sql, /historical_schedule_correction/)
  assert.match(sql, /workforce_recalculate_attendance\(v_attendance_id\)/)
  assert.match(sql, /where schedule_id = v_result\.id/)
  assert.match(sql, /grant execute on function public\.workforce_admin_save_schedule[\s\S]*authenticated/)
})

test('historical schedule workflow preserves linked attendance and immutable clock sources', async () => {
  const sql = await read('supabase/migrations/20260810140000_enable_audited_historical_schedule_corrections.sql')
  assert.doesNotMatch(sql, /update public\.attendance/)
  assert.doesNotMatch(sql, /billed_clock_in|billed_clock_out|original_clock_in|original_clock_out/)
  assert.match(sql, /where id = p_schedule_id returning \* into v_result/)
})

test('open schedule corrections retain their reason in the existing audit event', async () => {
  const sql = await read('supabase/migrations/20260811094915_preserve_open_schedule_correction_reason.sql')
  assert.match(sql, /rename to workforce_admin_save_open_schedule_without_audit_reason/)
  assert.match(sql, /A reason is required for open schedule corrections/)
  assert.match(sql, /l\.action = 'update'/)
  assert.match(sql, /update public\.workforce_audit_logs set reason = v_reason/)
  assert.match(sql, /4521b6a5-304a-4f7a-b266-6d02d326a8e3/)
  assert.match(sql, /a09b34b4-d8f3-48a5-a033-89c98b9d683a/)
})
