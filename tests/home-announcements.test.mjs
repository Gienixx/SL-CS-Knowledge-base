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

test('Home loads the latest published announcements', async () => {
  const page = await read('home.html')
  const script = await read('scripts/home.js')

  assert.match(script, /\.from\('team_announcements'\)/)
  assert.match(script, /\.eq\('status', 'published'\)/)
  assert.match(script, /\.order\('published_at', \{ ascending: false \}\)/)
  assert.match(script, /\.limit\(5\)/)
  assert.match(script, /createTeamUpdate/)
  assert.match(script, /dateColumn\.textContent = 'Date'/)
  assert.match(script, /titleColumn\.textContent = 'Title'/)
  assert.match(script, /unlabeledColumn\.setAttribute\('aria-hidden', 'true'\)/)
  assert.match(page, /id="announcementDialog"/)
  assert.match(page, /id="announcementDialogBody"/)
  assert.match(script, /openAnnouncementDialog\(announcement\)/)
  assert.match(script, /dialog\.showModal\(\)/)

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

test('Announcement records use RLS for published reads and admin writes', async () => {
  const migration = await read('supabase/migrations/20260718081705_team_announcements.sql')

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
