import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')

function relativeLuminance(hex) {
  const channels = hex
    .replace('#', '')
    .match(/.{2}/g)
    .map(value => Number.parseInt(value, 16) / 255)
    .map(value => value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4)

  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2])
}

function contrastRatio(first, second) {
  const brightest = Math.max(relativeLuminance(first), relativeLuminance(second))
  const darkest = Math.min(relativeLuminance(first), relativeLuminance(second))
  return (brightest + 0.05) / (darkest + 0.05)
}

test('every website page loads the shared attendance theme', async () => {
  const files = (await readdir(root, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.html'))
    .map(entry => entry.name)

  assert.ok(files.length > 20)
  for (const file of files) {
    const page = await read(file)
    assert.match(page, /styles\/site-theme\.css\?v=\d+/, `${file} should load the shared theme`)
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

test('Knowledge Base articles retain readable dark surfaces', async () => {
  const page = await read('KB.html')
  const stylesheet = await read('styles/site-theme.css')
  const darkTokens = stylesheet.match(
    /html\[data-site-theme="dark"\] \{([\s\S]*?)\n\}/
  )?.[1] || ''
  const token = name => darkTokens.match(
    new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i')
  )?.[1]

  assert.match(page, /id="kbSearch"/)
  assert.match(page, /styles\/site-theme\.css\?v=2/)
  assert.match(
    stylesheet,
    /html\[data-site-theme="dark"\] body:has\(#kbSearch\) \{[\s\S]*--panel-bg: var\(--site-surface-solid\)[\s\S]*--text-primary: var\(--site-text\)/
  )
  assert.match(
    stylesheet,
    /body:has\(#kbSearch\) :is\([\s\S]*\.article-body \.step-card,[\s\S]*\.article-body \.rich-table-wrapper[\s\S]*background: var\(--site-surface-soft\) !important/
  )
  assert.match(
    stylesheet,
    /body:has\(#kbSearch\) \.article-body \.article-inline-link \{[\s\S]*color: var\(--site-blue\) !important/
  )
  assert.ok(contrastRatio(token('--site-surface-solid'), token('--site-text')) >= 4.5)
  assert.ok(contrastRatio(token('--site-surface-solid'), token('--site-heading')) >= 4.5)
  assert.ok(contrastRatio(token('--site-surface-solid'), token('--site-muted')) >= 4.5)
})
