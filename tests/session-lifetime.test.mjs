import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Supabase client enforces a fixed 24-hour browser session lifetime', async () => {
  const client = await read('scripts/supabaseClient.js')

  assert.match(client, /SESSION_MAX_AGE_MS = 24 \* 60 \* 60 \* 1000/)
  assert.match(client, /sl-cs-session-started-at/)
  assert.match(client, /supabase\.auth\.signOut\(\{ scope: 'local' \}\)/)
  assert.match(client, /window\.setTimeout/)
  assert.match(client, /visibilitychange/)
  assert.match(client, /window\.addEventListener\('focus'/)
  assert.match(client, /export const sessionLifetimeReady/)
})

test('successful password login starts the lifetime and expired sessions explain the logout', async () => {
  const [loginPage, loginScript, authGuard] = await Promise.all([
    read('login.html'),
    read('scripts/login.js'),
    read('scripts/auth-guard.js')
  ])

  assert.match(loginPage, /scripts\/login\.js\?v=4/)
  assert.match(loginScript, /startSessionLifetime\(data\.session\)/)
  assert.match(loginScript, /await sessionLifetimeReady/)
  assert.match(loginScript, /sessionExpired/)
  assert.match(loginScript, /Your session expired\. Please sign in again\./)
  assert.match(authGuard, /await enforceSessionLifetime\(\)/)
})
