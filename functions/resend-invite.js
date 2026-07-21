import {
  WorkforceAuthorizationError,
  requireWorkforcePermission
} from './_shared/workforce-auth.js'

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  })
}

async function parseResponse(response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function responseError(data, fallback) {
  if (data && typeof data === 'object') {
    return data.message || data.error_description || data.error || fallback
  }
  return typeof data === 'string' && data.trim() ? data : fallback
}

async function serviceRequest(url, serviceRoleKey, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      ...(options.headers || {})
    }
  })
  const data = await parseResponse(response)
  if (!response.ok) {
    throw new WorkforceAuthorizationError(
      responseError(data, 'Supabase request failed.'),
      response.status
    )
  }
  return data
}

export async function onRequestPost(context) {
  try {
    const authorization = context.data?.workforceAuthorization ||
      await requireWorkforcePermission(context, 'manage_employees', {
        requireAdmin: true
      })
    let body
    try {
      body = await context.request.json()
    } catch {
      return jsonResponse({ error: 'The request body must contain valid JSON.' }, 400)
    }

    const userId = typeof body.userId === 'string' ? body.userId.trim() : ''
    if (!/^[0-9a-f-]{36}$/i.test(userId)) {
      return jsonResponse({ error: 'Select a valid invited employee.' }, 400)
    }

    const profileUrl = new URL(`${authorization.supabaseUrl}/rest/v1/profiles`)
    profileUrl.searchParams.set(
      'select',
      'user_id,email,employee_id,full_name,onboarding_status,invited_at,is_system_admin'
    )
    profileUrl.searchParams.set('user_id', `eq.${userId}`)
    profileUrl.searchParams.set('limit', '1')
    const profileRows = await serviceRequest(
      profileUrl,
      authorization.serviceRoleKey
    )
    const profile = Array.isArray(profileRows) ? profileRows[0] : null

    if (!profile) {
      return jsonResponse({ error: 'The selected workforce account was not found.' }, 404)
    }
    if (profile.is_system_admin === true) {
      return jsonResponse({ error: 'The protected system owner cannot be modified.' }, 403)
    }
    if (profile.onboarding_status !== 'invited') {
      return jsonResponse({
        error: 'Only employees with a pending invitation can be sent another invite.'
      }, 409)
    }

    const redirectUrl = new URL('/change-password.html?invite=1', context.request.url)
    await serviceRequest(
      `${authorization.supabaseUrl}/auth/v1/recover?redirect_to=${encodeURIComponent(redirectUrl.href)}`,
      authorization.serviceRoleKey,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: profile.email })
      }
    )

    const updateUrl = new URL(`${authorization.supabaseUrl}/rest/v1/profiles`)
    updateUrl.searchParams.set('user_id', `eq.${profile.user_id}`)
    await serviceRequest(updateUrl, authorization.serviceRoleKey, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invitation_last_sent_at: new Date().toISOString() })
    })

    await serviceRequest(
      `${authorization.supabaseUrl}/rest/v1/workforce_audit_logs`,
      authorization.serviceRoleKey,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actor_user_id: authorization.access.user_id,
          action: 'employee_invitation_resent',
          entity_type: 'profiles',
          entity_id: profile.user_id,
          after_data: {
            employee_id: profile.employee_id,
            email: profile.email,
            onboarding_status: profile.onboarding_status
          },
          reason: 'Invitation resent from Employee Profiles'
        })
      }
    )

    return jsonResponse({
      success: true,
      invitationSent: true,
      employeeId: profile.employee_id
    })
  } catch (error) {
    console.error('Resend invitation error:', error)
    const status = error instanceof WorkforceAuthorizationError
      ? error.status
      : 500
    return jsonResponse({
      error: error.message || 'Unable to resend the invitation.'
    }, status)
  }
}
