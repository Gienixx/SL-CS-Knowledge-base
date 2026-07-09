import {
  decryptSecret,
  getGoogleConnection,
  getGoogleEnvironment,
  jsonResponse,
  requireAuthorizedUser,
  serviceRequest
} from '../_shared/google-calendar.js'

export async function onRequestPost(context) {
  try {
    const authorization = await requireAuthorizedUser(context)

    if (!authorization.authorized) {
      return authorization.response
    }

    const environment = getGoogleEnvironment(context)
    const connection = await getGoogleConnection(
      environment,
      authorization.user.id
    )

    if (!connection) {
      return jsonResponse({ success: true, connected: false })
    }

    try {
      const refreshToken = await decryptSecret(
        connection.encrypted_refresh_token,
        environment.tokenEncryptionKey
      )
      await fetch(
        `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      )
    } catch (error) {
      console.warn('Google token revocation failed; removing local connection:', error)
    }

    await serviceRequest(
      environment,
      `google_calendar_connections?user_id=eq.${encodeURIComponent(authorization.user.id)}`,
      {
        method: 'DELETE',
        prefer: 'return=minimal'
      }
    )

    await serviceRequest(
      environment,
      `google_calendar_oauth_states?user_id=eq.${encodeURIComponent(authorization.user.id)}`,
      {
        method: 'DELETE',
        prefer: 'return=minimal'
      }
    )

    return jsonResponse({
      success: true,
      connected: false
    })
  } catch (error) {
    console.error('Google Calendar disconnect error:', error)
    return jsonResponse(
      {
        error: error?.message || 'Unable to disconnect Google Calendar.'
      },
      500
    )
  }
}
