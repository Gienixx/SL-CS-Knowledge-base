import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { calculateAttendanceSnapshotMetrics } from '../shared/attendance-snapshot-metrics.js'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const now = new Date('2026-08-24T12:00:00.000Z')

const record = (overrides = {}) => ({
  attendance_status: 'present',
  clock_in: '2026-08-24T00:00:00.000Z',
  clock_out: '2026-08-24T12:00:00.000Z',
  original_clock_in: '2026-08-24T00:00:00.000Z',
  original_clock_out: '2026-08-24T12:00:00.000Z',
  billed_clock_in: '2026-08-24T00:00:00.000Z',
  billed_clock_out: '2026-08-24T12:00:00.000Z',
  ...overrides
})

test('original and billed durations match when timestamps match', () => {
  assert.deepEqual(
    calculateAttendanceSnapshotMetrics([record({ total_worked_minutes: 999 })], now),
    { records: 1, present: 1, totalWorkedMinutes: 720, totalBilledMinutes: 720 }
  )
})

test('billed correction shorter than original is reflected independently', () => {
  const metrics = calculateAttendanceSnapshotMetrics([
    record({
      billed_clock_in: '2026-08-24T04:00:00.000Z',
      billed_clock_out: '2026-08-24T12:00:00.000Z'
    })
  ], now)

  assert.equal(metrics.totalWorkedMinutes, 720)
  assert.equal(metrics.totalBilledMinutes, 480)
})

test('billed correction longer than original is reflected independently', () => {
  const metrics = calculateAttendanceSnapshotMetrics([
    record({ billed_clock_out: '2026-08-24T14:00:00.000Z' })
  ], now)

  assert.equal(metrics.totalWorkedMinutes, 720)
  assert.equal(metrics.totalBilledMinutes, 840)
})

test('null billed timestamps fall back to raw clock timestamps', () => {
  const metrics = calculateAttendanceSnapshotMetrics([
    record({
      original_clock_in: null,
      original_clock_out: null,
      billed_clock_in: null,
      billed_clock_out: null,
      clock_in: '2026-08-24T02:00:00.000Z',
      clock_out: '2026-08-24T05:00:00.000Z'
    })
  ], now)

  assert.equal(metrics.totalWorkedMinutes, 180)
  assert.equal(metrics.totalBilledMinutes, 180)
})

test('multiple attendance records are summed without changing records or present counts', () => {
  const metrics = calculateAttendanceSnapshotMetrics([
    record(),
    record({
      attendance_status: 'absent',
      original_clock_in: '2026-08-23T01:00:00.000Z',
      original_clock_out: '2026-08-23T03:30:00.000Z',
      billed_clock_in: '2026-08-23T01:30:00.000Z',
      billed_clock_out: '2026-08-23T03:00:00.000Z',
      clock_in: '2026-08-23T01:00:00.000Z',
      clock_out: '2026-08-23T03:30:00.000Z'
    })
  ], now)

  assert.deepEqual(metrics, {
    records: 2,
    present: 1,
    totalWorkedMinutes: 870,
    totalBilledMinutes: 810
  })
})

test('open or incomplete attendance follows the existing elapsed-until-now snapshot behavior', () => {
  const metrics = calculateAttendanceSnapshotMetrics([
    record({
      clock_out: null,
      original_clock_out: null,
      billed_clock_out: null,
      original_clock_in: '2026-08-24T10:00:00.000Z',
      billed_clock_in: '2026-08-24T11:00:00.000Z',
      attendance_status: 'present'
    })
  ], now)

  assert.equal(metrics.records, 1)
  assert.equal(metrics.present, 1)
  assert.equal(metrics.totalWorkedMinutes, 120)
  assert.equal(metrics.totalBilledMinutes, 60)
})

test('Attendance Snapshot uses the original and billed fields and replaces only the Late metric', async () => {
  const [html, script, migration] = await Promise.all([
    read('attendance.html'),
    read('scripts/attendance.js'),
    read('supabase/migrations/20260821120000_expose_billed_attendance_in_agent_log.sql')
  ])

  assert.match(html, /<span>Total Worked<\/span>/)
  assert.match(html, /id="attendanceWorkedTotal"/)
  assert.match(html, /<span>Total Billed Hours<\/span>/)
  assert.match(html, /id="attendanceBilledTotal"/)
  assert.doesNotMatch(html, /id="attendanceLateCount"/)
  assert.match(migration, /original_clock_in timestamptz/)
  assert.match(migration, /original_clock_out timestamptz/)
  assert.match(migration, /billed_clock_in timestamptz/)
  assert.match(migration, /billed_clock_out timestamptz/)
  assert.match(script, /calculateAttendanceSnapshotMetrics\(historyRows\)/)
})
