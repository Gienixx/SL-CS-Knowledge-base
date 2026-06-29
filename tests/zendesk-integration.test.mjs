import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getEasternHour,
  shouldRunZendeskHealthCheck
} from '../workers/zendesk-health/index.js'

test('hourly cron runs only at 9 AM in America/New_York', () => {
  const nineDuringDaylightTime = new Date('2026-06-27T13:00:00Z')
  const eightDuringDaylightTime = new Date('2026-06-27T12:00:00Z')
  const nineDuringStandardTime = new Date('2026-12-27T14:00:00Z')

  assert.equal(getEasternHour(nineDuringDaylightTime), 9)
  assert.equal(shouldRunZendeskHealthCheck(nineDuringDaylightTime), true)
  assert.equal(shouldRunZendeskHealthCheck(eightDuringDaylightTime), false)
  assert.equal(shouldRunZendeskHealthCheck(nineDuringStandardTime), true)
})
