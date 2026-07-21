import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

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
})

test('management divider is hidden when the user has no management links', async () => {
  const stylesheet = await read('styles/home-reference-redesign.css')

  assert.match(
    stylesheet,
    /\.management-nav-group:not\(:has\(\.sidebar-link:not\(\[hidden\]\)\)\) \{ display: none; \}/
  )
})
