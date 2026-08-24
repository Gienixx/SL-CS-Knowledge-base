import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { resolveAttendanceEntryPresentation } from '../shared/attendance-entry-presentation.js'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const overtime = { label: 'Overtime', modifier: 'overtime' }
const flagged = { label: 'Needs review', modifier: 'needs-review' }

test('Team Attendance preserves the normal attendance tag before approval', () => {
  assert.deepEqual(
    resolveAttendanceEntryPresentation({ reviewStatus: 'pending', payrollApprovedAt: null, normalTag: overtime }),
    { tag: overtime, isLocked: false }
  )
})

test('approved attendance replaces its normal tag with Approved', () => {
  assert.deepEqual(
    resolveAttendanceEntryPresentation({ reviewStatus: 'approved', payrollApprovedAt: '2026-08-24T01:00:00Z', normalTag: overtime }),
    { tag: { label: 'Approved', modifier: 'approved' }, isLocked: false }
  )
})

test('locked-only attendance keeps its normal tag and adds the lock state', () => {
  assert.deepEqual(
    resolveAttendanceEntryPresentation({ reviewStatus: 'locked', payrollApprovedAt: null, normalTag: overtime }),
    { tag: overtime, isLocked: true }
  )
})

test('flagged or overtime attendance retains its tag when locked without approval', () => {
  assert.deepEqual(
    resolveAttendanceEntryPresentation({ reviewStatus: 'locked', payrollApprovedAt: null, normalTag: flagged }),
    { tag: flagged, isLocked: true }
  )
})

test('approved attendance keeps Approved when subsequently locked', () => {
  assert.deepEqual(
    resolveAttendanceEntryPresentation({ reviewStatus: 'locked', payrollApprovedAt: '2026-08-24T01:00:00Z', normalTag: overtime }),
    { tag: { label: 'Approved', modifier: 'approved' }, isLocked: true }
  )
})

test('reopened or corrected attendance loses current approval presentation', () => {
  assert.deepEqual(
    resolveAttendanceEntryPresentation({ reviewStatus: 'corrected', payrollApprovedAt: null, normalTag: overtime }),
    { tag: overtime, isLocked: false }
  )
})

test('a rejected or otherwise non-approved review state cannot display Approved from stale data', () => {
  assert.deepEqual(
    resolveAttendanceEntryPresentation({ reviewStatus: 'rejected', payrollApprovedAt: '2026-08-24T01:00:00Z', normalTag: overtime }),
    { tag: overtime, isLocked: false }
  )
})

test('presentation resolution does not mutate underlying overtime or review data', () => {
  const record = {
    review_status: 'pending',
    total_overtime_minutes: 45,
    manager_review_reason: 'Long shift requires review'
  }
  const before = structuredClone(record)

  resolveAttendanceEntryPresentation({ reviewStatus: record.review_status, payrollApprovedAt: null, normalTag: overtime })

  assert.deepEqual(record, before)
  assert.equal(record.total_overtime_minutes, 45)
  assert.equal(record.manager_review_reason, 'Long shift requires review')
})

test('Team Attendance renders the lock as an icon with no visible text and keeps protections server-side', async () => {
  const script = await read('scripts/team-attendance.js')

  assert.match(script, /className = 'team-attendance-lock-icon'/)
  assert.match(script, /setAttribute\('role', 'img'\)/)
  assert.match(script, /setAttribute\('aria-label', 'Locked'\)/)
  assert.match(script, /icon\.title = 'Locked'/)
  assert.match(script, /createElementNS\('http:\/\/www\.w3\.org\/2000\/svg', 'svg'\)/)
  assert.match(script, /if \(displayStatus\.isLocked\) addLockedIcon\(badges\)/)
  assert.match(script, /supabase\.rpc\('workforce_review_attendance'/)
  assert.doesNotMatch(script, /\.from\('attendance'\)\.(update|insert|delete)\(/)
})
