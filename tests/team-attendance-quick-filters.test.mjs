import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  isTeamAttendanceReviewNeeded,
  matchesTeamAttendanceQuickFilter
} from '../shared/team-attendance-filters.js'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const row = overrides => ({
  review_status: 'approved',
  payroll_approved_at: '2026-08-24T01:00:00Z',
  is_missing_clock_out: false,
  is_over_duration: false,
  is_open: false,
  total_overtime_minutes: 0,
  ...overrides
})

test('Team Attendance quick buttons are ordered and Missing clock-out is removed', async () => {
  const page = await read('team-attendance.html')
  const buttons = [...page.matchAll(/data-attendance-quick-filter="([^"]+)"[^>]*>([^<]+)</g)]
    .map(match => [match[1], match[2]])

  assert.deepEqual(buttons, [
    ['all', 'All'],
    ['review', 'Needs review'],
    ['approved', 'Approved'],
    ['open', 'Open'],
    ['overtime', 'Overtime']
  ])
  assert.doesNotMatch(page, /data-attendance-quick-filter="missing"/)
  assert.doesNotMatch(page, />Missing clock-out<\/button>/)
})

test('Needs review includes missing clock-out, pending, corrected, rejected, and over-duration rows', () => {
  for (const candidate of [
    { is_missing_clock_out: true },
    { review_status: 'pending', payroll_approved_at: null },
    { review_status: 'corrected', payroll_approved_at: null },
    { review_status: 'rejected', payroll_approved_at: null },
    { is_over_duration: true }
  ]) {
    const candidateRow = row(candidate)
    assert.equal(isTeamAttendanceReviewNeeded(candidateRow), true)
    assert.equal(matchesTeamAttendanceQuickFilter(candidateRow, 'review'), true)
  }
})

test('Approved includes physical and audit-derived effective approval, including locked rows', () => {
  assert.equal(matchesTeamAttendanceQuickFilter(row({ review_status: 'approved' }), 'approved'), true)
  assert.equal(matchesTeamAttendanceQuickFilter(row({ review_status: 'locked' }), 'approved'), true)
  assert.equal(matchesTeamAttendanceQuickFilter(row({ review_status: 'locked', payroll_approved_at: null }), 'approved'), false)
  assert.equal(matchesTeamAttendanceQuickFilter(row({ review_status: 'pending', payroll_approved_at: null }), 'approved'), false)
})

test('Open and Overtime retain their existing predicates', () => {
  assert.equal(matchesTeamAttendanceQuickFilter(row({ is_open: true }), 'open'), true)
  assert.equal(matchesTeamAttendanceQuickFilter(row({ is_open: false }), 'open'), false)
  assert.equal(matchesTeamAttendanceQuickFilter(row({ total_overtime_minutes: 1 }), 'overtime'), true)
  assert.equal(matchesTeamAttendanceQuickFilter(row({ total_overtime_minutes: 0 }), 'overtime'), false)
})

test('All leaves every non-voided row eligible for the quick-filter stage', () => {
  assert.equal(matchesTeamAttendanceQuickFilter(row({ review_status: 'pending', payroll_approved_at: null }), 'all'), true)
  assert.equal(matchesTeamAttendanceQuickFilter(row({ review_status: 'locked', payroll_approved_at: null }), 'all'), true)
})
