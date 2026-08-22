import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  activeImportantAnnouncements,
  eligibleImportantAnnouncementCount,
  importantAnnouncementNavigation,
  importantAnnouncementStorageKey,
  nextImportantAnnouncementIndex,
  sessionAnnouncementKey
} from '../shared/important-announcement-popup.js'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const announcement = (overrides = {}) => ({
  id: 'announcement-1',
  title: 'Notice',
  body: '<p>Notice</p>',
  status: 'published',
  is_important: true,
  published_at: '2026-08-22T01:00:00.000Z',
  ...overrides
})

test('zero Important announcements produces no popup candidates', () => {
  assert.deepEqual(activeImportantAnnouncements([]), [])
  assert.deepEqual(activeImportantAnnouncements([announcement({ is_important: false })]), [])
})

test('one published Important announcement is selected for the modal', () => {
  assert.deepEqual(activeImportantAnnouncements([announcement()]), [announcement()])
})

test('two Important announcements are newest-first and use one sequence', () => {
  const older = announcement({ id: 'older', published_at: '2026-08-21T01:00:00.000Z' })
  const newer = announcement({ id: 'newer', published_at: '2026-08-22T01:00:00.000Z' })

  assert.deepEqual(activeImportantAnnouncements([older, newer]), [newer, older])
  assert.deepEqual(importantAnnouncementNavigation(0, 2), {
    index: 0,
    showNavigation: true,
    backDisabled: true,
    nextLabel: 'Next'
  })
  assert.equal(nextImportantAnnouncementIndex(0, 1, 2), 1)
  assert.deepEqual(importantAnnouncementNavigation(1, 2), {
    index: 1,
    showNavigation: true,
    backDisabled: false,
    nextLabel: 'Done'
  })
  assert.equal(nextImportantAnnouncementIndex(1, 1, 2), 1)
})

test('quota counts only eligible published Important rows and preserves the exact limit contract', async () => {
  const migration = await read('supabase/migrations/20260821211837_important_announcements.sql')

  assert.match(migration, /create or replace function public\.enforce_team_announcements_important_limit/)
  assert.match(migration, /pg_advisory_xact_lock\(814739201\)/)
  assert.match(migration, /new\.status = 'published'/)
  assert.match(migration, /existing\.is_important is true[\s\S]*existing\.status = 'published'/)
  assert.match(migration, /Maximum of 2 Important announcements allowed\./)
  assert.match(migration, /before insert or update or delete on public\.team_announcements/)
  assert.doesNotMatch(migration, /before insert or update of is_important/)

  const rows = [
    announcement({ id: 'one' }),
    announcement({ id: 'two' }),
    announcement({ id: 'draft', status: 'draft' }),
    announcement({ id: 'expired', expires_at: '2026-08-21T01:00:00.000Z' })
  ]
  assert.equal(eligibleImportantAnnouncementCount(rows, null, Date.parse('2026-08-22T03:00:00.000Z')), 2)
  assert.equal(eligibleImportantAnnouncementCount(rows, 'one', Date.parse('2026-08-22T03:00:00.000Z')), 1)
})

test('eligibility transitions free and re-enforce slots', () => {
  const rows = [
    announcement({ id: 'one' }),
    announcement({ id: 'two' }),
    announcement({ id: 'third', status: 'draft' })
  ]
  const now = Date.parse('2026-08-22T03:00:00.000Z')

  assert.equal(eligibleImportantAnnouncementCount(rows, null, now), 2)
  rows[0].status = 'draft'
  assert.equal(eligibleImportantAnnouncementCount(rows, null, now), 1)
  rows[2].status = 'published'
  assert.equal(eligibleImportantAnnouncementCount(rows, null, now), 2)
  rows[0].status = 'published'
  assert.equal(eligibleImportantAnnouncementCount(rows, null, now), 3)
})

test('concurrency locking covers every eligibility-changing table write', async () => {
  const migration = await read('supabase/migrations/20260821211837_important_announcements.sql')
  const lockPosition = migration.indexOf('pg_advisory_xact_lock(814739201)')
  const countPosition = migration.indexOf('select count(*)')

  assert.ok(lockPosition >= 0)
  assert.ok(countPosition > lockPosition)
  assert.match(migration, /before insert or update or delete on public\.team_announcements/)
  assert.match(migration, /if tg_op = 'DELETE' then[\s\S]*return old;/)
})

