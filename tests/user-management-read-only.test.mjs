import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Step 8 makes User Management a read-only parity window', async () => {
  const [html, browser, endpoint, employeeUpdate] = await Promise.all([
    read('user-management.html'),
    read('scripts/user-management.js'),
    read('functions/list-users.js'),
    read('functions/update-employee.js')
  ])

  assert.match(html, /Account management has moved to Employee Profiles/)
  assert.match(html, /href="\.\/workforce\.html"/)
  assert.match(html, /Employee ID/)
  assert.doesNotMatch(html, /User ID|Invite User|Resend Invite|Change Password|Delete User/)
  assert.doesNotMatch(browser, /resetPasswordForEmail|\/create-user|\/user-settings|\/delete-user|\/change-password/)
  assert.match(browser, /employee_id/)
  assert.match(browser, /parity_ok/)
  assert.match(endpoint, /employee_id/)
  assert.doesNotMatch(endpoint, /user_id:\s*authUser/)
  assert.match(endpoint, /Admin mismatch/)
  assert.match(endpoint, /Editor mismatch/)
  assert.match(employeeUpdate, /Compatibility parity verification failed/)
})
