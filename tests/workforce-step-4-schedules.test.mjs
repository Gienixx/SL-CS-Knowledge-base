import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('workforce administration includes the schedule management interface', async () => {
  const [html, script] = await Promise.all([
    read('workforce.html'),
    read('scripts/workforce-schedules.js')
  ])

  assert.match(html, /id="scheduleManagementSection"/)
  assert.match(html, /Weekly and monthly schedule views/)
  assert.match(html, /id="scheduleModal"/)
  assert.match(html, /id="scheduleIsRestDay"/)
  assert.match(html, /id="scheduleIsHoliday"/)
  assert.match(script, /hasWorkforcePermission\(access,\s*'manage_schedules'\)/)
  assert.match(script, /from\('work_schedules'\)/)
  assert.match(script, /workforce_admin_save_schedule/)
  assert.match(script, /viewSelect\.value === 'month'/)
})

test('schedule RPC enforces authorization, validation, and change visibility', async () => {
  const migration = await read('supabase/migrations-legacy/2026070703_workforce_schedule_management.sql')

  assert.match(migration, /security definer/i)
  assert.match(migration, /workforce_can_manage_user\(p_user_id, 'manage_schedules'\)/)
  assert.match(migration, /Schedules can only be assigned to profiles with agent access/)
  assert.match(migration, /Shift end must be later than shift start/)
  assert.match(migration, /already has the selected shift sequence/)
  assert.match(migration, /v_status := 'changed'/)
  assert.match(migration, /revoke execute[\s\S]+from anon;/i)
  assert.match(migration, /grant execute[\s\S]+to authenticated;/i)
})

test('schedule verification checks RPC privileges, RLS, audit logging, and malformed data', async () => {
  const verification = await read('supabase/verification/workforce_schedule_management_check.sql')

  assert.match(verification, /schedule_admin_rpc_exists/)
  assert.match(verification, /anon_cannot_execute_schedule_admin/)
  assert.match(verification, /relrowsecurity/)
  assert.match(verification, /schedule_audit_trigger_exists/)
  assert.match(verification, /Blocker: should return 0 rows/)
})
