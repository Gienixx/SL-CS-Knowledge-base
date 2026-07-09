import {
  buildGoogleAuthorizationUrl,
  createRandomToken,
  getGoogleEnvironment,
  hashState,
  jsonResponse,
  requireAuthorizedUser,
  safeReturnTo,
  serviceRequest
} from '../_shared/google-calendar.js'

export async function onRequestPost(context) {
  try {
    const authorization = await requireAuthorizedUser(context)

    if (!authorization.authorized) {
      return authorization.response
    }

    const environment = getGoogleEnvironment(context)
    let requestBody = {}

    try {
      requestBody = await context.request.json()
    } catch {
      requestBody = {}
    }

    const returnTo = safeReturnTo(requestBody.returnTo)
    const state = createRandomToken(32)
    const stateHash = await hashState(state)
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

    await serviceRequest(
      environment,
      `google_calendar_oauth_states?user_id=eq.${encodeURIComponent(authorization.user.id)}&used_at=is.null`,
      {
        method: 'DELETE',
        prefer: 'return=minimal'
      }
    )

    await serviceRequest(environment, 'google_calendar_oauth_states', {
      method: 'POST',
      body: {
        state_hash: stateHash,
        user_id: authorization.user.id,
        return_to: returnTo,
        expires_at: expiresAt
      },
      prefer: 'return=minimal'
    })

    return jsonResponse({
      authorizationUrl: buildGoogleAuthorizationUrl(
        environment,
        state,
        authorization.user.email
      ),
      expiresAt
    })
  } catch (error) {
    console.error('Google Calendar connect error:', error)
    return jsonResponse(
      {
        error: error?.message || 'Unable to start Google Calendar authorization.'
      },
      500
    )
  }
}
