import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('deleted employee reinvitation stays pending until invite acceptance', async () => {
  const [migration, endpoint, middleware] = await Promise.all([
    read('supabase/migrations/20260730181438_reinvite_deleted_employee_after_acceptance.sql'),
    read('functions/reinvite-deleted-employee.js'),
    read('functions/_middleware.js')
  ])

  assert.match(migration, /private\.workforce_deleted_employee_identities/)
  assert.match(migration, /private\.workforce_deleted_employee_reinvites/)
  assert.match(migration, /email_hash bytea not null/)
  assert.doesNotMatch(migration, /workforce_deleted_employee_identities[\s\S]{0,500}former_email\s+text/i)
  assert.match(migration, /status in \('pending', 'accepted', 'completed', 'cancelled'\)/)
  assert.match(migration, /profile_still_archived', true/)
  assert.match(migration, /after update of last_sign_in_at on auth\.users/)
  assert.match(migration, /deleted_employee_restoration_started/)
  assert.match(migration, /account_deleted_at = null/)
  assert.match(endpoint, /auth\/v1\/invite/)
  assert.match(endpoint, /auth\/v1\/recover/)
  assert.match(endpoint, /workforce_service_prepare_deleted_employee_reinvite/)
  assert.match(endpoint, /restorationPending: true/)
  assert.match(endpoint, /profileStillArchived: true/)
  assert.match(middleware, /'\/reinvite-deleted-employee'/)
})

test('accepted reinvite reuses the original employee profile and identity history', async () => {
  const migration = await read(
    'supabase/migrations/20260730181438_reinvite_deleted_employee_after_acceptance.sql'
  )

  assert.match(migration, /profile_user_id = v_reinvite\.profile_user_id/)
  assert.match(migration, /insert into public\.workforce_identity_links/)
  assert.match(migration, /new\.id,[\s\S]*v_profile\.user_id,[\s\S]*'manual'/)
  assert.match(migration, /history_preserved', true/)
  assert.doesNotMatch(
    migration,
    /workforce_restore_deleted_employee_after_invite_acceptance[\s\S]*insert into public\.profiles/i
  )
  assert.match(
    migration,
    /workforce_complete_profile_after_user_password_created[\s\S]*workforce_identity_links[\s\S]*onboarding_status = 'active'/
  )
})

test('future deletions retain a hash for controlled reinvitation and no live email', async () => {
  const migration = await read(
    'supabase/migrations/20260730181438_reinvite_deleted_employee_after_acceptance.sql'
  )

  assert.match(migration, /extensions\.digest\(lower\(trim\(v_profile\.email\)\), 'sha256'\)/)
  assert.match(migration, /v_deleted_email :=[\s\S]*@deleted\.invalid/)
  assert.match(migration, /delete from public\.login/)
  assert.match(migration, /update public\.workforce_identity_links[\s\S]*is_active = false/)
})

test('workforce UI exposes archived employees only for controlled reinvitation', async () => {
  const [client, html] = await Promise.all([
    read('scripts/workforce.js'),
    read('workforce.html')
  ])

  assert.match(html, /option value="archived">Archived/)
  assert.match(client, /badge\('Archived', 'muted'\)/)
  assert.match(client, /Reinvite employee/)
  assert.match(client, /\/reinvite-deleted-employee/)
  assert.match(client, /remains archived until the link is accepted/i)
  assert.doesNotMatch(client, /\.is\('account_deleted_at', null\)/)
})

test('linked Auth IDs remain editable and deletable after restoration', async () => {
  const [editor, lifecycle] = await Promise.all([
    read('functions/update-employee.js'),
    read('functions/employee-lifecycle.js')
  ])

  assert.match(editor, /profile_user_id', `eq\.\$\{userId\}`/)
  assert.match(editor, /snapshot\.authUserId/)
  assert.match(editor, /verifyIdentity\([\s\S]*snapshot\.authUserId/)
  assert.match(lifecycle, /loadLinkedAuthUserIds/)
  assert.match(lifecycle, /for \(const authUserId of authUserIds\)/)
  assert.match(lifecycle, /auth\/v1\/admin\/users\/\$\{encodeURIComponent\(authUserId\)\}/)
})
