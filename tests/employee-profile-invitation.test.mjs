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

test('only invited employees receive a server-owned resend action', async () => {
  const [html, script, endpoint, middleware] = await Promise.all([
    read('workforce.html'),
    read('scripts/workforce.js'),
    read('functions/resend-invite.js'),
    read('functions/_middleware.js')
  ])

  assert.match(html, /<th>User<\/th>/)
  assert.doesNotMatch(html, /<th>.*UUID.*<\/th>/i)
  assert.match(script, /onboarding_status/)
  assert.match(
    script,
    /if \(profile\.onboarding_status === 'invited'\) \{[\s\S]*?badge\('Invited', 'warning'\)[\s\S]*?\} else \{[\s\S]*?STATUS_LABELS\[profile\.employment_status\]/
  )
  assert.match(script, /profile\.employee_id/)
  assert.match(script, /authenticatedRequest\('\/resend-invite'/)
  assert.match(script, /actionMenu\.appendChild\(resendButton\)/)
  assert.match(script, /profile\.onboarding_status === 'invited'/)
  assert.doesNotMatch(script, /\['invited', 'active'\]\.includes\(profile\.onboarding_status\)/)
  assert.match(script, /\['active', 'on_leave'\]\.includes\(profile\.employment_status\)/)
  assert.match(endpoint, /if \(!profile\)/)
  assert.match(endpoint, /profile\.onboarding_status !== 'invited'/)
  assert.doesNotMatch(endpoint, /employee_access_link_sent/)
  assert.match(endpoint, /profile\.account_deleted_at/)
  assert.match(endpoint, /auth\/v1\/recover/)
  assert.match(endpoint, /employee_invitation_resent/)
  assert.match(middleware, /'\/resend-invite'/)
})
