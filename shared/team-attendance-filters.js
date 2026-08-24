import { isEffectivelyApproved } from './attendance-entry-presentation.js'

const COMPLETED_REVIEW_STATUSES = new Set(['approved', 'locked'])

export function isTeamAttendanceReviewNeeded(row) {
  const reviewStatus = row?.review_status || 'pending'
  return Boolean(row?.is_missing_clock_out || row?.is_over_duration)
    || !COMPLETED_REVIEW_STATUSES.has(reviewStatus)
}

export function matchesTeamAttendanceQuickFilter(row, filter) {
  if (filter === 'open') return Boolean(row?.is_open)
  if (filter === 'overtime') return Number(row?.total_overtime_minutes) > 0
  if (filter === 'review') return isTeamAttendanceReviewNeeded(row)
  if (filter === 'approved') {
    return isEffectivelyApproved({
      reviewStatus: row?.review_status,
      payrollApprovedAt: row?.payroll_approved_at
    })
  }
  return true
}
