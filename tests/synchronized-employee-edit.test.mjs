import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Edit Employee owns identity, employment, access, and permissions', async () => {
  const [html, client] = await Promise.all([
    read('workforce.html'),
    read('scripts/workforce.js')
  ])

  assert.match(html, /id="employeeFullName"/)
  assert.match(html, /id="employeeEmail"[^>]*required/)
  assert.doesNotMatch(html, /id="employeeEmail"[^>]*readonly/)
  assert.match(html, /id="employmentStatus"/)
  assert.match(html, /id="accessType"/)
  assert.match(html, /id="employeeTeam"/)
  assert.match(html, /id="employeeSupervisor"/)
  assert.match(html, /id="permissionGrid"/)
  assert.match(client, /authenticatedRequest\('\/update-employee'/)
})

test('server synchronizes Auth, profile, login, identity link, and audit with rollback', async () => {
  const [endpoint, middleware] = await Promise.all([
    read('functions/update-employee.js'),
    read('functions/_middleware.js')
  ])

  assert.match(middleware, /'\/update-employee'/)
  assert.match(endpoint, /auth\/v1\/admin\/users/)
  assert.match(endpoint, /workforce_admin_save_employee/)
  assert.match(endpoint, /rest\/v1\/login/)
  assert.match(endpoint, /workforce_identity_links/)
  assert.match(endpoint, /employee_identity_updated/)
  assert.match(endpoint, /restoreSnapshot/)
  assert.match(endpoint, /setEmploymentStatus/)
  assert.match(endpoint, /employment_status.*eq\.\$\{employmentStatus\}/s)
  assert.match(endpoint, /automatic rollback/i)
  assert.match(endpoint, /is_system_admin === true/)
})
