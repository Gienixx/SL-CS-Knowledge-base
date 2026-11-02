import assert from 'node:assert/strict'
import test from 'node:test'
import { snapshot } from '../functions/_shared/analytics-v2-1-snapshot.js'
import { onRequest } from '../functions/api/analytics-v2-1.js'
import { filterSnapshot } from '../scripts/analytics-v2-1-model.js'

const range = { start: '2026-10-30', end: '2026-10-30' }

test('selected-agent ticket totals remove shared tickets only when both agents are selected', () => {
  const all = filterSnapshot(snapshot, { ...range, agents: ['Arby', 'Gen', 'Arez', 'Tommy Fang'] })
  assert.equal(all.total.commented, 593)
  assert.equal(all.total.updates, 1777)
  assert.equal(all.total.solved, 371)
  const gen = filterSnapshot(snapshot, { ...range, agents: ['Gen', 'Arez'] })
  assert.equal(gen.total.commented, 156)
  assert.equal(gen.total.comments, 170)
  const tommy = filterSnapshot(snapshot, { ...range, agents: ['Tommy Fang'] })
  assert.equal(tommy.total.commented, 515)
  assert.equal(tommy.total.public + tommy.total.internal, tommy.total.comments)
})

test('unavailable dates are distinct from verified zero-activity agents', () => {
  assert.equal(filterSnapshot(snapshot, { start: '2026-10-29', end: '2026-10-30', agents: ['Gen'] }), null)
  assert.equal(filterSnapshot(snapshot, { ...range, agents: ['Arby', 'Arez'] }).total.updates, 0)
})

const env = { SUPABASE_URL: 'https://preview-test.supabase.co', SUPABASE_ANON_KEY: 'test-anon', SUPABASE_SERVICE_ROLE_KEY: 'test-server-only' }
const request = (headers, method = 'GET') => new Request('https://preview.example/api/analytics-v2-1', { headers, method })

test('snapshot endpoint denies anonymous and mutation requests without exposing agent data', async () => {
  const anonymous = await onRequest({ request: request(), env })
  assert.equal(anonymous.status, 401)
  assert.equal((await anonymous.json()).rows, undefined)
  const mutation = await onRequest({ request: request(undefined, 'POST'), env })
  assert.equal(mutation.status, 405)
  assert.equal(mutation.headers.get('Allow'), 'GET')
})

test('server verifies report permission before returning the private snapshot', async () => {
  const original = globalThis.fetch
  let permitted = false
  globalThis.fetch = async input => {
    if (String(input).endsWith('/auth/v1/user')) return Response.json({ id: 'viewer', email: 'viewer@example.test' })
    if (String(input).endsWith('/rpc/workforce_get_current_access')) return Response.json({
      user_id: 'viewer', email: 'viewer@example.test', is_active: true,
      base_role: 'agent', permissions: { view_workforce_reports: permitted }
    })
    throw new Error('Unexpected network call')
  }
  try {
    const denied = await onRequest({ request: request({ Authorization: 'Bearer test-session' }), env })
    assert.equal(denied.status, 403)
    assert.equal((await denied.json()).rows, undefined)
    permitted = true
    const allowed = await onRequest({ request: request({ Authorization: 'Bearer test-session' }), env })
    assert.equal(allowed.status, 200)
    assert.match(allowed.headers.get('Cache-Control'), /no-store/)
    assert.equal((await allowed.json()).rows.length, 4)
  } finally { globalThis.fetch = original }
})
