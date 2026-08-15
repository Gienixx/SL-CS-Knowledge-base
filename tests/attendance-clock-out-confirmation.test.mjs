import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  confirmClockOutIfNeeded,
  elapsedClockOutMinutes,
  formatClockOutElapsed
} from '../shared/attendance-clock-out-confirmation.js'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const clockIn = '2026-08-15T10:00:00.000Z'

test('elapsed duration uses whole website minutes', () => {
  assert.equal(elapsedClockOutMinutes(clockIn, '2026-08-15T10:00:59.999Z'), 0)
  assert.equal(elapsedClockOutMinutes(clockIn, '2026-08-15T10:01:00.000Z'), 1)
  assert.equal(elapsedClockOutMinutes(clockIn, '2026-08-15T11:12:59.999Z'), 72)
})

test('duration wording is natural and correctly pluralized', () => {
  assert.equal(formatClockOutElapsed(0), 'less than a minute')
  assert.equal(formatClockOutElapsed(0.9), 'less than a minute')
  assert.equal(formatClockOutElapsed(1), '1 minute')
  assert.equal(formatClockOutElapsed(9), '9 minutes')
  assert.equal(formatClockOutElapsed(60), '1 hour')
  assert.equal(formatClockOutElapsed(61), '1 hour 1 minute')
  assert.equal(formatClockOutElapsed(72), '1 hour 12 minutes')
  assert.equal(formatClockOutElapsed(120), '2 hours')
})

test('Cancel resolves without an RPC and confirmation resolves once', async () => {
  let promptCalls = 0
  let rpcCalls = 0
  const cancelled = await confirmClockOutIfNeeded({
    clockIn,
    now: '2026-08-15T10:02:00.000Z',
    requestConfirmation: async () => {
      promptCalls += 1
      return false
    }
  })
  if (cancelled) rpcCalls += 1
  assert.equal(cancelled, false)
  assert.equal(promptCalls, 1)
  assert.equal(rpcCalls, 0)

  const confirmed = await confirmClockOutIfNeeded({
    clockIn,
    now: '2026-08-15T10:02:00.000Z',
    requestConfirmation: async () => true
  })
  if (confirmed) rpcCalls += 1
  assert.equal(confirmed, true)
  assert.equal(rpcCalls, 1)
})

test('every normal Clock Out requires confirmation', async () => {
  let promptCalls = 0
  let rpcCalls = 0
  const proceed = await confirmClockOutIfNeeded({
    clockIn,
    now: '2026-08-15T13:00:00.000Z',
    requestConfirmation: async elapsed => {
      promptCalls += 1
      assert.equal(elapsed, '3 hours')
      return false
    }
  })
  if (proceed) rpcCalls += 1
  assert.equal(promptCalls, 1)
  assert.equal(rpcCalls, 0)
})

test('confirmed Clock Out proceeds exactly once and rapid confirmation is guarded', async () => {
  let rpcCalls = 0
  let requestCalls = 0
  const confirmed = await confirmClockOutIfNeeded({
    clockIn,
    now: '2026-08-15T10:08:00.000Z',
    requestConfirmation: async () => {
      requestCalls += 1
      return true
    }
  })
  if (confirmed) rpcCalls += 1
  assert.equal(requestCalls, 1)
  assert.equal(rpcCalls, 1)
})

test('Attendance confirmation guard, provenance, and lifecycle safety are wired correctly', async () => {
  const source = await read('scripts/attendance.js')
  assert.match(source, /clockOutConfirmationOpen/)
  assert.match(source, /if \(settled\) return/)
  assert.match(source, /textContent = 'Clock out already\?'/)
  assert.match(source, /You've been clocked in for \$\{elapsedText\}/)
  assert.doesNotMatch(source, /only been clocked in/)
  assert.match(source, /textContent = 'Cancel'/)
  assert.match(source, /textContent = 'Clock Out Anyway'/)
  assert.match(source, /p_action_source: 'explicit_clock_out'/)
  assert.match(source, /p_client_request_id: clientRequestId/)
  assert.match(source, /p_page_session_id: pageSessionId/)
  assert.match(source, /\.rpc\('workforce_clock_out', \{/)
  assert.match(source, /clockOutConfirmationOpen = true/)
  assert.match(source, /confirmClockOutIfNeeded\(/)
  assert.doesNotMatch(source, /pagehide[\s\S]{0,300}workforce_clock_out/)
  assert.doesNotMatch(source, /visibilitychange[\s\S]{0,300}workforce_clock_out/)
  assert.doesNotMatch(source, /setInterval\([^)]*workforce_clock_out/)
  assert.doesNotMatch(source, /setTimeout\([^)]*workforce_clock_out/)
})
