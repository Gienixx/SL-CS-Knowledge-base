import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(
  new URL('../supabase/migrations/20260713173626_restore_workforce_team_admin_rpc.sql', import.meta.url),
  'utf8'
)
const client = await readFile(new URL('../scripts/team-management.js', import.meta.url), 'utf8')

test('current migrations provide the exact team administration RPC used by the client', () => {
  assert.match(migration, /function public\.workforce_admin_save_team\([\s\S]*p_team_id uuid[\s\S]*p_reason text/)
  for (const parameter of [
    'p_team_id', 'p_name', 'p_description', 'p_supervisor_id', 'p_is_active', 'p_reason'
  ]) {
    assert.match(client, new RegExp(`${parameter}:`))
  }
})

test('team administration RPC enforces active admin permission and safe grants', () => {
  assert.match(migration, /security definer/i)
  assert.match(migration, /set search_path = public, pg_temp/i)
  assert.match(migration, /workforce_current_user_is_active\(\)/)
  assert.match(migration, /workforce_is_admin\(\)/)
  assert.match(migration, /workforce_has_permission\('manage_employees'\)/)
  assert.match(migration, /revoke all[\s\S]*from public, anon/i)
  assert.match(migration, /grant execute[\s\S]*to authenticated, service_role/i)
  assert.match(migration, /notify pgrst, 'reload schema'/i)
})
