import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')

test('every website page loads the shared attendance theme', async () => {
  const files = (await readdir(root, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.html'))
    .map(entry => entry.name)

  assert.ok(files.length > 20)
  for (const file of files) {
    const page = await read(file)
    assert.match(page, /styles\/site-theme\.css\?v=1/, `${file} should load the shared theme`)
    assert.match(page, /scripts\/site-theme\.js\?v=1/, `${file} should load the theme controller`)
  }
})

test('Home places an accessible appearance control between identity and logout', async () => {
  const page = await read('home.html')
  const identity = page.indexOf('class="who"')
  const settings = page.indexOf('id="siteSettingsButton"')
  const menu = page.indexOf('id="siteSettingsMenu"')
  const logout = page.indexOf('id="homeLogoutBtn"')

  assert.ok(identity >= 0 && identity < settings)
  assert.ok(settings < menu && menu < logout)
  assert.match(page, /aria-label="Appearance settings"/)
  assert.match(page, /data-theme-choice="light"/)
  assert.match(page, /data-theme-choice="dark"/)
})

test('theme preference persists and remains synchronized with Attendance', async () => {
  const controller = await read('scripts/site-theme.js')
  const stylesheet = await read('styles/site-theme.css')

  assert.match(controller, /socialloop-site-theme/)
  assert.match(controller, /window\.localStorage\.setItem/)
  assert.match(controller, /attendanceThemeToggle/)
  assert.match(controller, /site-theme-change/)
  assert.match(stylesheet, /html\[data-site-theme="light"\]/)
  assert.match(stylesheet, /html\[data-site-theme="dark"\]/)
  assert.match(stylesheet, /--site-bg: #061323/)
  assert.match(
    stylesheet,
    /html\[data-site-theme="dark"\] :is\(\s*\.management-card,\s*\.article-preview-panel/
  )
  assert.match(
    stylesheet,
    /html\[data-site-theme="dark"\] \.payroll-period-row/
  )
  assert.match(
    stylesheet,
    /html\[data-site-theme="dark"\] \.calendar-day\.today/
  )
  assert.match(
    stylesheet,
    /html\[data-site-theme="dark"\] \.calendar-day\.has-work-schedule/
  )
  assert.match(stylesheet, /--site-green-soft:/)
  assert.match(stylesheet, /--site-amber-soft:/)
  assert.match(
    stylesheet,
    /html\[data-site-theme="dark"\] \.wf-view-switcher button\.active/
  )
  assert.match(
    stylesheet,
    /html\[data-site-theme="dark"\] \.wf-schedule-chip\.shift/
  )
  assert.match(
    stylesheet,
    /html\[data-site-theme="dark"\] \.wf-schedule-chip\.rest/
  )
  assert.match(
    stylesheet,
    /html\[data-site-theme="dark"\] \.wf-range-bar strong/
  )
  assert.match(
    stylesheet,
    /html\[data-site-theme="dark"\] :is\(\s*\.wf-summary strong,[\s\S]*?\.wf-permission-cell strong/
  )
  assert.match(
    stylesheet,
    /html\[data-site-theme="dark"\] \.wf-team-cell/
  )
})
