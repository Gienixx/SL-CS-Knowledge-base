import test from 'node:test'
import assert from 'node:assert/strict'

import {
  fetchTicketAudits
} from '../functions/api/sync-zendesk.js'

test('ticket audits follow Zendesk cursor pages until complete', async () => {
  const requests = []
  const pages = [
    {
      audits: [{ id: 1 }, { id: 2 }],
      meta: {
        has_more: true,
        after_cursor: 'next-page'
      }
    },
    {
      audits: [{ id: 3 }],
      meta: {
        has_more: false,
        after_cursor: null
      }
    }
  ]

  const audits = await fetchTicketAudits(
    {},
    7001,
    {
      fetchJson: async (_environment, path, query) => {
        requests.push({ path, query })
        return pages.shift()
      },
      warn: () => {}
    }
  )

  assert.deepEqual(audits.map(audit => audit.id), [1, 2, 3])
  assert.equal(requests.length, 2)
  assert.equal(requests[0].query['page[size]'], 100)
  assert.equal(requests[0].query.include_boundary_indicators, true)
  assert.equal(requests[0].query['page[after]'], undefined)
  assert.equal(requests[1].query['page[after]'], 'next-page')
})

test('ticket audits stop safely when pagination metadata is unavailable', async () => {
  const warnings = []
  const audits = await fetchTicketAudits(
    {},
    7002,
    {
      fetchJson: async () => ({
        audits: Array.from({ length: 100 }, (_, index) => ({
          id: index + 1
        }))
      }),
      warn: (...args) => warnings.push(args)
    }
  )

  assert.equal(audits.length, 100)
  assert.equal(warnings.length, 1)
})
