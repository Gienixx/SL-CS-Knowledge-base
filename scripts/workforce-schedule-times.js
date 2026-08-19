export function isOvernightShift(startTime, endTime) {
  return Boolean(startTime && endTime) && endTime < startTime
}

export function scheduleEndDate(startDate, startTime, endTime) {
  if (!startDate || !startTime || !endTime) return startDate

  // Preserve the existing 24-hour treatment for equal times while making
  // the overnight rule explicit for end times earlier than start times.
  if (endTime <= startTime) {
    const [year, month, day] = startDate.split('-').map(Number)
    const date = new Date(Date.UTC(year, month - 1, day + 1))
    return date.toISOString().slice(0, 10)
  }

  return startDate
}
