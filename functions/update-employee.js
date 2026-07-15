import {
  WorkforceAuthorizationError,
  requireWorkforcePermission
} from './_shared/workforce-auth.js'
import { WORKFORCE_PERMISSION_KEYS } from '../shared/workforce-access.js'

class EmployeeUpdateError extends Error {
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

async function supabaseRequest(url, key, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${options.accessToken || key}`,
      ...(options.headers || {})
    }
  })
  const data = await parseResponse(response)
  if (!response.ok) {
    throw new EmployeeUpdateError(
      responseError(data, 'Supabase request failed.'),
      response.status
    )
  }
  return data
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase()
}

function permissionMap(value) {
  const source = value && typeof value === 'object' ? value : {}
  return Object.fromEntries(
    WORKFORCE_PERMISSION_KEYS.map(key => [key, source[key] === true])
  )
}

async function loadSnapshot(authorization, userId) {
  const profileUrl = new URL(`${authorization.supabaseUrl}/rest/v1/profiles`)
  profileUrl.searchParams.set('select', '*')
  profileUrl.searchParams.set('user_id', `eq.${userId}`)
  profileUrl.searchParams.set('limit', '1')

  const permissionUrl = new URL(`${authorization.supabaseUrl}/rest/v1/user_permissions`)
  permissionUrl.searchParams.set('select', 'permission_key,is_granted')
  permissionUrl.searchParams.set('user_id', `eq.${userId}`)

  const [profiles, permissionRows, authResult] = await Promise.all([
    supabaseRequest(profileUrl, authorization.serviceRoleKey),
    supabaseRequest(permissionUrl, authorization.serviceRoleKey),
    supabaseRequest(
      `${authorization.supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
      authorization.serviceRoleKey
    )
  ])
  const profile = Array.isArray(profiles) ? profiles[0] : null
  const authUser = authResult?.user || authResult
  if (!profile || !authUser?.id) {
    throw new EmployeeUpdateError('The employee identity could not be found.', 404)
  }

  const loginUrl = new URL(`${authorization.supabaseUrl}/rest/v1/login`)
  loginUrl.searchParams.set('select', 'name,email,is_admin,can_edit_articles')
  loginUrl.searchParams.set('email', `eq.${normalizeEmail(profile.email)}`)
  loginUrl.searchParams.set('limit', '1')
  const loginRows = await supabaseRequest(loginUrl, authorization.serviceRoleKey)

  return {
    profile,
    authUser,
    login: Array.isArray(loginRows) ? loginRows[0] : null,
    permissions: Object.fromEntries(
      WORKFORCE_PERMISSION_KEYS.map(key => [
        key,
        permissionRows.find(row => row.permission_key === key)?.is_granted === true
      ])
    )
  }
}

