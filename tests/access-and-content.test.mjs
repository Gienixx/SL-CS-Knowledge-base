import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('the supported user management page and module remain connected', async () => {
  const [html, script, client, onboarding] = await Promise.all([
    read('user-management.html'),
    read('scripts/user-management.js'),
    read('scripts/supabaseClient.js'),
    read('docs/README-first-login.md')
  ])
  assert.match(html, /scripts\/user-management\.js/)
  assert.match(html, /id="inviteUserForm"/)
  assert.match(script, /requireAdmin/)
  assert.doesNotMatch(client, /admin\.html|admin-invite-protocol/)
  assert.match(onboarding, /user-management\.html/)
})

test('knowledge-base authoring and published article rendering remain connected', async () => {
  const [knowledgeBase, article, articleScript, editor] = await Promise.all([
    read('KB.html'), read('article.html'), read('scripts/article.js'), read('add-article.html')
  ])
  assert.match(knowledgeBase, /scripts\/kb\.js/)
  assert.match(article, /scripts\/article\.js/)
  assert.match(articleScript, /article-content-renderer-v7\.js/)
  assert.match(editor, /scripts\/add-article\.js/)
})

test('authentication and first-login pages remain connected', async () => {
  const [login, loginScript, password, firstLoginPolicy] = await Promise.all([
    read('login.html'), read('scripts/login.js'), read('change-password.html'), read('scripts/first-login-policy.js')
  ])
  assert.match(login, /id="loginForm"/)
  assert.match(loginScript, /signInWithPassword/)
  assert.match(password, /scripts\/change-password\.js/)
  assert.match(firstLoginPolicy, /requiresFirstLoginPasswordChange/)
})
