import test from 'node:test'
import assert from 'node:assert/strict'

import {
  resolveProductivityIdentityMap,
  validateProductivityIdentityHistory
} from '../functions/_shared/dashboard-sync-store.js'

const PAGE_SIZE = 500
const REPORT_DATE = '2026-10-01'

function mockPaginatedSupabaseReads({ identities = [], productivity = [] }) {
  const originalFetch = globalThis.fetch
  const reads = []

  globalThis.fetch = async (rawUrl, options = {}) => {
    const url = new URL(String(rawUrl))
    const table = url.pathname.split('/').at(-1)
    assert.ok(
      table === 'agent_identity_map' || table === 'agent_productivity',
      `Unexpected Supabase read: ${url.pathname}`
    )
    assert.equal(options.method, 'GET')
    assert.equal(options.headers?.Range, undefined)
    assert.equal(options.headers?.['Range-Unit'], undefined)

    const limit = Number(url.searchParams.get('limit'))
    const offset = Number(url.searchParams.get('offset'))
    assert.equal(limit, PAGE_SIZE)
    assert.ok(Number.isInteger(offset) && offset >= 0)

    const expectedOrder = table === 'agent_identity_map'
      ? 'agent_key.asc'
      : 'report_date.asc,agent_key.asc'
    assert.equal(url.searchParams.get('order'), expectedOrder)

    let rows = identities
    if (table === 'agent_productivity') {
      const filter = url.searchParams.get('report_date')
      assert.equal(filter, `in.(${REPORT_DATE})`)
      rows = productivity
    }
    reads.push({ table, offset })
    return new Response(JSON.stringify(rows.slice(offset, offset + limit)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  return {
    reads,
    restore() {
      globalThis.fetch = originalFetch
    }
  }
}

test('identity mapping finishes when the final page is exactly full', async () => {
  const identities = Array.from({ length: PAGE_SIZE }, (_, index) => ({
    agent_key: `agent_${String(index).padStart(4, '0')}`,
    agent_name: `Agent ${index}`,
    dashboard_sync_approved: index === PAGE_SIZE - 1
  }))
  const fake = mockPaginatedSupabaseReads({ identities })
  const incoming = [{
    agent_name: 'Agent 499',
    agent_key: 'new_source_key',
    report_date: REPORT_DATE
  }]

  try {
    const approved = await resolveProductivityIdentityMap(
      'https://example.supabase.co',
      'test-service-key',
      incoming
    )
    assert.equal(incoming[0].agent_key, 'agent_0499')
    assert.deepEqual([...approved], ['agent_0499'])
    assert.deepEqual(fake.reads, [
      { table: 'agent_identity_map', offset: 0 },
      { table: 'agent_identity_map', offset: 500 }
    ])
  } finally {
    fake.restore()
  }
})

test('productivity history reads every full page without an HTTP Range request', async () => {
  const productivity = Array.from({ length: PAGE_SIZE * 2 }, (_, index) => ({
    report_date: REPORT_DATE,
    agent_key: `agent_${String(index).padStart(4, '0')}`
  }))
  const fake = mockPaginatedSupabaseReads({ productivity })

  try {
    await validateProductivityIdentityHistory(
      'https://example.supabase.co',
      'test-service-key',
      [{ report_date: REPORT_DATE, agent_key: 'agent_0999' }]
    )
    assert.deepEqual(fake.reads, [
      { table: 'agent_productivity', offset: 0 },
      { table: 'agent_productivity', offset: 500 },
      { table: 'agent_productivity', offset: 1000 }
    ])

    await assert.rejects(
      validateProductivityIdentityHistory(
        'https://example.supabase.co',
        'test-service-key',
        [{ report_date: REPORT_DATE, agent_key: 'unapproved_new_agent' }]
      ),
      /new agent identity on report date/
    )
  } finally {
    fake.restore()
  }
})
