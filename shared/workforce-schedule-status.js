export function operationalScheduleStatus(schedule) {
  return schedule?.status === 'cancelled' ? 'cancelled' : 'published'
}

export function isChangedSchedule(schedule) {
  return Boolean(schedule?.changed_at || schedule?.admin_override || schedule?.status === 'changed')
}

export function isCompletedSchedule(schedule, attendance = []) {
  return Boolean(schedule?.id) && attendance.some(record =>
    record?.schedule_id === schedule.id &&
    !record?.voided_at &&
    Boolean(record?.clock_out)
  )
}

export function scheduleStatusTags(schedule, attendance = []) {
  if (operationalScheduleStatus(schedule) === 'cancelled') return ['Cancelled']

  const tags = ['Published']
  if (isChangedSchedule(schedule)) tags.push('Changed')
  if (isCompletedSchedule(schedule, attendance)) tags.push('Completed')
  return tags
}
