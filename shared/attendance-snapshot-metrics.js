function durationMinutes(clockIn, clockOut, now) {
  if (!clockIn) return 0

  const start = new Date(clockIn).getTime()
  const end = new Date(clockOut || now).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0
  return Math.floor((end - start) / 60000)
}

function originalDurationMinutes(record, now) {
  return durationMinutes(
    record?.original_clock_in || record?.clock_in,
    record?.original_clock_out || record?.clock_out,
    now
  )
}

function billedDurationMinutes(record, now) {
  return durationMinutes(
    record?.billed_clock_in || record?.clock_in,
    record?.billed_clock_out || record?.clock_out,
    now
  )
}

export function calculateAttendanceSnapshotMetrics(records, now = new Date()) {
  const rows = Array.isArray(records) ? records : []

  return {
    records: rows.length,
    present: rows.filter(record => record?.attendance_status === 'present').length,
    totalWorkedMinutes: rows.reduce(
      (sum, record) => sum + originalDurationMinutes(record, now),
      0
    ),
    totalBilledMinutes: rows.reduce(
      (sum, record) => sum + billedDurationMinutes(record, now),
      0
    )
  }
}
