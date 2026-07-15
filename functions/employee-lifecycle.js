import {
  requireWorkforcePermission,
  WorkforceAuthorizationError
} from './_shared/workforce-auth.js'

class LifecycleError extends Error {
  constructor(message, status = 500) {
    super(message)
    this.status = status
  }
}

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  })
}

async function readResponse(response) {
  const text = await response.text()
  if (!text) return null
  try { return JSON.parse(text) } catch { return text }
}

async function request(url, key, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { apikey: key, Authorization: `Bearer ${options.accessToken || key}`, ...(options.headers || {}) }
  })
  const data = await readResponse(response)
  if (!response.ok && !(options.allowNotFound && response.status === 404)) {
    throw new LifecycleError(data?.message || data?.error || 'Supabase request failed.', response.status)
  }
  return data
}

async function changeDatabaseLifecycle(authorization, userId, action, reason) {
  return request(
    `${authorization.supabaseUrl}/rest/v1/rpc/workforce_admin_change_employee_lifecycle`,
    authorization.anonKey,
    {
      method: 'POST',
      accessToken: authorization.accessToken,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_user_id: userId, p_action: action, p_reason: reason || null })
    }
  )
}

async function updateAuth(authorization, userId, values) {
  return request(
    `${authorization.supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
    authorization.serviceRoleKey,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) }
  )
}

export async function onRequestPost(context) {
  let authorization
  let databaseChanged = false
  let action = ''
  let userId = ''
  try {
    authorization = context.data?.workforceAuthorization ||
      await requireWorkforcePermission(context, 'manage_employees', { requireAdmin: true })
    const body = await context.request.json().catch(() => null)
    action = String(body?.action || '').trim().toLowerCase()
    userId = String(body?.userId || '').trim()

    if (!/^[0-9a-f-]{36}$/i.test(userId) || !['deactivate', 'reactivate', 'delete'].includes(action)) {
      throw new LifecycleError('Employee and a valid lifecycle action are required.', 400)
    }
    if (action === 'delete' && body?.confirmation !== 'DELETE') {
      throw new LifecycleError('Type DELETE to confirm permanent account removal.', 400)
    }

    const result = await changeDatabaseLifecycle(authorization, userId, action, body?.reason)
    databaseChanged = true

    if (action === 'delete') {
      await request(
        `${authorization.supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}?should_soft_delete=true`,
        authorization.serviceRoleKey,
        { method: 'DELETE', allowNotFound: true }
      )
    } else {
      await updateAuth(authorization, userId, {
        ban_duration: action === 'deactivate' ? '876000h' : 'none'
      })
    }

    return reply({ success: true, lifecycle: result })
  } catch (error) {
    if (databaseChanged && authorization && action !== 'delete') {
      try {
        await changeDatabaseLifecycle(
          authorization,
          userId,
          action === 'deactivate' ? 'reactivate' : 'deactivate',
          'Automatic rollback after Auth lifecycle update failure'
        )
      } catch (rollbackError) {
        console.error('Employee lifecycle rollback failed:', rollbackError)
        return reply({ error: 'Lifecycle update failed and requires administrator review.' }, 500)
      }
    }
    console.error('Employee lifecycle update failed:', error)
    const status = error instanceof LifecycleError || error instanceof WorkforceAuthorizationError
      ? error.status : 500
    return reply({ error: error.message || 'Unable to update the employee lifecycle.' }, status)
  }
}
