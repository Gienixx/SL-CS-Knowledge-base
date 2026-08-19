import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('all active workforce roles can open personal attendance', async () => {
  const [attendance, homeNavigation] = await Promise.all([
    read('scripts/attendance.js'),
    read('scripts/home-workforce-nav.js')
  ])

  assert.match(attendance, /if \(!access\.allowed\)/)
  assert.doesNotMatch(attendance, /access\.is_agent !== true/)
  assert.match(homeNavigation, /const canUseAttendance = access\.allowed === true/)
  assert.match(homeNavigation, /attendanceButton\.hidden = !canUseAttendance/)
})

test('production role access preserves explicit Admin, Agent, and Admin-and-Agent choices', async () => {
  const live = await read(
    'supabase/reconciliation-archive/pre-canonical-migrations-20260819/live-production-definitions-20260819.sql'
  )

  assert.match(live, /p_access_type not in \('admin', 'regular_agent', 'admin_agent'\)/)
  assert.match(live, /Invalid access type\. Use Admin, Regular Agent, or Admin and Agent\./)
  assert.match(live, /workforce_admin_save_employee_legacy_access_bridge/)
  assert.match(live, /workforce_service_create_invitation_legacy_payroll_bridge/)
  assert.match(live, /signature: workforce_admin_save_employee\(/)
  assert.match(live, /signature: workforce_service_create_invitation\(/)
})

test('clock functions still require the active attendance-participant identity check', async () => {
  const [clockIn, clockOut] = await Promise.all([
    read('supabase/migrations/20260731065252_allow_next_day_special_schedule_clock_in.sql'),
    read('supabase/migrations/20260721112529_fix_clock_out_structured_totals.sql')
  ])

  assert.match(clockIn, /not public\.workforce_current_user_is_agent\(\)/)
  assert.match(clockOut, /not public\.workforce_current_user_is_agent\(\)/)
  assert.match(clockIn, /workforce_is_current_identity\(schedule\.user_id\)/)
  assert.match(clockOut, /workforce_is_current_identity\(attendance_row\.user_id\)/)
})
