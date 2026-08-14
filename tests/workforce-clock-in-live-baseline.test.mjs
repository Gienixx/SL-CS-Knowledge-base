import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'

const migration = await fs.readFile(
  new URL('../supabase/migrations/20260814153838_reconcile_live_workforce_clock_in.sql', import.meta.url),
  'utf8',
)
const attendance = await fs.readFile(new URL('../scripts/attendance.js', import.meta.url), 'utf8')

test('live clock-in baseline preserves timed and special schedule validation', () => {
  assert.match(migration, /status in \('published', 'changed'\)/)
  assert.match(migration, /not \(v_schedule\.is_rest_day or v_schedule\.is_holiday\)/)
  assert.match(migration, /shift_start is null or v_schedule\.shift_end is null/)
  assert.match(migration, /schedule\.shift_date between v_local_date - 1 and v_local_date \+ 1/)
  assert.match(migration, /v_work_date := v_schedule\.shift_date/)
})

test('live clock-in baseline preserves dormant unscheduled-session capability', () => {
  assert.match(migration, /p_schedule_id is null/)
  assert.match(migration, /a\.schedule_id is null/)
  assert.match(migration, /review_status = case when p_schedule_id is null then 'pending'/)
  assert.match(migration, /values \(\s*v_profile_user_id, p_schedule_id, v_work_date/)
})

test('baseline does not expose the Additional session frontend', () => {
  assert.doesNotMatch(attendance, /ADDITIONAL_WORK_SESSION/)
  assert.doesNotMatch(attendance, /canClockAdditionalSession/)
})
