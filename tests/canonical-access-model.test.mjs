import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('administrator-facing access types are limited to the canonical three', async () => {
  const [html, script, shared] = await Promise.all([
    read('workforce.html'),
    read('scripts/workforce.js'),
    read('shared/workforce-access.js')
  ])

  assert.match(html, /value="admin_agent"/)
  assert.match(html, /value="admin"/)
  assert.match(html, /value="regular_agent"/)
  assert.doesNotMatch(html, /agent_editor|Agent with Article Editor access/)
  assert.doesNotMatch(script, /agent_editor|Agent with Article Editor access/)
  assert.doesNotMatch(shared, /return 'agent_editor'/)
})

test('canonical migration preserves editor permission independently', async () => {
  const migration = await read('supabase/migrations/20260715083930_canonical_access_model.sql')

  assert.match(migration, /p_access_type not in \('admin', 'regular_agent', 'admin_agent'\)/)
  assert.match(migration, /'arez@eurekasurveys\.com', 'gen@eurekasurveys\.com'/)
  assert.match(migration, /permission_key, is_granted[\s\S]*'edit_articles', true/)
  assert.match(migration, /can_edit_articles = permission\.is_granted/)
})

test('legacy save bridge is inaccessible to browser roles', async () => {
  const migration = await read('supabase/migrations/20260715083930_canonical_access_model.sql')

  assert.match(migration, /revoke all on function public\.workforce_admin_save_employee_legacy_access_bridge[\s\S]*from public, anon, authenticated/)
  assert.match(migration, /grant execute on function public\.workforce_admin_save_employee[\s\S]*to authenticated/)
})
