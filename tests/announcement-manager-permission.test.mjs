import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  WORKFORCE_PERMISSION_KEYS,
  hasWorkforcePermission,
  normalizeWorkforceAccess
} from '../shared/workforce-access.js'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('announcement management is a scoped workforce permission', () => {
  assert.ok(WORKFORCE_PERMISSION_KEYS.includes('manage_announcements'))

  const access = normalizeWorkforceAccess({
    user_id: 'agent-1',
    is_active: true,
    employment_status: 'active',
    base_role: 'agent',
    is_agent: true,
    permissions: { manage_announcements: true }
  })

  assert.equal(access.is_admin, false)
  assert.equal(access.can_manage_announcements, true)
  assert.equal(hasWorkforcePermission(access, 'manage_announcements'), true)
})

test('Workforce Management can assign announcement access on invites and edits', async () => {
  const page = await read('workforce.html')
  const checkboxes = page.match(/value="manage_announcements"/g) || []

  assert.equal(checkboxes.length, 2)
  assert.match(page, /value="manage_announcements"><span>Manage announcements<\/span>/)
})

test('announcement managers see only the announcement management surface', async () => {
  const page = await read('announcement-management.html')
  const homeScript = await read('scripts/home.js')
  const managementScript = await read('scripts/announcement-management.js')

  assert.match(page, /id="todoManagementTab"[^>]+hidden/)
  assert.match(homeScript, /hasWorkforcePermission\(access, 'manage_announcements'\)/)
  assert.match(managementScript, /hasWorkforcePermission\(access, 'manage_announcements'\)/)
  assert.match(managementScript, /elements\.todoTab\.hidden = !isAdmin/)
  assert.match(managementScript, /const managementLoaders = \[loadAnnouncements\(\)\]/)
  assert.match(managementScript, /if \(access\.is_admin === true\) \{[\s\S]*loadTodoManagement\(\)[\s\S]*loadTodoActivityLogs\(\)/)
})

test('database migration persists and enforces announcement-manager access', async () => {
  const migration = await read(
    'supabase/migrations/20260718093234_add_announcement_manager_permission.sql'
  )

  assert.match(migration, /user_permissions_permission_key_check/)
  assert.match(migration, /'manage_announcements'::text/)
  assert.match(migration, /workforce_get_current_access\(\)[\s\S]*'manage_announcements'/)
  assert.match(migration, /workforce_admin_save_employee\([\s\S]*permission_key,[\s\S]*'manage_announcements'/)
  assert.match(migration, /workforce_service_create_invitation\([\s\S]*'manage_announcements'/)
  assert.match(migration, /status = 'published'[\s\S]*workforce_has_permission\('manage_announcements'\)/)
  assert.match(migration, /for insert[\s\S]*for update[\s\S]*for delete/)
})
