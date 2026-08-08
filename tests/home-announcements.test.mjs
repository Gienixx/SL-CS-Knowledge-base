import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Home exposes Announcement Management to admins and announcement managers', async () => {
  const page = await read('home.html')
  const script = await read('scripts/home.js')

  assert.match(page, /id="homeAnnouncementManagementBtn"[^>]+announcement-management\.html[^>]+hidden/)
  assert.match(script, /homeAnnouncementManagementBtn/)
  assert.match(script, /hasWorkforcePermission\(access, 'manage_announcements'\)/)
})

test('Home separates and paginates announcements and Updates independently', async () => {
  const page = await read('home.html')
  const script = await read('scripts/home.js')
  const stylesheet = await read('styles/home-reference-redesign.css')

  assert.match(page, /id="announcementsFeedTitle">Announcements</)
  assert.match(page, /id="changelogFeedTitle">Updates and changelogs</)
  assert.match(page, /id="announcementRows"/)
  assert.match(page, /id="updateRows"/)
  assert.match(page, /id="announcementPreviousPage"/)
  assert.match(page, /id="announcementNextPage"/)
  assert.match(page, /id="announcementPageStatus"[^>]*>Page 1 of 1</)
  assert.match(page, /id="updatePreviousPage"/)
  assert.match(page, /id="updateNextPage"/)
  assert.match(page, /id="updatePageStatus"[^>]*>Page 1 of 1</)
  assert.match(script, /const ANNOUNCEMENT_PAGE_SIZE = 10/)
  assert.match(script, /\.from\('team_announcements'\)/)
  assert.match(script, /const ANNOUNCEMENT_PAGE_SIZE = 10/)
  assert.match(script, /announcements:\s*\{[\s\S]*?page: 1[\s\S]*?updatesOnly: false/)
  assert.match(script, /updates:\s*\{[\s\S]*?page: 1[\s\S]*?updatesOnly: true/)
  assert.match(script, /\.eq\('status', 'published'\)/)
  assert.match(script, /query\.eq\('category', 'Updates'\)/)
  assert.match(script, /query\.neq\('category', 'Updates'\)/)
  assert.match(script, /\.select\(columns, \{ count: 'exact' \}\)/)
  assert.match(script, /\.order\('published_at', \{ ascending: false \}\)/)
  assert.match(script, /\.order\('id', \{ ascending: false \}\)/)
  assert.match(script, /\.range\(from, to\)/)
  assert.match(script, /Math\.ceil\(feed\.count \/ ANNOUNCEMENT_PAGE_SIZE\)/)
  assert.match(script, /moveAnnouncementFeedPage\('announcements', -1\)/)
  assert.match(script, /moveAnnouncementFeedPage\('announcements', 1\)/)
  assert.match(script, /moveAnnouncementFeedPage\('updates', -1\)/)
  assert.match(script, /moveAnnouncementFeedPage\('updates', 1\)/)
  assert.match(script, /renderAnnouncementFeed\(\s*announcementBody,\s*announcements/)
  assert.match(script, /renderAnnouncementFeed\(\s*updateBody,\s*updates/)
  assert.match(script, /createTeamUpdate/)
  assert.match(script, /dateColumn\.textContent = 'Date'/)
  assert.match(script, /titleColumn\.textContent = 'Title'/)
  assert.match(script, /unlabeledColumn\.setAttribute\('aria-hidden', 'true'\)/)
  assert.match(page, /id="announcementDialog"/)
  assert.match(page, /id="announcementDialogBody"/)
  assert.match(script, /openAnnouncementDialog\(announcement\)/)
  assert.match(script, /dialog\.showModal\(\)/)
  assert.match(stylesheet, /\.team-update-pagination\s*\{/)
  assert.match(stylesheet, /\.team-update-pagination\[hidden\]\s*\{\s*display:\s*none/)
  assert.match(stylesheet, /\.updates-panel \.team-update-feeds \{ flex: 1 1 auto; \}/)
  assert.match(stylesheet, /\.updates-panel \{ align-self: stretch; \}/)
  assert.match(stylesheet, /\.updates-panel \.team-update-feed \{ min-height: 0; flex: 1 1 0; \}/)
  assert.match(stylesheet, /\.updates-panel \.team-updates-body\.has-updates[\s\S]*overflow-y: auto/)
  assert.match(stylesheet, /\.updates-panel \.team-update-feed:first-child \.team-update-pagination \{\s*justify-content: center;/)

  const rowFunction = script.match(
    /function createTeamUpdate\(announcement\) \{[\s\S]*?\n\}/
  )?.[0] || ''
  assert.doesNotMatch(rowFunction, /announcement\.body|published_by_name/)
})

test('Announcement Management provides draft and publish workflows', async () => {
  const page = await read('announcement-management.html')
  const script = await read('scripts/announcement-management.js')

  assert.match(page, /id="announcementForm"/)
  assert.match(page, /id="announcementSaveDraft"/)
  assert.match(page, /id="announcementPublish"/)
  assert.match(page, /id="announcementList"/)
  assert.match(page, /<option>Updates<\/option>/)
  assert.match(page, /Updates appear in Updates and changelogs/)
  assert.match(script, /hasWorkforcePermission\(access, 'manage_announcements'\)/)
  assert.match(script, /\.insert\(/)
  assert.match(script, /\.update\(/)
  assert.match(script, /\.delete\(\)/)
  assert.match(script, /published_at/)
})

test('Announcement messages support sanitized rich-text formatting', async () => {
  const page = await read('announcement-management.html')
  const adminScript = await read('scripts/announcement-management.js')
  const homeScript = await read('scripts/home.js')
  const richText = await read('scripts/announcement-rich-text.js')

  assert.match(page, /data-format-command="bold"/)
  assert.match(page, /data-format-command="italic"/)
  assert.match(page, /data-format-command="underline"/)
  assert.match(page, /data-format-command="insertUnorderedList"/)
  assert.match(page, /id="announcementMessageEditor"[^>]+contenteditable="true"/)
  assert.match(adminScript, /sanitizeAnnouncementHtml\(elements\.messageEditor\.innerHTML\)/)
  assert.match(adminScript, /document\.execCommand\(command, false, null\)/)
  assert.match(adminScript, /renderAnnouncementHtml\(body, item\.body\)/)
  assert.match(homeScript, /renderAnnouncementHtml\([\s\S]*announcement\.body/)
  assert.match(richText, /const ALLOWED_TAGS/)
  assert.match(richText, /'STRONG'/)
  assert.match(richText, /'U'/)
  assert.match(richText, /'UL'/)
  assert.match(richText, /const BLOCKED_TAGS/)
  assert.match(richText, /node\.removeAttribute\(attribute\.name\)/)
})

test('Announcement dialog uses the wider responsive layout', async () => {
  const page = await read('home.html')
  const stylesheet = await read('styles/home-reference-redesign.css')

  assert.match(page, /home-reference-redesign\.css\?v=21/)
  assert.match(stylesheet, /\.announcement-dialog\s*\{[^}]*width:\s*min\(900px, calc\(100vw - 64px\)\)/)
  assert.match(stylesheet, /@media \(max-width: 680px\)[\s\S]*\.announcement-dialog\s*\{[^}]*width:\s*calc\(100vw - 32px\)/)
})

test('Home gives more desktop width to updates and equal lower panels', async () => {
  const stylesheet = await read('styles/home-reference-redesign.css')

  assert.match(
    stylesheet,
    /\.cols\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1\.65fr\) minmax\(300px, 1fr\)/
  )
  assert.match(
    stylesheet,
    /\.home-lower-panels\s*\{[^}]*grid-template-columns:\s*1fr 1fr/
  )
  assert.match(
    stylesheet,
    /@media \(max-width: 1000px\)[\s\S]*\.cols\s*\{[^}]*grid-template-columns:\s*1fr/
  )
})

test('Announcement records use RLS for published reads and admin writes', async () => {
  const migration = await read('supabase/migrations/20260718082259_team_announcements.sql')

  assert.match(migration, /alter table public\.team_announcements enable row level security/)
  assert.match(migration, /status = 'published'/)
  assert.match(migration, /public\.workforce_current_user_is_active\(\)/)
  assert.match(migration, /public\.workforce_is_admin\(\)/)
  assert.match(migration, /public\.workforce_is_current_identity\(created_by\)/)
  assert.match(migration, /for insert[\s\S]*?for update[\s\S]*?for delete/)
  assert.match(migration, /grant select, insert, update, delete on public\.team_announcements to authenticated/)
})

test('Announcement browser modules have valid JavaScript syntax', () => {
  for (const script of [
    'scripts/home.js',
    'scripts/announcement-management.js',
    'scripts/announcement-rich-text.js'
  ]) {
    const result = spawnSync(process.execPath, ['--check', script], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8'
    })

    assert.equal(result.status, 0, result.stderr)
  }
})
