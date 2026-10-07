const RELEASED_SCHEDULE_STATUSES = new Set(['published', 'changed'])
const BLOCKING_SCHEDULE_FLAGS = ['is_rest_day', 'is_holiday', 'is_leave', 'is_absent']
const FALLBACK_TIMEZONE = 'America/New_York'

function zoneParts(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(timestamp))

  return Object.fromEntries(parts.map(part => [part.type, Number(part.value)]))
}

function dateKeyFromParts(parts) {
  return [
    String(parts.year).padStart(4, '0'),
    String(parts.month).padStart(2, '0'),
    String(parts.day).padStart(2, '0')
  ].join('-')
}

function addDays(dateValue, amount) {
  const [year, month, day] = dateValue.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + amount))
  return date.toISOString().slice(0, 10)
}

function parseTime(value) {
  const match = String(value || '').match(/^([01]\d|2[0-3]):([0-5]\d)$/)
  if (!match) throw new Error('Enter a valid From and To time.')
  return Number(match[1]) * 60 + Number(match[2])
}

function zonedDateTimeToIso(localValue, timeZone) {
  const match = String(localValue || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/)
  if (!match) throw new Error('Enter a valid From and To time.')

  const [, year, month, day, hour, minute] = match.map(Number)
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0)
  let timestamp = utcGuess

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = zoneParts(timestamp, timeZone)
    const represented = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    )
    timestamp = utcGuess - (represented - timestamp)
  }

  const actual = zoneParts(timestamp, timeZone)
  if (
    actual.year !== year ||
    actual.month !== month ||
    actual.day !== day ||
    actual.hour !== hour ||
    actual.minute !== minute
  ) {
    throw new Error('The selected time does not exist in the schedule timezone.')
  }

  return new Date(timestamp).toISOString()
}

function localClockMinutes(timestamp, timeZone) {
  const parts = zoneParts(timestamp, timeZone)
  return parts.hour * 60 + parts.minute
}

function anchorClockTime(date, time, shiftStart, timeZone) {
  const value = parseTime(time)
  const shiftStartMinutes = localClockMinutes(shiftStart, timeZone)
  const dateValue = value < shiftStartMinutes ? addDays(date, 1) : date
  return zonedDateTimeToIso(dateValue + 'T' + time, timeZone)
}

export function partialLeaveScheduleEligibility(schedules, workDate) {
  const activeSchedules = (Array.isArray(schedules) ? schedules : []).filter(schedule =>
    schedule?.shift_date === workDate &&
    RELEASED_SCHEDULE_STATUSES.has(schedule?.status)
  )

  if (!activeSchedules.length) {
    return { schedule: null, reason: 'No published work schedule exists for this date.' }
  }

  if (activeSchedules.length !== 1) {
    return { schedule: null, reason: 'Partial-day leave requires exactly one published schedule on this date.' }
  }

  const schedule = activeSchedules[0]
  if (BLOCKING_SCHEDULE_FLAGS.some(flag => schedule[flag])) {
    return { schedule: null, reason: 'Partial-day leave is unavailable for Rest Days, holidays, leave, or absence schedules.' }
  }

  const start = Date.parse(schedule.shift_start)
  const end = Date.parse(schedule.shift_end)
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return { schedule: null, reason: 'Partial-day leave requires a timed schedule; Open Schedules do not have clock times.' }
  }

  if (end <= start || end - start > 24 * 60 * 60 * 1000) {
    return { schedule: null, reason: 'The schedule does not have a valid timed work period.' }
  }

  const timeZone = schedule.timezone || FALLBACK_TIMEZONE
  try {
    if (dateKeyFromParts(zoneParts(start, timeZone)) !== workDate) {
      return { schedule: null, reason: 'The schedule start does not match its work date.' }
    }
  } catch {
    return { schedule: null, reason: 'The schedule uses an unsupported timezone.' }
  }

  return { schedule, reason: '' }
}

export function calculatePartialLeaveInterval({
  duration,
  half = '',
  fromTime = '',
  toTime = '',
  schedule
}) {
  const timeZone = schedule?.timezone || FALLBACK_TIMEZONE
  const shiftStart = Date.parse(schedule?.shift_start)
  const shiftEnd = Date.parse(schedule?.shift_end)

  if (!Number.isFinite(shiftStart) || !Number.isFinite(shiftEnd) || shiftEnd <= shiftStart) {
    throw new Error('Partial-day leave requires a timed work schedule.')
  }

  let start
  let end
  if (duration === 'half_day') {
    if (!['first', 'second'].includes(half)) {
      throw new Error('Select First Half or Second Half.')
    }

    const scheduledMinutes = Math.floor((shiftEnd - shiftStart) / 60000)
    if (scheduledMinutes < 2) {
      throw new Error('The schedule is too short to split into a partial-day interval.')
    }

    const midpoint = shiftStart + Math.floor(scheduledMinutes / 2) * 60000
    start = half === 'first' ? shiftStart : midpoint
    end = half === 'first' ? midpoint : shiftEnd
  } else if (duration === 'specific_time') {
    const workDate = schedule.shift_date
    if (!workDate || !fromTime || !toTime) {
      throw new Error('Specific Time requires From and To times.')
    }
    start = Date.parse(anchorClockTime(workDate, fromTime, shiftStart, timeZone))
    end = Date.parse(anchorClockTime(workDate, toTime, shiftStart, timeZone))
  } else {
    throw new Error('Select Half Day or Specific Time for this interval.')
  }

  if (end <= start) {
    throw new Error('Requested leave end must be later than its start.')
  }

  if (start < shiftStart || end > shiftEnd) {
    throw new Error('The requested leave interval must fit within the scheduled shift.')
  }

  const minutes = Math.floor((end - start) / 60000)
  if (minutes <= 0) throw new Error('The requested leave interval must be at least one minute.')

  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    minutes
  }
}

export function formatLeaveMinutes(minutes) {
  const value = Number(minutes)
  if (!Number.isInteger(value) || value <= 0) return '—'
  const hours = Math.floor(value / 60)
  const remainingMinutes = value % 60
  if (!hours) return String(remainingMinutes) + ' min'
  return remainingMinutes
    ? String(hours) + ' hr ' + String(remainingMinutes) + ' min'
    : String(hours) + ' hr'
}
