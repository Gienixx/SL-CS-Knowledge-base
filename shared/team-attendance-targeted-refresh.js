const COMMITTED_REVIEW_STATES = new Set(['approved', 'locked'])

export function isCommittedHoursCandidate(row) {
  return Boolean(row) && row.voided_at == null && row.is_voided !== true &&
    row.attendance_status === 'present' &&
    COMMITTED_REVIEW_STATES.has(row.review_status)
}

export function attendanceChangeAffectsCommittedHours(previous, next) {
  // Readiness is authoritative in the payroll FIFO source. Treat approved
  // present rows as candidates here so verified reconstructed rows with null
  // raw punches still refresh the employee's scoped summary.
  const wasCandidate = isCommittedHoursCandidate(previous)
  const isCandidate = isCommittedHoursCandidate(next)
  if (wasCandidate !== isCandidate) return true
  if (!wasCandidate) return false

  return [
    'work_date',
    'attendance_status',
    'schedule_id',
    'payroll_approved_at',
    'billed_clock_in',
    'billed_clock_out',
    'clock_in',
    'clock_out',
    'pre_shift_overtime_minutes',
    'regular_minutes',
    'post_shift_overtime_minutes',
    'rest_day_overtime_minutes',
    'holiday_overtime_minutes',
    'total_overtime_minutes',
    'total_worked_minutes',
    'is_payroll_ready'
  ].some(key => previous?.[key] !== next?.[key])
}

export function committedHoursRefreshRange(previous, next, visibleStartDate, visibleEndDate) {
  if (!visibleStartDate || !visibleEndDate || visibleEndDate < visibleStartDate) return null

  const workDates = [previous?.work_date, next?.work_date]
    .filter(value => typeof value === 'string' && value)
    .sort()
  if (!workDates.length || workDates[0] > visibleEndDate) return null

  return {
    startDate: workDates[0] < visibleStartDate ? visibleStartDate : workDates[0],
    endDate: visibleEndDate
  }
}

export function mergeEmployeeDateCommittedHours(rows, employeeId, startDate, endDate, targets) {
  const targetsByDate = new Map(
    (Array.isArray(targets) ? targets : []).map(target => [target.work_date, target])
  )

  return (Array.isArray(rows) ? rows : []).map(row => {
    if (row.employee_user_id !== employeeId ||
        row.work_date < startDate || row.work_date > endDate) return row

    return {
      ...row,
      committed_hours: targetsByDate.get(row.work_date) || null,
      committed_hours_unavailable: false
    }
  })
}

export function upsertAttendanceRowById(rows, row, { allowInsert = true } = {}) {
  const source = Array.isArray(rows) ? rows : []
  const rowId = row?.attendance_id || row?.id
  if (!rowId) return source

  let replaced = false
  const updated = source.map(candidate => {
    if (replaced || (candidate?.attendance_id || candidate?.id) !== rowId) return candidate
    replaced = true
    return row
  })
  return replaced ? updated : allowInsert ? [...updated, row] : source
}

export function removeAttendanceRowById(rows, rowId) {
  return (Array.isArray(rows) ? rows : []).filter(
    candidate => (candidate?.attendance_id || candidate?.id) !== rowId
  )
}
