import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Activity Log actor resolution preserves the display priority', async () => {
  const migration = await read('supabase/migrations/20260815100000_activity_log_actor_resolution.sql')

  assert.match(migration, /actor\.is_system_admin then 'System Admin'/)
  assert.match(migration, /event\.actor_user_id is null then 'System'/)
  assert.match(migration, /nullif\(trim\(actor\.full_name\), ''\)/)
  assert.match(migration, /nullif\(trim\(actor_login\.name\), ''\)/)
  assert.match(migration, /'An admin'/)
  assert.match(migration, /left join auth\.users actor_auth on actor_auth\.id = event\.actor_user_id/)
  assert.match(migration, /left join public\.login actor_login on lower\(actor_login\.email\) = lower\(actor_auth\.email\)/)
})
