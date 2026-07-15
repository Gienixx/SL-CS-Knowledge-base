import {
  WorkforceAuthorizationError,
  requireWorkforcePermission
} from './_shared/workforce-auth.js'
import { WORKFORCE_PERMISSION_KEYS } from '../shared/workforce-access.js'

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

function errorMessage(data, fallback) {
  return data && typeof data === 'object'
    ? data.message || data.error_description || data.error || fallback
    : typeof data === 'string' && data.trim() ? data : fallback
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

function permissionMap(body, accessType) {
  const source = body.permissions && typeof body.permissions === 'object'
    ? body.permissions
    : {}
  const legacyAdmin = body.isAdmin === true
  return Object.fromEntries(WORKFORCE_PERMISSION_KEYS.map(key => {
    let granted = source[key] === true
    if (!body.permissions && legacyAdmin) granted = true
    if (key === 'edit_articles' && body.canEditArticles === true) granted = true
    return [key, granted]
  }))
}

async function deleteAuthUser(supabaseUrl, serviceRoleKey, userId) {
  if (!userId) return false
  try {
    const response = await fetch(
      `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
      {
        method: 'DELETE',
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`
        }
      }
    )
    if (!response.ok) {
      console.error('Invitation rollback failed:', await response.text())
    }
    return response.ok
  } catch (error) {
    console.error('Invitation rollback failed:', error)
    return false
  }
}

export async function onRequestPost(context) {
  let authUserId = null
  let environment = null

  try {
    const authorization = await requireWorkforcePermission(
      context,
      'manage_employees',
      { requireAdmin: true }
    )
    environment = authorization

    let body
    try {
      body = await context.request.json()
    } catch {
      return jsonResponse({ error: 'The request body must contain valid JSON.' }, 400)
    }

    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const email = normalizeEmail(body.email)
    const accessType = typeof body.accessType === 'string'
      ? body.accessType.trim()
      : body.isAdmin === true ? 'admin' : 'regular_agent'
    const permissions = permissionMap(body, accessType)
    const teamId = normalizeUuid(body.teamId)
    const supervisorId = normalizeUuid(body.supervisorId)

    if (!name || name.length > 160) {
      return jsonResponse({ error: 'A valid full name is required.' }, 400)
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
      return jsonResponse({ error: 'A valid email address is required.' }, 400)
    }
    if (!['admin', 'regular_agent', 'admin_agent'].includes(accessType)) {
      return jsonResponse({ error: 'Select a valid initial access type.' }, 400)
    }
    if (body.teamId && !teamId) {
      return jsonResponse({ error: 'The selected team is invalid.' }, 400)
    }
    if (body.supervisorId && !supervisorId) {
      return jsonResponse({ error: 'The selected supervisor is invalid.' }, 400)
    }

    const redirectUrl = new URL('/change-password.html?invite=1', context.request.url)
    const inviteResponse = await fetch(
      `${authorization.supabaseUrl}/auth/v1/invite?redirect_to=${encodeURIComponent(redirectUrl.href)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: authorization.serviceRoleKey,
          Authorization: `Bearer ${authorization.serviceRoleKey}`
        },
        body: JSON.stringify({
          email,
          data: { name, full_name: name, access_type: accessType }
        })
      }
    )
    const inviteData = await parseResponse(inviteResponse)
    if (!inviteResponse.ok) {
      return jsonResponse(
        { error: errorMessage(inviteData, 'Unable to send the invitation email.') },
        inviteResponse.status
      )
    }

    authUserId = inviteData?.id || inviteData?.user?.id
    if (!authUserId) throw new Error('Supabase did not return the invited Auth user.')

    const provisionResponse = await fetch(
      `${authorization.supabaseUrl}/rest/v1/rpc/workforce_service_create_invitation`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: authorization.serviceRoleKey,
          Authorization: `Bearer ${authorization.serviceRoleKey}`
        },
        body: JSON.stringify({
          p_actor_auth_user_id: authorization.user.id,
          p_auth_user_id: authUserId,
          p_full_name: name,
          p_email: email,
          p_access_type: accessType,
          p_permissions: permissions,
          p_team_id: teamId,
          p_supervisor_id: supervisorId
        })
      }
    )
    const provisionData = await parseResponse(provisionResponse)
    if (!provisionResponse.ok) {
      const rolledBack = await deleteAuthUser(
        authorization.supabaseUrl,
        authorization.serviceRoleKey,
        authUserId
      )
      authUserId = null
      console.error('Invitation provisioning failed:', provisionData)
      return jsonResponse({
        error: errorMessage(provisionData, 'Unable to provision the invited employee.'),
        rolledBack
      }, provisionResponse.status)
    }

    return jsonResponse({
      success: true,
      invitationSent: true,
      employee: provisionData
    })
  } catch (error) {
    if (authUserId && environment) {
      await deleteAuthUser(environment.supabaseUrl, environment.serviceRoleKey, authUserId)
    }
    console.error('Unified invitation error:', error)
    const status = error instanceof WorkforceAuthorizationError
      ? error.status
      : 500
    return jsonResponse({
      error: error.message || 'Unable to invite the employee.'
    }, status)
  }
}
