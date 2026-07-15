import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Step 9 authorizes every article surface through edit_articles', async () => {
  const paths = [
    'scripts/home.js', 'scripts/add-article.js', 'scripts/edit-article.js',
    'scripts/article-management.js', 'scripts/article-update-status-utils.js',
    'scripts/dashboard.js'
  ]
  const scripts = (await Promise.all(paths.map(read))).join('\n')
  assert.match(scripts, /edit_articles/)
  assert.match(scripts, /workforce-permissions\.js/)
  assert.doesNotMatch(scripts, /from\('login'\)|\.from\("login"\)/)
  assert.doesNotMatch(scripts, /can_edit_articles/)
})

test('database article and image policies use the canonical permission function', async () => {
  const [migration, verification] = await Promise.all([
    read('supabase/migrations/20260715144740_canonical_article_authorization.sql'),
    read('supabase/verification/canonical_article_authorization_check.sql')
  ])
  assert.match(migration, /user_permissions[\s\S]*permission_key = 'edit_articles'/)
  assert.match(migration, /workforce_identity_links/)
  assert.match(migration, /profile\.onboarding_status = 'active'/)
  assert.match(migration, /revoke all[\s\S]*from public, anon/)
  assert.match(migration, /with check \(public\.current_user_can_edit_articles\(\)\)/)
  assert.doesNotMatch(migration, /from public\.login/)
  assert.match(verification, /compatibility_mismatches/)
})
