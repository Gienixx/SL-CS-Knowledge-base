import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Activity Log navigation is present and restricted to admins', async () => {
  const [home, navigation, activityPage] = await Promise.all([
    read('home.html'),
    read('scripts/home-workforce-nav.js'),
    read('scripts/activity-log.js')
  ])

  assert.match(
    home,
    /id="homeActivityLogBtn"[^>]*class="sidebar-link"[^>]*href="\.\/activity-log\.html"[^>]*hidden/
  )
  assert.match(home, /nav-label">Site management[\s\S]*homeActivityLogBtn/)
  assert.match(navigation, /homeActivityLogBtn/)
  assert.match(navigation, /activityLogButton\.hidden\s*=\s*access\.is_admin\s*!==\s*true/)
  assert.match(activityPage, /if \(!access\.is_admin\) \{ window\.location\.replace\('\.\/home\.html'\)/)
})
