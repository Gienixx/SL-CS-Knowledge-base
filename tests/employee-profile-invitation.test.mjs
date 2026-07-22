import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Employee Profiles owns the complete invitation form', async () => {
  const [html, script] = await Promise.all([
    read('workforce.html'),
    read('scripts/workforce.js')
  ])

  assert.match(html, /id="openEmployeeInviteButton"/)
  assert.match(html, /id="employeeInviteModal"/)
  assert.match(html, /id="inviteEmployeeName"/)
  assert.match(html, /id="inviteEmployeeEmail"/)
  assert.match(html, /id="inviteEmployeeAccessType"/)
  assert.match(html, /id="inviteEmployeeTeam"/)
  assert.match(html, /id="inviteEmployeeSupervisor"/)
  assert.match(html, /id="invitePermissionGrid"/)
  assert.doesNotMatch(html, />Open User Management</)
  assert.match(script, /authenticatedRequest\('\/create-user'/)
  assert.match(script, /permissions: readInvitePermissions\(\)/)
})

test('invited employees show lifecycle state, SL ID, and server-owned resend', async () => {
  const [html, script, endpoint, middleware] = await Promise.all([
    read('workforce.html'),
    read('scripts/workforce.js'),
    read('functions/resend-invite.js'),
    read('functions/_middleware.js')
  ])

  assert.match(html, /<th>User<\/th>/)
  assert.doesNotMatch(html, /<th>.*UUID.*<\/th>/i)
  assert.match(script, /onboarding_status/)
  assert.match(script, /badge\('Invited', 'warning'\)/)
  assert.match(script, /profile\.employee_id/)
  assert.match(script, /authenticatedRequest\('\/resend-invite'/)
  assert.match(script, /actionMenu\.appendChild\(resendButton\)/)
  assert.match(script, /if \(profile\.onboarding_status === 'invited'\)/)
  assert.match(endpoint, /if \(!profile\)/)
  assert.match(endpoint, /profile\.onboarding_status !== 'invited'/)
  assert.match(endpoint, /auth\/v1\/recover/)
  assert.match(endpoint, /employee_invitation_resent/)
  assert.match(middleware, /'\/resend-invite'/)
})
