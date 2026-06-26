import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PHASE3_ADVANCED_METRIC_KEYS,
  PHASE3_ADVANCED_METRICS,
  PHASE3_SOURCE_SYSTEMS,
  validatePhase3AdvancedDataSources
} from '../config/phase3-advanced-data-sources.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

function read(relativePath) {
  const absolutePath = join(ROOT, relativePath)
  assert.ok(existsSync(absolutePath), `${relativePath} must exist`)
  return readFileSync(absolutePath, 'utf8')
}

test('all Phase 3 Step 1 metrics have one valid authoritative mapping', () => {
  assert.deepEqual(validatePhase3AdvancedDataSources(), [])
  assert.equal(PHASE3_ADVANCED_METRICS.length, 12)
  assert.equal(new Set(PHASE3_ADVANCED_METRIC_KEYS).size, 12)
})

test('Zendesk is authoritative and the workbook is excluded for advanced metrics', () => {
  assert.equal(
    PHASE3_SOURCE_SYSTEMS.zendesk.role,
    'authoritative_operational_source'
  )
  assert.equal(
    PHASE3_SOURCE_SYSTEMS.workbook.authoritativeForAdvancedMetrics,
    false
  )

  PHASE3_ADVANCED_METRICS.forEach(metric => {
    assert.equal(metric.sourceSystem, PHASE3_SOURCE_SYSTEMS.zendesk.key)
    assert.ok(PHASE3_SOURCE_SYSTEMS.zendesk.endpoints[metric.endpointKey])
    assert.ok(metric.fields.length > 0)
  })
})

test('the source contract declares the required Zendesk endpoints and secrets', () => {
  const zendesk = PHASE3_SOURCE_SYSTEMS.zendesk

  assert.equal(
    zendesk.endpoints.incrementalTickets.path,
    '/api/v2/incremental/tickets/cursor'
  )
  assert.equal(
    zendesk.endpoints.ticketAudits.path,
    '/api/v2/tickets/{ticket_id}/audits'
  )
  assert.equal(
    zendesk.endpoints.ticketMetricEvents.path,
    '/api/v2/incremental/ticket_metric_events'
  )
  assert.equal(
    zendesk.endpoints.satisfactionRatings.path,
    '/api/v2/satisfaction_ratings'
  )

  assert.deepEqual(zendesk.requiredEnvironment, [
    'ZENDESK_SUBDOMAIN',
    'ZENDESK_EMAIL',
    'ZENDESK_API_TOKEN'
  ])
})

test('the Step 1 guide prevents unsupported response-time and SLA calculations', () => {
  const guide = read('docs/phase-3-step-1-advanced-data-sources.md')

  for (const requiredText of [
    'Zendesk Support API as the authoritative source',
    'must not be calculated from the',
    'ZENDESK_SUBDOMAIN',
    'ZENDESK_EMAIL',
    'ZENDESK_API_TOKEN',
    'SLA policies are enabled',
    'CSAT is enabled',
    'rather than being approximated'
  ]) {
    assert.ok(
      guide.includes(requiredText),
      `Step 1 guide must contain ${JSON.stringify(requiredText)}`
    )
  }
})
