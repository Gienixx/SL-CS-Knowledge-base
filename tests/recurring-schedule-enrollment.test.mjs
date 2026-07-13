import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const html = await readFile(new URL('../workforce.html', import.meta.url), 'utf8')
const client = await readFile(new URL('../scripts/workforce-schedules.js', import.meta.url), 'utf8')
const migration = await readFile(
  new URL('../supabase/migrations/20260713172131_recurring_template_enrollment.sql', import.meta.url),
  'utf8'
)

test('schedule form offers an explicit completed-week repetition action', () => {
  assert.match(html, /id="scheduleRepeatWeekly"[^>]*type="checkbox"/)
  assert.match(html, /Repeat this completed week automatically/)
  assert.match(client, /workforce_admin_save_schedule_and_repeat/)
  assert.match(client, /p_repeat_weekly:\s*repeatWeekly/)
})

test('weekly enrollment is atomic, complete, scoped, and New York based', () => {
  assert.match(migration, /v_result := public\.workforce_admin_save_schedule\(/)
  assert.match(migration, /v_schedule_count <> 7 or v_date_count <> 7/)
  assert.match(migration, /schedule\.shift_sequence <> 1/)
  assert.match(migration, /schedule\.is_holiday/)
  assert.match(migration, /workforce_can_manage_user\(p_user_id, 'manage_schedules'\)/)
  assert.match(migration, /v_profile\.base_role <> 'agent'/)
  assert.match(migration, /v_profile\.employment_status <> 'active'/)
  assert.match(migration, /'America\/New_York'/)
})

test('only the authenticated wrapper is exposed to browser clients', () => {
  assert.match(
    migration,
    /revoke all on function public\.workforce_admin_enroll_weekly_template\(uuid, date\)[\s\S]*from public, anon, authenticated/
  )
  assert.match(
    migration,
    /grant execute on function public\.workforce_admin_save_schedule_and_repeat\([\s\S]*?\) to authenticated/
  )
})
