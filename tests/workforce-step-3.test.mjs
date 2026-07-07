import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('home exposes Workforce Management only through the employee permission gate', async () => {
  const [html, script] = await Promise.all([
    read('home.html'),
    read('scripts/home-workforce-nav.js')
  ])

  assert.match(
    html,
    /id="homeWorkforceManagementBtn"[^>]*href="\.\/workforce\.html"[^>]*hidden/
  )
  assert.match(script, /homeWorkforceManagementBtn/)
  assert.match(script, /access\.is_admin\s*===\s*true/)
  assert.match(script, /hasWorkforcePermission\(access,\s*'manage_employees'\)/)
  assert.match(script, /workforceManagementButton\.hidden\s*=\s*!canManageEmployees/)
})

test('employee and team pages require authorized workforce administration', async () => {
  const [employeeHtml, employeeScript, teamHtml, teamScript] = await Promise.all([
    read('workforce.html'),
    read('scripts/workforce.js'),
    read('team-management.html'),
    read('scripts/team-management.js')
  ])

  assert.match(employeeHtml, /Employee Profiles/)
  assert.match(employeeHtml, /Effective permissions/)
  assert.match(employeeScript, /requireWorkforcePermission\(supabase,\s*'manage_employees'/)
  assert.match(employeeScript, /access\.is_admin\s*!==\s*true/)
  assert.match(employeeScript, /workforce_admin_save_employee/)

  assert.match(teamHtml, /Team Management/)
  assert.match(teamScript, /requireWorkforcePermission\(supabase,\s*'manage_employees'/)
  assert.match(teamScript, /access\.is_admin\s*!==\s*true/)
  assert.match(teamScript, /workforce_admin_save_team/)
})

test('Step 3 RPCs are server-authorized, transactional, and preserve compatibility', async () => {
  const [migration, verification] = await Promise.all([
    read('supabase/migrations/2026070606_workforce_employee_team_admin.sql'),
    read('supabase/verification/workforce_employee_team_admin_check.sql')
  ])

  assert.match(migration, /security definer/gi)
  assert.match(migration, /workforce_is_admin\(\)/)
  assert.match(migration, /workforce_has_permission\('manage_employees'\)/)
  assert.match(migration, /update public\.login/)
  assert.match(migration, /insert into public\.user_permissions/)
  assert.match(migration, /You cannot remove your own active administrator/)
  assert.match(migration, /revoke execute[\s\S]+from anon;/i)
  assert.match(migration, /grant execute[\s\S]+to authenticated;/i)

  assert.match(verification, /employee_admin_rpc_exists/)
  assert.match(verification, /team_admin_rpc_exists/)
  assert.match(verification, /anon_cannot_execute_employee_admin/)
  assert.match(verification, /anon_cannot_execute_team_admin/)
})