async function updateAuthEmail(authorization, userId, email) {
  return supabaseRequest(
    `${authorization.supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
    authorization.serviceRoleKey,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, email_confirm: true })
    }
  )
}

async function saveWorkforceProfile(authorization, values) {
  return supabaseRequest(
    `${authorization.supabaseUrl}/rest/v1/rpc/workforce_admin_save_employee`,
    authorization.anonKey,
    {
      method: 'POST',
      accessToken: authorization.accessToken,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values)
    }
  )
}

async function updateCompatibilityIdentity(
  authorization,
  originalEmail,
  values
) {
  const loginUrl = new URL(`${authorization.supabaseUrl}/rest/v1/login`)
  loginUrl.searchParams.set('email', `eq.${originalEmail}`)
  return supabaseRequest(loginUrl, authorization.serviceRoleKey, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify(values)
  })
}

async function setEmploymentStatus(authorization, userId, employmentStatus) {
  const profileUrl = new URL(`${authorization.supabaseUrl}/rest/v1/profiles`)
  profileUrl.searchParams.set('user_id', `eq.${userId}`)
  return supabaseRequest(profileUrl, authorization.serviceRoleKey, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employment_status: employmentStatus })
  })
}

async function verifyIdentity(
  authorization,
  userId,
  email,
  employmentStatus
) {
  const profileUrl = new URL(`${authorization.supabaseUrl}/rest/v1/profiles`)
  profileUrl.searchParams.set('select', 'user_id,email,employment_status')
  profileUrl.searchParams.set('user_id', `eq.${userId}`)
  profileUrl.searchParams.set('email', `eq.${email}`)
  profileUrl.searchParams.set('employment_status', `eq.${employmentStatus}`)
  profileUrl.searchParams.set('limit', '1')

  const loginUrl = new URL(`${authorization.supabaseUrl}/rest/v1/login`)
  loginUrl.searchParams.set('select', 'email')
  loginUrl.searchParams.set('email', `eq.${email}`)
  loginUrl.searchParams.set('limit', '1')

  const linkUrl = new URL(`${authorization.supabaseUrl}/rest/v1/workforce_identity_links`)
  linkUrl.searchParams.set('select', 'auth_user_id,profile_user_id,is_active')
  linkUrl.searchParams.set('auth_user_id', `eq.${userId}`)
  linkUrl.searchParams.set('profile_user_id', `eq.${userId}`)
  linkUrl.searchParams.set('is_active', 'eq.true')
  linkUrl.searchParams.set('limit', '1')

  const [profiles, logins, links] = await Promise.all([
    supabaseRequest(profileUrl, authorization.serviceRoleKey),
    supabaseRequest(loginUrl, authorization.serviceRoleKey),
    supabaseRequest(linkUrl, authorization.serviceRoleKey)
  ])
  if (!profiles?.length || !logins?.length || !links?.length) {
    throw new EmployeeUpdateError(
      'Identity synchronization verification failed; previous values will be restored.',
      500
    )
  }
}

async function restoreSnapshot(authorization, snapshot, currentEmail) {
  const oldEmail = normalizeEmail(snapshot.profile.email)
  await updateAuthEmail(authorization, snapshot.profile.user_id, oldEmail)
  await updateCompatibilityIdentity(
    authorization,
    normalizeEmail(currentEmail),
    {
      name: snapshot.login?.name || snapshot.profile.full_name,
      email: oldEmail,
      is_admin: snapshot.login?.is_admin === true,
      can_edit_articles: snapshot.login?.can_edit_articles === true
    }
  )
  await saveWorkforceProfile(authorization, {
    p_user_id: snapshot.profile.user_id,
    p_full_name: snapshot.profile.full_name,
    p_employee_id: snapshot.profile.employee_id,
    p_employment_status: snapshot.profile.employment_status,
    p_access_type: snapshot.profile.base_role === 'admin'
      ? snapshot.profile.is_agent ? 'admin_agent' : 'admin'
      : 'regular_agent',
    p_team_id: snapshot.profile.team_id,
    p_supervisor_id: snapshot.profile.supervisor_id,
    p_timezone: snapshot.profile.timezone,
    p_permissions: snapshot.permissions,
    p_reason: 'Automatic rollback after employee identity update failure'
  })
}

export async function onRequestPost(context) {
  let authorization
  let snapshot
  let mutationStarted = false
  let requestedEmail = ''
  try {
    authorization = context.data?.workforceAuthorization ||
      await requireWorkforcePermission(context, 'manage_employees', {
        requireAdmin: true
      })
    const body = await context.request.json().catch(() => null)
    if (!body) throw new EmployeeUpdateError('The request body must contain valid JSON.', 400)

    const userId = normalizeText(body.userId)
    const fullName = normalizeText(body.fullName)
    const email = normalizeEmail(body.email)
    requestedEmail = email
    const employeeId = normalizeText(body.employeeId)
    const accessType = normalizeText(body.accessType)
    const employmentStatus = normalizeText(body.employmentStatus)
    const timezone = normalizeText(body.timezone) || 'America/New_York'
    const permissions = permissionMap(body.permissions)

    if (!/^[0-9a-f-]{36}$/i.test(userId) || !fullName || !employeeId) {
      throw new EmployeeUpdateError('Employee, full name, and employee ID are required.', 400)
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new EmployeeUpdateError('A valid employee email is required.', 400)
    }
    if (!['admin', 'regular_agent', 'admin_agent'].includes(accessType)) {
      throw new EmployeeUpdateError('Select a valid access type.', 400)
    }
    if (!['active', 'on_leave', 'inactive', 'terminated'].includes(employmentStatus)) {
      throw new EmployeeUpdateError('Select a valid employment status.', 400)
    }

    snapshot = await loadSnapshot(authorization, userId)
    if (snapshot.profile.is_system_admin === true) {
      throw new EmployeeUpdateError('The protected system owner cannot be changed.', 403)
    }
    if (normalizeEmail(snapshot.authUser.email) !== normalizeEmail(snapshot.profile.email)) {
      throw new EmployeeUpdateError('Auth and profile emails are already out of sync.', 409)
    }

    mutationStarted = true
    const emailChanged = email !== normalizeEmail(snapshot.profile.email)
    if (emailChanged) await updateAuthEmail(authorization, userId, email)

    await updateCompatibilityIdentity(
      authorization,
      normalizeEmail(snapshot.profile.email),
      {
        name: fullName,
        email,
        is_admin: ['admin', 'admin_agent'].includes(accessType),
        can_edit_articles: permissions.edit_articles
      }
    )
    const result = await saveWorkforceProfile(authorization, {
      p_user_id: userId,
      p_full_name: fullName,
      p_employee_id: employeeId,
      p_employment_status: employmentStatus,
      p_access_type: accessType,
      p_team_id: body.teamId || null,
      p_supervisor_id: body.supervisorId || null,
      p_timezone: timezone,
      p_permissions: permissions,
      p_reason: normalizeText(body.reason) || 'Updated through synchronized employee editor'
    })
    // The legacy login mirror trigger reactivates inactive profiles. Reapply the
    // administrator's requested status after every compatibility write.
    await setEmploymentStatus(authorization, userId, employmentStatus)
    await verifyIdentity(
      authorization,
      userId,
      email,
      employmentStatus
    )

    await supabaseRequest(
      `${authorization.supabaseUrl}/rest/v1/workforce_audit_logs`,
      authorization.serviceRoleKey,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actor_user_id: authorization.access.user_id,
          action: 'employee_identity_updated',
          entity_type: 'profiles',
          entity_id: userId,
          before_data: {
            email: snapshot.profile.email,
            full_name: snapshot.profile.full_name
          },
          after_data: { email, full_name: fullName, access_type: accessType },
          reason: normalizeText(body.reason) || 'Synchronized employee edit'
        })
      }
    )

    return jsonResponse({ success: true, employee: result })
  } catch (error) {
    if (mutationStarted && authorization && snapshot) {
      try {
        await restoreSnapshot(
          authorization,
          snapshot,
          requestedEmail || snapshot.profile.email
        )
      } catch (rollbackError) {
        console.error('Employee identity rollback failed:', rollbackError)
        return jsonResponse({
          error: 'Employee update failed and automatic rollback requires administrator review.'
        }, 500)
      }
    }
    console.error('Synchronized employee update failed:', error)
    const status = error instanceof EmployeeUpdateError ||
      error instanceof WorkforceAuthorizationError
      ? error.status
      : 500
    return jsonResponse({ error: error.message || 'Unable to update the employee.' }, status)
  }
}
