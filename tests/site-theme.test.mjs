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

test('Admin Tool reuses the shared theme controller and theme variables', async () => {
  const page = await read('admintool.html')
  assert.match(page, /styles\/site-theme\.css\?v=5/)
  assert.match(page, /scripts\/site-theme\.js\?v=1/)
  assert.match(page, /html\[data-site-theme="light"\]/)
  assert.match(page, /--input-bg:var\(--input-bg\)|background:var\(--input-bg\)/)
  assert.doesNotMatch(page, /localStorage|data-theme-choice|SocialLoopTheme\.set/)
})

test('Admin Tool Playground uses the shared authenticated employee identity gate', async () => {
  const [entry, access, home] = await Promise.all([
    read('scripts/admin-tool-entry.js'),
    read('shared/admin-tool-access.js'),
    read('scripts/home.js')
  ])

  assert.match(entry, /loadCurrentWorkforceAccess\(supabase, \{[\s\S]*allowLegacyFallback: false/)
  assert.match(entry, /canAccessAdminToolPlayground\(access\)/)
  assert.match(entry, /window\.location\.replace\('\.\/home\.html'\)/)
  assert.match(access, /access\.employee_id === ADMIN_TOOL_PLAYGROUND_EMPLOYEE_ID/)
  assert.match(home, /canAccessAdminToolPlayground\(access\)/)
  assert.match(access, /access\.is_admin === true[\s\S]*access\.employee_id === ADMIN_TOOL_PLAYGROUND_EMPLOYEE_ID/)
})

test('Home places account and appearance settings between identity and logout', async () => {
  const page = await read('home.html')
  const identity = page.indexOf('class="who"')
  const settings = page.indexOf('id="siteSettingsButton"')
  const menu = page.indexOf('id="siteSettingsMenu"')
  const changePassword = page.indexOf('id="homeChangePasswordBtn"')
  const menuEnd = page.indexOf('</div>', changePassword)
  const logout = page.indexOf('id="homeLogoutBtn"')

  assert.ok(identity >= 0 && identity < settings)
  assert.ok(settings < menu && menu < logout)
  assert.ok(menu < changePassword && changePassword < menuEnd)
  assert.match(page, /aria-label="Settings"/)
  assert.match(page, /styles\/site-theme\.css\?v=5/)
  assert.match(page, /scripts\/home\.js\?v=11/)
  assert.match(page, /data-theme-choice="light"/)
  assert.match(page, /data-theme-choice="dark"/)
  assert.match(page, /class="site-settings-action" href="\.\/change-password\.html"/)
  assert.doesNotMatch(page, /class="settings-link" href="\.\/change-password\.html"/)
})

test('Change Password is available to agents, admins, and system admins', async () => {
  const script = await read('scripts/home.js')
  const stylesheet = await read('styles/site-theme.css')

  assert.match(
    script,
    /changePasswordButton\.hidden = !\([\s\S]*access\.is_agent === true[\s\S]*access\.is_admin === true[\s\S]*access\.is_system_admin === true/
  )
  assert.match(stylesheet, /\.site-settings-account \{[\s\S]*border-top: 1px solid var\(--site-border\)/)
  assert.match(stylesheet, /\.site-settings-action \{[\s\S]*color: var\(--site-text\)/)
  assert.match(stylesheet, /\.site-settings-menu \{[\s\S]*right: auto;[\s\S]*left: 0;[\s\S]*width: 100%;/)
  assert.match(stylesheet, /\.home-layout\.sidebar-collapsed \.site-settings-menu \{[\s\S]*left: calc\(100% \+ 8px\);[\s\S]*width: 224px;/)
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

test('Change Password uses readable Attendance-style dark surfaces', async () => {
  const page = await read('change-password.html')
  const stylesheet = await read('styles/site-theme.css')

  assert.match(page, /class="password-card"/)
  assert.match(page, /styles\/site-theme\.css\?v=6/)
  assert.match(
    stylesheet,
    /html\[data-site-theme="dark"\] body:has\(\.password-card\) \{[\s\S]*--card-bg: var\(--site-surface-solid\)[\s\S]*--text-primary: var\(--site-text\)[\s\S]*--button-bg: var\(--site-gold\)/
  )
  assert.match(
    stylesheet,
    /body:has\(\.password-card\) \.password-card \{[\s\S]*background: linear-gradient\([\s\S]*box-shadow: var\(--site-shadow\)/
  )
  assert.match(
    stylesheet,
    /body:has\(\.password-card\) \.back-link \{[\s\S]*border: 0;[\s\S]*background: transparent;/
  )
})
