const leaveNames = Object.freeze({
  birthday_vl: 'Birthday VL',
  incentive_vl: 'Incentive VL'
})

export function formatScheduleOptionLabel(schedule, fallbackTimezone = 'America/New_York') {
  const date = schedule?.shift_date
    ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(
        new Date(`${schedule.shift_date}T12:00:00`)
      )
    : 'Date unavailable'
  const sequence = `Sequence ${schedule?.shift_sequence || 1}`
  const timezone = schedule?.timezone || fallbackTimezone
  const timed = schedule?.shift_start && schedule?.shift_end
  const type = schedule?.is_leave
    ? 'Paid Leave'
    : timed ? 'Work Schedule' : 'Open Schedule'
  const name = schedule?.is_leave ? (leaveNames[schedule.leave_type] || schedule.leave_type || '') : ''
  const time = timed
    ? ` · ${new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(new Date(schedule.shift_start))} – ${new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(new Date(schedule.shift_end))}`
    : ''
  return [date, type, name, sequence].filter(Boolean).join(' · ') + time
}
