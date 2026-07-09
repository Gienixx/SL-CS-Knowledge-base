import {
  encryptSecret,
  exchangeGoogleAuthorizationCode,
  getGoogleConnection,
  getGoogleEnvironment,
  GOOGLE_CALENDAR_READONLY_SCOPE,
  googleApiRequest,
  hashState,
  redirectWithResult,
  serviceRequest
} from '../_shared/google-calendar.js'

export async function onRequestGet(context) {
  let returnTo = './home.html'

  try {
    const requestUrl = new URL(context.request.url)
    const oauthError = requestUrl.searchParams.get('error')
    const code = requestUrl.searchParams.get('code')
    const state = requestUrl.searchParams.get('state')

    if (oauthError) {
      return redirectWithResult(context.request, returnTo, {
        google_calendar: 'error',
        google_calendar_error: oauthError
      })
    }

    if (!code || !state) {
      return redirectWithResult(context.request, returnTo, {
        google_calendar: 'error',
        google_calendar_error: 'missing_callback_values'
      })
    }

    const environment = getGoogleEnvironment(context)
    const stateHash = await hashState(state)
    const statePath =
      `google_calendar_oauth_states` +
      `?select=state_hash,user_id,return_to,expires_at,used_at` +
      `&state_hash=eq.${encodeURIComponent(stateHash)}` +
      `&limit=1`
    const { data: stateRows } = await serviceRequest(environment, statePath)
    const stateRow = Array.isArray(stateRows) ? stateRows[0] : null

    if (!stateRow) {
      throw new Error('The Google authorization state is invalid or has expired.')
    }

    returnTo = stateRow.return_to || returnTo

    if (stateRow.used_at) {
      throw new Error('The Google authorization state has already been used.')
    }

    if (new Date(stateRow.expires_at).getTime() <= Date.now()) {
      throw new Error('The Google authorization state has expired.')
    }

    const usedAt = new Date().toISOString()
    const { data: claimedStates } = await serviceRequest(
      environment,
      `google_calendar_oauth_states` +
        `?state_hash=eq.${encodeURIComponent(stateHash)}` +
        `&used_at=is.null`,
      {
        method: 'PATCH',
        body: { used_at: usedAt },
        prefer: 'return=representation'
      }
    )

    if (!Array.isArray(claimedStates) || claimedStates.length !== 1) {
      throw new Error('The Google authorization state could not be claimed.')
    }

    const tokenData = await exchangeGoogleAuthorizationCode(environment, code)
    const existingConnection = await getGoogleConnection(
      environment,
      stateRow.user_id
    )

    if (!tokenData.refresh_token && !existingConnection?.encrypted_refresh_token) {
      throw new Error(
        'Google did not return a refresh token. Reconnect and approve offline calendar access.'
      )
    }

    const calendar = await googleApiRequest(
      'https://www.googleapis.com/calendar/v3/calendars/primary',
      tokenData.access_token
    )
    const encryptedRefreshToken = tokenData.refresh_token
      ? await encryptSecret(
          tokenData.refresh_token,
          environment.tokenEncryptionKey
        )
      : existingConnection.encrypted_refresh_token
    const now = new Date().toISOString()

    await serviceRequest(
      environment,
      'google_calendar_connections?on_conflict=user_id',
      {
        method: 'POST',
        body: {
          user_id: stateRow.user_id,
          encrypted_refresh_token: encryptedRefreshToken,
          calendar_id: calendar?.id || 'primary',
          calendar_summary: calendar?.summary || 'Google Calendar',
          calendar_timezone: calendar?.timeZone || null,
          granted_scope:
            tokenData.scope || GOOGLE_CALENDAR_READONLY_SCOPE,
          connected_at: existingConnection?.connected_at || now,
          updated_at: now,
          last_error: null
        },
        prefer: 'resolution=merge-duplicates,return=minimal'
      }
    )

    return redirectWithResult(context.request, returnTo, {
      google_calendar: 'connected'
    })
  } catch (error) {
    console.error('Google Calendar callback error:', error)
    return redirectWithResult(context.request, returnTo, {
      google_calendar: 'error',
      google_calendar_error: 'authorization_failed'
    })
  }
}
