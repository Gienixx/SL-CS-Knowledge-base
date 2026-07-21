import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(
  new URL('../supabase/migrations/20260721112404_fix_clock_out_structured_totals.sql', import.meta.url),
  'utf8'
)

test('clock-out clears provisional totals before setting the final timestamp', () => {
  assert.match(migration, /create or replace function public\.workforce_clock_out\(\)/)
  assert.match(migration, /set clock_out = v_clock_time,[\s\S]*pre_shift_overtime_minutes = null/)
  assert.match(migration, /regular_minutes = null/)
  assert.match(migration, /post_shift_overtime_minutes = null/)
  assert.match(migration, /rest_day_overtime_minutes = 0/)
  assert.match(migration, /holiday_overtime_minutes = 0/)
  assert.match(migration, /total_overtime_minutes = 0/)
  assert.match(migration, /overtime_minutes = 0/)
  assert.match(migration, /return public\.workforce_recalculate_attendance\(v_result\.id\)/)
})

test('clock-out remains authenticated and transaction-safe', () => {
  assert.match(migration, /security definer/)
  assert.match(migration, /v_auth_user_id uuid := auth\.uid\(\)/)
  assert.match(migration, /workforce_current_user_is_agent\(\)/)
  assert.match(migration, /workforce_is_current_identity\(attendance_row\.user_id\)/)
  assert.match(migration, /revoke all on function public\.workforce_clock_out\(\) from public/)
  assert.match(migration, /grant execute on function public\.workforce_clock_out\(\) to authenticated/)
})
