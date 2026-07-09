import {
  getGoogleConnection,
  googleEnvironmentConfigured,
  jsonResponse,
  requireAuthorizedUser
} from '../_shared/google-calendar.js'

export async function onRequestGet(context) {
  try {
    const authorization = await requireAuthorizedUser(context)

    if (!authorization.authorized) {
      return authorization.response
    }

    const configured = googleEnvironmentConfigured(context)

    if (!configured) {
      return jsonResponse({
        configured: false,
        connected: false
      })
    }

    const connection = await getGoogleConnection(
      authorization.environment,
      authorization.user.id
    )

    return jsonResponse({
      configured: true,
      connected: Boolean(connection),
      connection: connection
        ? {
            calendarSummary:
              connection.calendar_summary || 'Google Calendar',
            calendarTimezone: connection.calendar_timezone || null,
            connectedAt: connection.connected_at,
            updatedAt: connection.updated_at,
            lastSyncedAt: connection.last_synced_at,
            lastError: connection.last_error
          }
        : null
    })
  } catch (error) {
    console.error('Google Calendar status error:', error)
    return jsonResponse(
      {
        error: error?.message || 'Unable to read Google Calendar status.'
      },
      500
    )
  }
}
