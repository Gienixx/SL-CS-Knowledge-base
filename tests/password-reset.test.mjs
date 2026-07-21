import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('login page exposes an accessible forgot-password dialog', async () => {
  const loginPage = await read('login.html')

  assert.match(loginPage, /id="forgotPasswordButton"/)
  assert.match(loginPage, /id="forgotPasswordModal" hidden/)
  assert.match(loginPage, /role="dialog" aria-modal="true"/)
  assert.match(loginPage, /id="resetEmail"[^>]+type="email"/)
})

test('password recovery sends an email to the public change-password page', async () => {
  const loginScript = await read('scripts/login.js')
  const changePasswordScript = await read('scripts/change-password.js')

  assert.match(loginScript, /resetPasswordForEmail/)
  assert.match(loginScript, /change-password\.html\?reset=1/)
  assert.match(loginScript, /If an account exists for that email/)
  assert.match(changePasswordScript, /isPasswordReset/)
  assert.match(changePasswordScript, /updatePasswordStrength/)
  assert.match(changePasswordScript, /evaluatePassword/)
  assert.match(changePasswordScript, /Passwords match/)
  assert.match(changePasswordScript, /supabase\.auth\.updateUser/)
  assert.match(changePasswordScript, /supabase\.auth\.signOut/)
})
