import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { canAccessAdminToolPlayground } from '../shared/admin-tool-access.js'
import { hasWorkforcePermission, normalizeWorkforceAccess } from '../shared/workforce-access.js'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Home separates management links from My work', async () => {
  const page = await read('home.html')
  const myWorkGroup = page.match(
    /<div class="nav-group">\s*<p class="nav-label">My work<\/p>[\s\S]*?<\/div>/
  )?.[0] || ''
  const managementGroup = page.match(
    /<div class="nav-group management-nav-group">\s*<p class="nav-label">Site management<\/p>[\s\S]*?<\/div>/
  )?.[0] || ''

  assert.match(myWorkGroup, /homeMyScheduleBtn/)
  assert.match(myWorkGroup, /homeLeaveRequestsBtn/)
  assert.match(myWorkGroup, /homeTeamAttendanceBtn/)
  assert.doesNotMatch(myWorkGroup, /homeWorkforceManagementBtn|homeArticleManagementBtn|homeAnnouncementManagementBtn/)

  assert.match(managementGroup, /homeWorkforceManagementBtn/)
  assert.match(managementGroup, /homeArticleManagementBtn/)
  assert.match(managementGroup, /homeAnnouncementManagementBtn/)
  assert.match(managementGroup, /homeAdminToolPlaygroundBtn/)
})

test('Admin Tool Playground is available to active workforce users without granting admin access', async () => {
  const [page, script, mockup, access] = await Promise.all([
    read('home.html'),
    read('scripts/home.js'),
    read('admintool.html'),
    read('shared/admin-tool-access.js')
  ])

  assert.match(page, /id="homeAdminToolPlaygroundBtn"[^>]+href="\.\/admintool\.html"[^>]+hidden/)
  assert.match(script, /adminToolPlaygroundButton\.hidden = !canAccessAdminToolPlayground\(access\)/)
  assert.match(access, /access\?\.allowed === true/)

  const activeAgent = normalizeWorkforceAccess(
    { user_id: 'agent-1', is_active: true, is_agent: true },
    { user: { id: 'agent-1' } }
  )
  assert.equal(canAccessAdminToolPlayground(activeAgent), true)
  assert.equal(activeAgent.is_admin, false)
  assert.equal(activeAgent.is_system_admin, false)
  for (const permission of ['manage_employees', 'manage_schedules', 'approve_leave', 'manage_payroll', 'finalize_payroll']) {
    assert.equal(hasWorkforcePermission(activeAgent, permission), false)
  }
  assert.equal(canAccessAdminToolPlayground(
    normalizeWorkforceAccess(null, { user: null, source: 'unauthenticated' })
  ), false)
  assert.equal(canAccessAdminToolPlayground(
    normalizeWorkforceAccess(
      { user_id: 'inactive-1', is_active: false, is_agent: true },
      { user: { id: 'inactive-1' } }
    )
  ), false)
  assert.match(mockup, /scripts\/admin-tool-entry\.js\?v=1/)
  assert.match(mockup, /href="\.\/home\.html">← Home<\/a>/)
  assert.doesNotMatch(mockup, /supabase|fetch\(|XMLHttpRequest|\.rpc\(|\.from\(/i)
})

test('management divider is hidden when the user has no management links', async () => {
  const stylesheet = await read('styles/home-reference-redesign.css')

  assert.match(
    stylesheet,
    /\.management-nav-group:not\(:has\(\.sidebar-link:not\(\[hidden\]\)\)\) \{ display: none; \}/
  )
})
