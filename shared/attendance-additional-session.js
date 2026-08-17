export function canUseAdditionalWorkSession({
  workDate,
  attendance = [],
  schedules = [],
  isEligibleSchedule = () => true
}) {
  if (!workDate) return false
  if (attendance.some(record => record.clock_in && !record.clock_out)) return false

  const completedForWorkDate = attendance.some(record =>
    record.work_date === workDate && record.schedule_id && record.clock_in && record.clock_out
  )
  if (!completedForWorkDate) return false

  const hasUnusedEligibleSchedule = schedules.some(schedule => {
    if (schedule.shift_date !== workDate || schedule.is_leave || schedule.is_absent) return false
    if (!isEligibleSchedule(schedule)) return false
    return !attendance.some(record => record.schedule_id === schedule.id && record.clock_in)
  })

  return !hasUnusedEligibleSchedule
}

export function canUseUnscheduledWorkSession({
  workDate,
  attendance = [],
  schedules = []
}) {
  if (!workDate) return false
  if (attendance.some(record => record.clock_in && !record.clock_out)) return false

  return !schedules.some(schedule => {
    if (schedule.shift_date !== workDate || schedule.is_leave || schedule.is_absent) return false
    if (schedule.status && !['published', 'changed'].includes(schedule.status)) return false
    return !attendance.some(record => record.schedule_id === schedule.id && record.clock_in)
  })
}

export function restoreScheduleSelection(previous, optionValues, fallback) {
  return previous && optionValues.includes(previous) ? previous : fallback
}
