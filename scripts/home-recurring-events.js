const TEAM_EVENT_TIMEZONE = 'America/New_York'

const FIRST_THURSDAY_EVENTS = Object.freeze([
  Object.freeze({ title: 'Cashouts and Tickets process alignment', time: '9:30 AM – 10:30 AM', startMinutes: 570, type: 'Meeting' }),
  Object.freeze({ title: 'Team huddle', time: '10:30 AM – 11:00 AM', startMinutes: 630, type: 'Meeting' }),
  Object.freeze({ title: 'CS sync', time: '11:00 AM – 12:00 PM', startMinutes: 660, type: 'Meeting' })
])

const LATER_THURSDAY_EVENTS = Object.freeze([
  Object.freeze({ title: 'Team huddle', time: '10:30 AM – 11:00 AM', startMinutes: 630, type: 'Meeting' }),
  Object.freeze({ title: 'CS sync', time: '11:00 AM – 12:00 PM', startMinutes: 660, type: 'Meeting' })
])

export function recurringTeamEventsForMonth(year, monthIndex) {
  const monthKey = `${String(year).padStart(4, '0')}-${String(monthIndex + 1).padStart(2, '0')}`
  const events = [{
    title: 'Monthly report deadline',
    time: 'All day',
    startMinutes: 0,
    type: 'Deadline',
    allDay: true,
    date: `${monthKey}-01`,
    timezone: TEAM_EVENT_TIMEZONE
  }]
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(Date.UTC(year, monthIndex, day))
    if (date.getUTCDay() !== 4) continue

    const thursdayNumber = Math.floor((day - 1) / 7) + 1
    const dateKey = `${monthKey}-${String(day).padStart(2, '0')}`
    const thursdayEvents = thursdayNumber === 1
      ? FIRST_THURSDAY_EVENTS
      : LATER_THURSDAY_EVENTS

    thursdayEvents.forEach(event => {
      events.push({ ...event, date: dateKey, timezone: TEAM_EVENT_TIMEZONE })
    })
  }

  return events
}

export function upcomingRecurringTeamEvents(referenceDate = new Date(), limit = 5) {
  const now = dateTimePartsInNewYork(referenceDate)
  const events = []

  for (let monthOffset = 0; monthOffset < 4; monthOffset += 1) {
    const monthDate = new Date(Date.UTC(now.year, now.monthIndex + monthOffset, 1))
    events.push(...recurringTeamEventsForMonth(monthDate.getUTCFullYear(), monthDate.getUTCMonth()))
  }

  return events
    .filter(event => event.date > now.dateKey || (
      event.date === now.dateKey && (event.allDay || event.startMinutes >= now.minutes)
    ))
    .sort((left, right) => left.date.localeCompare(right.date) || left.startMinutes - right.startMinutes)
    .slice(0, limit)
}

function dateTimePartsInNewYork(value) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TEAM_EVENT_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(value)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  )

  return {
    year: Number(parts.year),
    monthIndex: Number(parts.month) - 1,
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute)
  }
}
