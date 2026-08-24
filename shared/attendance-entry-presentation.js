const APPROVED_REVIEW_STATUS = 'approved'
const LOCKED_REVIEW_STATUS = 'locked'

export function isEffectivelyApproved({ reviewStatus, payrollApprovedAt }) {
  return Boolean(payrollApprovedAt)
    && [APPROVED_REVIEW_STATUS, LOCKED_REVIEW_STATUS].includes(reviewStatus)
}

export function resolveAttendanceEntryPresentation({ reviewStatus, payrollApprovedAt, normalTag }) {
  const isApproved = isEffectivelyApproved({ reviewStatus, payrollApprovedAt })
  const isLocked = reviewStatus === LOCKED_REVIEW_STATUS

  return {
    tag: isApproved
      ? { label: 'Approved', modifier: 'approved' }
      : { ...normalTag },
    isLocked
  }
}
