// Keep billed attendance display semantics shared by Team Attendance and the
// employee Attendance Log. Billing values are persisted by the correction RPC;
// this module only resolves and formats those persisted values for display.

export const TEAM_ATTENDANCE_TIMEZONE = 'America/New_York'

export function hasBilledOverride(record) {
  if (record?.is_corrected === true) return true
  return Boolean(record?.billed_clock_in && record?.billed_clock_out
    && (record.billed_clock_in !== (record.original_clock_in || record.clock_in)
      || record.billed_clock_out !== (record.original_clock_out || record.clock_out)))
}

export function effectiveAttendanceClocks(record) {
  const originalClockIn = record?.original_clock_in || record?.clock_in || null
  const originalClockOut = record?.original_clock_out || record?.clock_out || null
  if (!hasBilledOverride(record)) {
    return {
      renderedClockIn: originalClockIn,
      renderedClockOut: originalClockOut,
      billedClockIn: originalClockIn,
      billedClockOut: originalClockOut
    }
  }
  return {
    renderedClockIn: originalClockIn,
    renderedClockOut: originalClockOut,
    billedClockIn: record?.billed_clock_in || null,
    billedClockOut: record?.billed_clock_out || null
  }
}

export function formatAttendanceTimestamp(value, includeDate = false) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TEAM_ATTENDANCE_TIMEZONE,
    ...(includeDate ? { month: 'short', day: 'numeric', year: 'numeric' } : {}),
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(value))
}
