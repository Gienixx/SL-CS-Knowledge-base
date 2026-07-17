import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const html = await readFile(new URL('../workforce.html', import.meta.url), 'utf8')
const client = await readFile(new URL('../scripts/workforce-schedules.js', import.meta.url), 'utf8')
const entry = await readFile(new URL('../scripts/workforce-schedules-entry.js', import.meta.url), 'utf8')
const migration = await readFile(
  new URL('../supabase/migrations/20260717173513_simplify_recurring_schedule_checkbox.sql', import.meta.url),
  'utf8'
)

test('schedule form offers simple per-entry weekly automation', () => {
  assert.match(html, /id="scheduleRepeatWeekly"[^>]*type="checkbox"/)
  assert.match(html, /Add this schedule to Sunday weekly automation/)
  assert.match(html, /You can select one date or several dates/)
  assert.match(client, /workforce_admin_save_schedule_and_repeat/)
  assert.match(client, /p_repeat_weekly:\s*repeatWeekly/)
  assert.doesNotMatch(client, /Save the selected days first/)
  assert.match(html, /workforce-schedules-entry\.js\?v=9/)
  assert.match(entry, /workforce-schedules\.js\?v=9/)
})

test('each checked schedule is atomically added to the recurring template', () => {
  assert.match(migration, /v_result := public\.workforce_admin_save_schedule\(/)
  assert.match(migration, /workforce_admin_add_schedule_to_weekly_template\(v_result\.id\)/)
  assert.match(migration, /on conflict \(template_id, weekday, shift_sequence\) do update/)
  assert.match(migration, /v_schedule\.is_holiday/)
  assert.match(migration, /workforce_can_manage_user\(v_schedule\.user_id, 'manage_schedules'\)/)
  assert.match(migration, /v_profile\.base_role <> 'agent'/)
  assert.match(migration, /v_profile\.employment_status <> 'active'/)
  assert.doesNotMatch(migration, /Complete Sunday through Saturday/)
})

test('only the authenticated wrapper is exposed to browser clients', () => {
  assert.match(
    migration,
    /revoke all on function public\.workforce_admin_add_schedule_to_weekly_template\(uuid\)[\s\S]*from public, anon, authenticated/
  )
  assert.match(
    migration,
    /grant execute on function public\.workforce_admin_save_schedule_and_repeat\([\s\S]*?\) to authenticated/
  )
})
