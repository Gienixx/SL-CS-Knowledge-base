import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeZendeskAgent
} from '../functions/_shared/zendesk-agent-directory.js'

test('normalizes a Zendesk user into a dashboard agent record', () => {
  assert.deepEqual(
    normalizeZendeskAgent(
      {
        id: 12345,
        name: '  Jane   Doe  ',
        active: true,
        role: 'Agent'
      },
      '2026-07-02T00:00:00.000Z'
    ),
    {
      agent_key: 'zendesk:12345',
      zendesk_user_id: 12345,
      agent_name: 'Jane Doe',
      active: true,
      role: 'agent',
      updated_at: '2026-07-02T00:00:00.000Z'
    }
  )
})

test('rejects users without a valid positive ID or display name', () => {
  assert.equal(normalizeZendeskAgent({ id: 0, name: 'Jane' }), null)
  assert.equal(normalizeZendeskAgent({ id: 123, name: '   ' }), null)
})
