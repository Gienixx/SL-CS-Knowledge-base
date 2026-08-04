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

test('administrators keep admin access and become attendance participants', async () => {
  const migration = await read(
    'supabase/migrations/20260803152839_enable_attendance_for_all_workforce_roles.sql'
  )

  assert.match(
    migration,
    /where \(base_role = 'admin' or is_system_admin is true\)[\s\S]*is_agent is not true/
  )
  assert.match(
    migration,
    /when p_access_type = 'admin' then 'admin_agent'/
  )
  assert.match(
    migration,
    /workforce_admin_save_employee_attendance_role_bridge/
  )
  assert.match(
    migration,
    /workforce_service_create_invitation_attendance_role_bridge/
  )
  assert.match(
    migration,
    /own_attendance_scope_preserved', true/
  )
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
