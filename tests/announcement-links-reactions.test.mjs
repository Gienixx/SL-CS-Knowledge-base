import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('announcement editor inserts sanitized outside links', async () => {
  const [page, script, richText, stylesheet] = await Promise.all([
    read('announcement-management.html'),
    read('scripts/announcement-management.js'),
    read('scripts/announcement-rich-text.js'),
    read('styles/announcement-management.css')
  ])

  assert.match(page, /id="announcementLinkButton"[^>]+Add outside link/)
  assert.match(page, /id="announcementLinkDialog"/)
  assert.match(page, /id="announcementLinkText"/)
  assert.match(page, /id="announcementLinkUrl"[^>]+type="url"/)
  assert.match(page, /announcement-management\.js\?v=8/)
  assert.match(page, /announcement-management\.css\?v=7/)
  assert.match(script, /normalizeAnnouncementLink/)
  assert.match(script, /range\.insertNode\(anchor\)/)
  assert.match(script, /anchor\.target = '_blank'/)
  assert.match(script, /anchor\.rel = 'noopener noreferrer'/)
  assert.match(richText, /'A'/)
  assert.match(richText, /\['http:', 'https:'\]\.includes\(url\.protocol\)/)
  assert.match(richText, /node\.target = '_blank'/)
  assert.match(richText, /node\.rel = 'noopener noreferrer'/)
  assert.match(stylesheet, /\.announcement-message-editor a/)
})

test('Home lets each authenticated user like or dislike an announcement', async () => {
  const [page, script, stylesheet] = await Promise.all([
    read('home.html'),
    read('scripts/home.js'),
    read('styles/home-reference-redesign.css')
  ])

  assert.match(page, /home-reference-redesign\.css\?v=21/)
  assert.match(page, /scripts\/home\.js\?v=11/)
  assert.match(page, /data-announcement-reaction="like"/)
  assert.match(page, /data-announcement-reaction="dislike"/)
  assert.match(page, /id="announcementLikeCount"/)
  assert.match(page, /id="announcementDislikeCount"/)
  assert.match(script, /\.from\('announcement_reactions'\)/)
  assert.match(script, /\.upsert\([\s\S]*onConflict: 'announcement_id,user_id'/)
  assert.match(script, /\.delete\(\)[\s\S]*\.eq\('announcement_id', announcement\.id\)/)
  assert.match(script, /announcementReactionById\.set/)
  assert.match(script, /\.select\('like_count, dislike_count'\)/)
  assert.match(stylesheet, /\.announcement-dialog-reactions button\[aria-pressed="true"\]/)
})

test('announcement reactions are unique, owner-scoped, and maintain public counts', async () => {
  const [migration, verification] = await Promise.all([
    read('supabase/migrations/20260801101629_announcement_reactions.sql'),
    read('supabase/verification/announcement_reactions_check.sql')
  ])

  assert.match(migration, /add column if not exists like_count integer not null default 0/)
  assert.match(migration, /add column if not exists dislike_count integer not null default 0/)
  assert.match(migration, /create table public\.announcement_reactions/)
  assert.match(migration, /primary key \(announcement_id, user_id\)/)
  assert.match(migration, /reaction in \('like', 'dislike'\)/)
  assert.match(migration, /alter table public\.announcement_reactions enable row level security/)
  assert.match(migration, /for select[\s\S]*\(select auth\.uid\(\)\) = user_id/)
  assert.match(migration, /for insert[\s\S]*with check[\s\S]*\(select auth\.uid\(\)\) = user_id/)
  assert.match(migration, /for update[\s\S]*using[\s\S]*with check/)
  assert.match(migration, /for delete[\s\S]*\(select auth\.uid\(\)\) = user_id/)
  assert.match(migration, /grant select, insert, update, delete[\s\S]*to authenticated/)
  assert.match(migration, /revoke all on public\.announcement_reactions from anon/)
  assert.match(migration, /create or replace function private\.sync_announcement_reaction_counts\(\)/)
  assert.match(migration, /security definer[\s\S]*set search_path = ''/)
  assert.match(migration, /revoke all on function private\.sync_announcement_reaction_counts\(\)[\s\S]*from public, anon, authenticated/)
  assert.match(verification, /stored_counts_match_rows_should_be_zero/)
  assert.match(verification, /four_reaction_policies_should_be_true/)
})
