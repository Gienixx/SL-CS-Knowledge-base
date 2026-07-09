import {
  decryptSecret,
  getGoogleConnection,
  getGoogleEnvironment,
  googleApiRequest,
  jsonResponse,
  patchGoogleConnection,
  refreshGoogleAccessToken,
  requireAuthorizedUser
} from '../_shared/google-calendar.js'

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MAX_RANGE_DAYS = 120

export async function onRequestGet(context) {
  let authorization = null
  let environment = null

  try {
    authorization = await requireAuthorizedUser(context)

    if (!authorization.authorized) {
      return authorization.response
    }

    environment = getGoogleEnvironment(context)
    const requestUrl = new URL(context.request.url)
    const start = requestUrl.searchParams.get('start')
    const end = requestUrl.searchParams.get('end')
    const range = validateRange(start, end)
    const connection = await getGoogleConnection(
      environment,
      authorization.user.id
    )

    if (!connection) {
      return jsonResponse({
        connected: false,
        events: []
      })
    }

    const refreshToken = await decryptSecret(
      connection.encrypted_refresh_token,
      environment.tokenEncryptionKey
    )
    const accessToken = await refreshGoogleAccessToken(
      environment,
      refreshToken
    )
    const events = await listGoogleEvents(
      connection,
      accessToken,
      range
    )

    await patchGoogleConnection(
      environment,
      authorization.user.id,
      {
        last_synced_at: new Date().toISOString(),
        last_error: null
      }
    )

    return jsonResponse({
      connected: true,
      calendar: {
        summary: connection.calendar_summary || 'Google Calendar',
        timezone: connection.calendar_timezone || null
      },
      events
    })
  } catch (error) {
    console.error('Google Calendar events error:', error)

    if (authorization?.authorized && environment) {
      try {
        await patchGoogleConnection(
          environment,
          authorization.user.id,
          {
            last_error: String(error?.message || 'Google Calendar sync failed.')
              .slice(0, 500)
          }
        )
      } catch (patchError) {
        console.error('Google Calendar error status update failed:', patchError)
      }
    }

    const needsReconnect = /invalid_grant|revoked|expired/i.test(
      String(error?.message || '')
    )

    return jsonResponse(
      {
        error: error?.message || 'Unable to load Google Calendar events.',
        needsReconnect
      },
      needsReconnect ? 401 : 500
    )
  }
}

function validateRange(start, end) {
  if (!DATE_PATTERN.test(start || '') || !DATE_PATTERN.test(end || '')) {
    throw new Error('Google Calendar start and end dates are required.')
  }

  const startDate = parseDate(start)
  const endDate = parseDate(end)

  if (endDate < startDate) {
    throw new Error('Google Calendar end date cannot be earlier than start date.')
  }

  const days = Math.floor((endDate - startDate) / 86400000)

  if (days > MAX_RANGE_DAYS) {
    throw new Error(`Google Calendar date ranges cannot exceed ${MAX_RANGE_DAYS} days.`)
  }

  const expandedStart = new Date(startDate)
  expandedStart.setUTCDate(expandedStart.getUTCDate() - 1)
  const expandedEnd = new Date(endDate)
  expandedEnd.setUTCDate(expandedEnd.getUTCDate() + 2)

  return {
    timeMin: expandedStart.toISOString(),
    timeMax: expandedEnd.toISOString()
  }
}

async function listGoogleEvents(connection, accessToken, range) {
  const events = []
  let pageToken = ''
  let pageCount = 0

  do {
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(connection.calendar_id || 'primary')}/events`
    )
    url.searchParams.set('timeMin', range.timeMin)
    url.searchParams.set('timeMax', range.timeMax)
    url.searchParams.set('singleEvents', 'true')
    url.searchParams.set('orderBy', 'startTime')
    url.searchParams.set('maxResults', '250')
    url.searchParams.set('showDeleted', 'false')

    if (connection.calendar_timezone) {
      url.searchParams.set('timeZone', connection.calendar_timezone)
    }

    if (pageToken) {
      url.searchParams.set('pageToken', pageToken)
    }

    const data = await googleApiRequest(url.toString(), accessToken)

    for (const event of data.items || []) {
      if (event.status === 'cancelled') continue
      events.push(sanitizeEvent(event))
    }

    pageToken = data.nextPageToken || ''
    pageCount += 1
  } while (pageToken && pageCount < 10)

  return events
}

function sanitizeEvent(event) {
  const allDay = Boolean(event.start?.date)

  return {
    id: event.id,
    source: 'google_calendar',
    title: event.summary || 'Busy',
    start: event.start?.dateTime || event.start?.date || null,
    end: event.end?.dateTime || event.end?.date || null,
    allDay,
    location: event.location || null,
    htmlLink: event.htmlLink || null,
    status: event.status || 'confirmed',
    transparency: event.transparency || 'opaque',
    recurringEventId: event.recurringEventId || null
  }
}

function parseDate(value) {
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error('Google Calendar date range contains an invalid date.')
  }

  return date
}
