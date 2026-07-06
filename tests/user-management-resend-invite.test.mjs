import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('user management exposes a selection-based resend invite action', async () => {
  const [html, script] = await Promise.all([
    read('user-management.html'),
    read('scripts/user-management-resend-invite.js')
  ])

  assert.match(html, /id="resendInviteButton"[^>]*disabled/)
  assert.match(html, /scripts\/user-management-resend-invite\.js/)
  assert.match(script, /resetPasswordForEmail/)
  assert.match(script, /change-password\.html\?invite=1/)
  assert.match(script, /\.um-select:checked/)
  assert.doesNotMatch(script, /\/create-user|\/delete-user/)
})
