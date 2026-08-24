const LEAVE_LABELS = Object.freeze({
  vl: 'VL',
  vacation_leave: 'VL',
  sl: 'SL',
  sick_leave: 'SL',
  leave_without_pay: 'Leave without pay',
  incentive_vl: 'Incentive VL'
})

export function mergeLinkedScheduleDetails(rows, details) {
  const byId = new Map((Array.isArray(details) ? details : []).map(schedule => [schedule.schedule_id, schedule]))

  return (Array.isArray(rows) ? rows : []).map(row => {
    if (!row?.schedule_id) return row

    const schedule = byId.get(row.schedule_id)
    if (!schedule) return { ...row, linked_schedule_exists: false }

    return {
      ...row,
      linked_schedule_exists: true,
      schedule_work_date: schedule.shift_date,
      schedule_sequence: schedule.shift_sequence,
      schedule_start: schedule.shift_start,
      schedule_end: schedule.shift_end,
      schedule_timezone: schedule.timezone || row.schedule_timezone,
      schedule_status: schedule.status || row.schedule_status,
      schedule_is_rest_day: Boolean(schedule.is_rest_day),
      schedule_is_holiday: Boolean(schedule.is_holiday),
      schedule_is_leave: Boolean(schedule.is_leave),
      schedule_is_absent: Boolean(schedule.is_absent),
      schedule_holiday_name: schedule.holiday_name || null,
      schedule_leave_type: schedule.leave_type || null
    }
  })
}

export function linkedScheduleDisplay(row) {
  if (!row?.schedule_id) return { kind: 'unscheduled', label: 'Unscheduled' }
  if (row.linked_schedule_exists === false) return { kind: 'unavailable', label: 'Shift unavailable' }

  if (row.schedule_is_leave) {
    return {
      kind: 'leave',
      label: LEAVE_LABELS[row.schedule_leave_type] || row.schedule_leave_type || 'Leave'
    }
  }
  if (row.schedule_is_absent) return { kind: 'absent', label: 'Absent' }
  if (row.schedule_is_holiday) {
    return { kind: 'holiday', label: row.schedule_holiday_name || 'Holiday' }
  }
  if (row.schedule_is_rest_day) return { kind: 'rest_day', label: 'Rest Day' }
  if (!row.schedule_start || !row.schedule_end) return { kind: 'open', label: 'Open Schedule' }
  return { kind: 'timed', label: 'Work Schedule' }
}
