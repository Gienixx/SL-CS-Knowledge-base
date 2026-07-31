import {
  WorkforceAuthorizationError,
  requireWorkforcePermission
} from './_shared/workforce-auth.js'

class DeletedEmployeeReinviteError extends Error {
  constructor(message, status = 500) {
    super(message)
    this.status = status
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  })
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function normalizeUuid(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)
    ? text
    : null
}

function maskEmail(value) {
  const email = normalizeEmail(value)
  const [localPart, domain] = email.split('@')
  if (!localPart || !domain) return ''
  return `${localPart.slice(0, 1)}${'*'.repeat(Math.max(3, localPart.length - 1))}@${domain}`
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

async function request(url, key, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(options.headers || {})
    }
  })
  const data = await parseResponse(response)
  if (!response.ok) {
    throw new DeletedEmployeeReinviteError(
      responseError(data, 'Supabase request failed.'),
      response.status
    )
  }
  return data
}

async function rpc(authorization, name, body) {
  return request(
    `${authorization.supabaseUrl}/rest/v1/rpc/${name}`,
    authorization.serviceRoleKey,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
  )
}

async function deleteAuthUser(authorization, authUserId) {
  if (!authUserId) return false
  try {
    const response = await fetch(
      `${authorization.supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(authUserId)}`,
      {
        method: 'DELETE',
        headers: {
          apikey: authorization.serviceRoleKey,
          Authorization: `Bearer ${authorization.serviceRoleKey}`
        }
      }
    )
    if (!response.ok) {
      console.error('Deleted employee reinvite rollback failed:', await response.text())
    }
    return response.ok
  } catch (error) {
    console.error('Deleted employee reinvite rollback failed:', error)
    return false
  }
}

export async function onRequestPost(context) {
  let authorization
  let createdAuthUserId = null

  try {
    authorization = context.data?.workforceAuthorization ||
      await requireWorkforcePermission(context, 'manage_employees', {
        requireAdmin: true
      })

    const body = await context.request.json().catch(() => null)
    const profileUserId = normalizeUuid(body?.userId)
    const email = normalizeEmail(body?.email)

    if (!profileUserId) {
      throw new DeletedEmployeeReinviteError(
        'Select a valid archived employee.',
        400
      )
    }
    if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320)) {
      throw new DeletedEmployeeReinviteError(
        'Enter the deleted employee’s original email address.',
        400
      )
    }

    const candidate = await rpc(
      authorization,
      'workforce_service_get_deleted_employee_reinvite',
      {
        p_actor_auth_user_id: authorization.user.id,
        p_profile_user_id: profileUserId,
        p_email: email
      }
    )
    const deliveryEmail = normalizeEmail(candidate?.delivery_email || email)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(deliveryEmail) || deliveryEmail.length > 320) {
      throw new DeletedEmployeeReinviteError(
        'The restoration invitation does not have a valid delivery address.',
        502
      )
    }
    const redirectUrl = new URL(
      '/change-password.html?invite=1&restore=1',
      context.request.url
    )

    let restoration
    if (candidate?.mode === 'resend' && normalizeUuid(candidate.auth_user_id)) {
      await request(
        `${authorization.supabaseUrl}/auth/v1/recover?redirect_to=${encodeURIComponent(redirectUrl.href)}`,
        authorization.serviceRoleKey,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: deliveryEmail })
        }
      )

      restoration = await rpc(
        authorization,
        'workforce_service_mark_deleted_employee_reinvite_resent',
        {
          p_actor_auth_user_id: authorization.user.id,
          p_profile_user_id: profileUserId,
          p_auth_user_id: candidate.auth_user_id,
          p_email: deliveryEmail
        }
      )
    } else {
      const inviteData = await request(
        `${authorization.supabaseUrl}/auth/v1/invite?redirect_to=${encodeURIComponent(redirectUrl.href)}`,
        authorization.serviceRoleKey,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: deliveryEmail,
            data: {
              name: candidate?.full_name,
              full_name: candidate?.full_name,
              workforce_profile_id: profileUserId,
              restores_deleted_employee: true
            }
          })
        }
      )
      createdAuthUserId = normalizeUuid(inviteData?.id || inviteData?.user?.id)
      if (!createdAuthUserId) {
        throw new DeletedEmployeeReinviteError(
          'Supabase did not return the invited Auth user.',
          502
        )
      }

      restoration = await rpc(
        authorization,
        'workforce_service_prepare_deleted_employee_reinvite',
        {
          p_actor_auth_user_id: authorization.user.id,
          p_profile_user_id: profileUserId,
          p_auth_user_id: createdAuthUserId,
          p_email: deliveryEmail
        }
      )
      createdAuthUserId = null
    }

    return jsonResponse({
      success: true,
      invitationSent: true,
      invitationResent: candidate?.mode === 'resend',
      restorationPending: true,
      profileStillArchived: true,
      employeeId: restoration?.employee_id || candidate?.employee_id,
      fullName: candidate?.full_name,
      deliveryEmailMasked: maskEmail(deliveryEmail)
    })
  } catch (error) {
    if (createdAuthUserId && authorization) {
      await deleteAuthUser(authorization, createdAuthUserId)
    }
    console.error('Deleted employee reinvite failed:', error)
    const status = error instanceof DeletedEmployeeReinviteError ||
      error instanceof WorkforceAuthorizationError
      ? error.status
      : 500
    return jsonResponse({
      error: error.message || 'Unable to reinvite the deleted employee.'
    }, status)
  }
}
