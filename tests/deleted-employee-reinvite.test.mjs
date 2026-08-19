import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('deleted employee reinvitation stays pending until invite acceptance', async () => {
  const [migration, endpoint, middleware] = await Promise.all([
    read('supabase/migrations/20260730182344_reinvite_deleted_employee_after_acceptance.sql'),
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
    'supabase/migrations/20260730182344_reinvite_deleted_employee_after_acceptance.sql'
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
    'supabase/migrations/20260730182344_reinvite_deleted_employee_after_acceptance.sql'
  )

  assert.match(migration, /extensions\.digest\(lower\(trim\(v_profile\.email\)\), 'sha256'\)/)
  assert.match(migration, /v_deleted_email :=[\s\S]*@deleted\.invalid/)
  assert.match(migration, /delete from public\.login/)
  assert.match(migration, /update public\.workforce_identity_links[\s\S]*is_active = false/)
})

test('workforce UI exposes archived employees only for controlled reinvitation', async () => {
  const [client, html, styles] = await Promise.all([
    read('scripts/workforce.js'),
    read('workforce.html'),
    read('styles/workforce-admin.css')
  ])

  assert.match(html, /option value="archived">Archived/)
  assert.match(client, /badge\('Archived', 'muted'\)/)
  assert.match(client, /Reinvite employee/)
  assert.match(client, /Resend restoration link/)
  assert.match(client, /\/reinvite-deleted-employee/)
  assert.match(client, /Restoration pending · Link last sent/)
  assert.match(client, /await loadWorkforceData\(\)[\s\S]*Restoration invitation resent/)
  assert.match(styles, /\.wf-status-note/)
  assert.match(client, /restoration_invite_pending/)
  assert.match(client, /window\.alert\(successMessage\)/)
  assert.match(client, /Restoration invitation was not sent/)
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

test('compatibility login sync reuses a reinvited employee stable profile ID', async () => {
  const migration = await read(
    'supabase/migrations/20260730194459_resolve_linked_profile_during_login_sync.sql'
  )

  assert.match(migration, /create or replace function public\.workforce_sync_login_record\(\)/i)
  assert.match(migration, /where identity_link\.auth_user_id = v_auth_user_id/i)
  assert.match(migration, /identity_link\.is_active is true/i)
  assert.match(migration, /v_profile_user_id := coalesce\(v_profile_user_id, v_auth_user_id\)/i)
  assert.match(migration, /insert into public\.profiles[\s\S]*v_profile_user_id/i)
  assert.match(migration, /insert into public\.user_permissions[\s\S]*v_profile_user_id/i)
  assert.doesNotMatch(migration, /values \(\s*v_auth_user_id,\s*v_name/i)
})

test('deleted employee reinvite delivery time remains visible after refresh', async () => {
  const migration = await read(
    'supabase/migrations/20260730195252_persist_deleted_employee_reinvite_timestamp.sql'
  )

  assert.match(migration, /after insert or update of last_sent_at/i)
  assert.match(migration, /invitation_last_sent_at = new\.last_sent_at/i)
  assert.match(migration, /account_deleted_at is not null/i)
  assert.match(migration, /distinct on \(profile_user_id\)/i)
  assert.match(
    migration,
    /revoke all on function private\.workforce_sync_deleted_employee_reinvite_timestamp\(\)[\s\S]*from public, anon, authenticated/i
  )
})

test('pending deleted employee reinvites resend without re-entering stored email', async () => {
  const [migration, endpoint, client, html] = await Promise.all([
    read('supabase/migrations/20260731042600_make_pending_reinvite_resend_reliable.sql'),
    read('functions/reinvite-deleted-employee.js'),
    read('scripts/workforce.js'),
    read('workforce.html')
  ])

  assert.match(migration, /add column if not exists restoration_invite_pending boolean/i)
  assert.match(migration, /from auth\.users auth_user[\s\S]*auth_user\.id = v_open_request\.auth_user_id/i)
  assert.match(migration, /'delivery_email', v_delivery_email/i)
  assert.match(migration, /restoration_invite_pending = new\.status = 'pending'/i)
  assert.match(endpoint, /candidate\?\.delivery_email \|\| email/)
  assert.match(endpoint, /deliveryEmailMasked: maskEmail\(deliveryEmail\)/)
  assert.match(client, /hasPendingRestoration[\s\S]*Resend restoration link/)
  assert.match(client, /\.\.\.\(email \? \{ email \} : \{\}\)/)
  assert.match(html, /scripts\/workforce\.js\?v=18/)
})
