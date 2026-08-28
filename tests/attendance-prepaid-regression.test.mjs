import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

function canonicalMinutes(attendance) {
  const clockIn = Date.parse(attendance.billedClockIn || attendance.clockIn || '')
  const clockOut = Date.parse(attendance.billedClockOut || attendance.clockOut || '')
  if (!Number.isFinite(clockIn) || !Number.isFinite(clockOut) || clockOut < clockIn) return 0
  return Math.floor((clockOut - clockIn) / 60000)
}

function eligibleMinutes(attendance) {
  if (!['approved', 'locked'].includes(attendance.reviewStatus)) return 0
  if (attendance.attendanceStatus !== 'present' || !attendance.clockOut) return 0
  if (attendance.isRestDay || attendance.isHoliday) return 0
  return canonicalMinutes(attendance)
}

function settle(attendance, prepaid) {
  const remaining = Math.max(0, prepaid.prepaidMinutes - prepaid.settledMinutes)
  return Math.min(eligibleMinutes(attendance), remaining)
}

test('Attendance Log light mode keeps billed timestamp cells readable', async () => {
  const css = await read('styles/attendance-theme-fix.css')

  assert.match(css, /html\[data-site-theme="light"\] \.attendance-history-card \.attendance-billed-clock-cell[\s\S]*?color: var\(--site-text\) !important/)
  assert.match(css, /html\[data-site-theme="light"\] \.attendance-history-card \.attendance-billed-clock-cell[\s\S]*?border-color: var\(--site-border\) !important/)
  assert.match(css, /html\[data-site-theme="light"\] \.attendance-history-card \.attendance-billed-clock-cell[\s\S]*?background: var\(--site-surface-solid\) !important/)
  assert.doesNotMatch(css, /html\[data-site-theme="dark"\][\s\S]*attendance-billed-clock-cell/)
})

test('Attendance Log light mode keeps enabled and disabled pagination distinct', async () => {
  const css = await read('styles/attendance-theme-fix.css')

  assert.match(css, /html\[data-site-theme="light"\] \.attendance-history-pagination span[\s\S]*?color: var\(--site-heading\) !important/)
  assert.match(css, /\.attendance-history-pagination \.wf-row-btn:not\(:disabled\)[\s\S]*?border-color: var\(--site-border\) !important[\s\S]*?color: var\(--site-blue-strong\) !important[\s\S]*?background: var\(--site-surface-solid\) !important[\s\S]*?opacity: 1/)
  assert.match(css, /\.attendance-history-pagination \.wf-row-btn:disabled[\s\S]*?border-color: var\(--site-border\) !important[\s\S]*?color: var\(--site-muted\) !important[\s\S]*?background: var\(--site-neutral-soft\) !important[\s\S]*?opacity: 1/)
  assert.doesNotMatch(css, /html\[data-site-theme="dark"\][\s\S]*attendance-history-pagination/)
})

test('pending or for-review attendance cannot consume prepaid balance', async () => {
  const [readiness, importMigration, reconciliation] = await Promise.all([
    read('supabase/migrations/20260824143000_payroll_readiness_canonical_billed_duration.sql'),
    read('supabase/migrations/20260808093641_latest_snapshot_recalculation_transition.sql'),
    read('supabase/migrations/20260828071452_fix_prepaid_import_canonical_timestamps.sql')
  ])

  const pending = {
    reviewStatus: 'pending',
    attendanceStatus: 'present',
    clockIn: '2026-08-27T07:19:57Z',
    clockOut: '2026-08-27T22:20:39Z'
  }

  assert.equal(settle(pending, { prepaidMinutes: 900, settledMinutes: 0 }), 0)
  assert.match(readiness, /review_status <> all \(array\['approved'::text, 'locked'::text\]\)/)
  assert.match(importMigration, /readiness\.is_payroll_ready/)
  assert.match(reconciliation, /v_attendance\.review_status not in \(''approved'', ''locked''\)/)
})

test('approved matching attendance consumes canonical captured duration', async () => {
  const [reconciliation, importFix] = await Promise.all([
    read('supabase/migrations/20260728053329_payroll_prepaid_hour_reconciliation.sql'),
    read('supabase/migrations/20260828071452_fix_prepaid_import_canonical_timestamps.sql')
  ])
  const approved = {
    reviewStatus: 'approved',
    attendanceStatus: 'present',
    clockIn: '2026-08-27T07:19:57Z',
    clockOut: '2026-08-27T22:20:39Z'
  }

  assert.equal(canonicalMinutes(approved), 900)
  assert.equal(settle(approved, { prepaidMinutes: 900, settledMinutes: 0 }), 900)
  assert.match(reconciliation, /after insert on public\.payroll_attendance_snapshots/)
  assert.match(importFix, /coalesce\(source\.billed_clock_in, source\.captured_clock_in\)/)
  assert.match(importFix, /coalesce\(source\.billed_clock_out, source\.captured_clock_out\)/)
})

test('approved attendance prefers billed timestamps and preserves partial fulfillment', () => {
  const corrected = {
    reviewStatus: 'approved',
    attendanceStatus: 'present',
    clockIn: '2026-08-27T07:19:57Z',
    clockOut: '2026-08-27T22:20:39Z',
    billedClockIn: '2026-08-27T08:00:00Z',
    billedClockOut: '2026-08-27T16:00:00Z'
  }

  assert.equal(canonicalMinutes(corrected), 480)
  assert.equal(settle(corrected, { prepaidMinutes: 900, settledMinutes: 0 }), 480)
  assert.equal(settle(corrected, { prepaidMinutes: 900, settledMinutes: 600 }), 300)
})

test('prepaid fulfillment never exceeds the original allocation', async () => {
  const reconciliation = await read('supabase/migrations/20260728053329_payroll_prepaid_hour_reconciliation.sql')
  const approved = {
    reviewStatus: 'locked',
    attendanceStatus: 'present',
    clockIn: '2026-08-27T00:00:00Z',
    clockOut: '2026-08-27T16:00:00Z'
  }

  assert.equal(settle(approved, { prepaidMinutes: 900, settledMinutes: 0 }), 900)
  assert.equal(settle(approved, { prepaidMinutes: 900, settledMinutes: 850 }), 50)
  assert.match(reconciliation, /v_allocated_minutes :=[\s\S]*?least\(v_available_minutes, v_balance\.remaining_minutes\)/)
  assert.match(reconciliation, /settled_minutes = settled_minutes \+ v_allocated_minutes/)
})