test('unpublished, deleted, and inactive Important announcements are excluded', () => {
  const rows = [
    announcement({ id: 'draft', status: 'draft' }),
    announcement({ id: 'deleted', deleted_at: '2026-08-22T02:00:00.000Z' }),
    announcement({ id: 'expired', expires_at: '2026-08-21T01:00:00.000Z' }),
    announcement({ id: 'active' })
  ]

  assert.deepEqual(
    activeImportantAnnouncements(rows, Date.parse('2026-08-22T03:00:00.000Z')).map(row => row.id),
    ['active']
  )
})

test('a genuine new login session gets a new popup marker', () => {
  const first = { access_token: 'header.eyJzZXNzaW9uX2lkIjoic2Vzc2lvbi0xIn0.signature', user: { id: 'agent-1' } }
  const second = { access_token: 'header.eyJzZXNzaW9uX2lkIjoic2Vzc2lvbi0yIn0.signature', user: { id: 'agent-1' } }

  assert.notEqual(sessionAnnouncementKey(first), sessionAnnouncementKey(second))
  assert.notEqual(importantAnnouncementStorageKey(first), importantAnnouncementStorageKey(second))
})

test('refreshes and navigation reuse the same session marker', () => {
  const first = { access_token: 'header.eyJzZXNzaW9uX2lkIjoic2Vzc2lvbi0xIn0.signature', user: { id: 'agent-1' } }
  const refreshed = { access_token: 'new-header.eyJzZXNzaW9uX2lkIjoic2Vzc2lvbi0xIn0.signature', user: { id: 'agent-1' } }

  assert.equal(importantAnnouncementStorageKey(first), importantAnnouncementStorageKey(refreshed))
})

test('normal read/unread state does not suppress Important announcements', () => {
  const row = announcement({ is_read: true, read_at: '2026-08-22T02:00:00.000Z' })
  assert.equal(activeImportantAnnouncements([row]).length, 1)
})

test('announcement-fetch failure is caught without changing authentication flow', async () => {
  const source = await read('shared/important-announcement-popup.js')

  assert.match(source, /catch \(requestError\)/)
  assert.match(source, /Unable to load Important announcements/)
  assert.doesNotMatch(source, /auth\.signOut|auth\.updateUser|auth\.signIn/)
})

test('only authenticated users can use the popup query and management permission remains enforced', async () => {
  const source = await read('shared/important-announcement-popup.js')
  const policy = await read('supabase/migrations/20260718093749_add_announcement_manager_permission.sql')

  assert.match(source, /if \(error \|\| !data\?\.session\?\.user\) return/)
  assert.match(source, /\.eq\('status', 'published'\)/)
  assert.match(source, /\.eq\('is_important', true\)/)
  assert.match(policy, /workforce_has_permission\('manage_announcements'\)/)
})

test('popup uses the existing sanitized announcement renderer and no write operation', async () => {
  const source = await read('shared/important-announcement-popup.js')

  assert.match(source, /renderAnnouncementHtml\(body, announcement\.body \|\| ''\)/)
  assert.match(source, /gotIt\.textContent = 'Got it'/)
  assert.match(source, /\.select\('id, title, body, category, status, is_important, published_by_name, published_at, created_at'\)/)
  assert.doesNotMatch(source, /\.insert\(|\.update\(|\.delete\(/)
})

test('management pre-validation reuses popup eligibility and allows inactive Important drafts', async () => {
  const management = await read('scripts/announcement-management.js')

  assert.match(management, /eligibleImportantAnnouncementCount\(state\.announcements, excludeId\)/)
  assert.match(management, /action === 'published'[\s\S]*elements\.important\.checked/)
  assert.doesNotMatch(management, /function handleImportantToggle/)
})

test('Important cache versions are consistent across live references', async () => {
  const managementPage = await read('announcement-management.html')
  const homePage = await read('home.html')
  const client = await read('scripts/supabaseClient.js')
  const popup = await read('shared/important-announcement-popup.js')
  const linkTests = await read('tests/announcement-links-reactions.test.mjs')

  assert.match(managementPage, /announcement-management\.css\?v=7/)
  assert.match(managementPage, /announcement-management\.js\?v=8/)
  assert.match(homePage, /important-announcement-popup\.css\?v=2/)
  assert.match(client, /important-announcement-popup\.js\?v=2/)
  assert.match(popup, /important-announcement-popup\.css\?v=2/)
  assert.match(linkTests, /announcement-management\\\.js\\\?v=8/)
  assert.match(linkTests, /announcement-management\\\.css\\\?v=7/)
})
