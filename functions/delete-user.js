function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  })
}

class RequestError extends Error {
  constructor(message, status = 500) {
    super(message)
    this.status = status
  }
}

function normalizeEmail(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase()
    : ''
}

function normalizeText(value) {
  return typeof value === 'string'
    ? value.trim()
    : ''
}

function getBearerToken(request) {
  const authorization = request.headers.get('Authorization')

  if (!authorization || !authorization.startsWith('Bearer ')) {
    return null
  }

  return authorization.slice('Bearer '.length).trim()
}

function getRequiredEnvironment(context) {
  const {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY
  } = context.env

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new RequestError('Supabase environment variables are incomplete.', 500)
  }

  return {
    supabaseUrl: SUPABASE_URL.endsWith('/')
      ? SUPABASE_URL.slice(0, -1)
      : SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY,
    serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY
  }
}

async function parseResponseBody(response) {
  const responseText = await response.text()

  if (!responseText) {
    return null
  }

  try {
    return JSON.parse(responseText)
  } catch {
    return responseText
  }
}

function getResponseError(data, fallback) {
  if (data && typeof data === 'object') {
    return data.message || data.error || fallback
  }

  if (typeof data === 'string' && data.trim()) {
    return data
  }

  return fallback
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

  const data = await parseResponseBody(response)

  if (!response.ok) {
    throw new RequestError(
      getResponseError(data, 'Supabase request failed.'),
      response.status
    )
  }

  return data
}

async function requireAdmin(context) {
  const accessToken = getBearerToken(context.request)

  if (!accessToken) {
    throw new RequestError('Authentication required.', 401)
  }

  const {
    supabaseUrl,
    anonKey,
    serviceRoleKey
  } = getRequiredEnvironment(context)

  const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`
    }
  })

  const authenticatedUser = await parseResponseBody(userResponse)

  if (!userResponse.ok) {
    throw new RequestError('Your session is invalid or has expired.', 401)
  }

  const authenticatedEmail = normalizeEmail(authenticatedUser?.email)
  const authenticatedUserId = normalizeText(authenticatedUser?.id)

  if (!authenticatedEmail) {
    throw new RequestError('The authenticated account has no email address.', 401)
  }

  const permissionUrl = new URL(`${supabaseUrl}/rest/v1/login`)
  permissionUrl.searchParams.set('select', 'is_admin')
  permissionUrl.searchParams.set('email', `eq.${authenticatedEmail}`)
  permissionUrl.searchParams.set('limit', '1')

  const permissionRows = await serviceRequest(
    permissionUrl.toString(),
    serviceRoleKey
  )

  if (!Array.isArray(permissionRows) || permissionRows[0]?.is_admin !== true) {
    throw new RequestError('Administrator access required.', 403)
  }

  return {
    supabaseUrl,
    serviceRoleKey,
    authenticatedEmail,
    authenticatedUserId
  }
}

async function getLoginUser(supabaseUrl, serviceRoleKey, email) {
  const userUrl = new URL(`${supabaseUrl}/rest/v1/login`)
  userUrl.searchParams.set('select', 'name,email,is_admin,can_edit_articles')
  userUrl.searchParams.set('email', `eq.${email}`)
  userUrl.searchParams.set('limit', '1')

  const rows = await serviceRequest(userUrl.toString(), serviceRoleKey)

  return Array.isArray(rows) && rows.length > 0
    ? rows[0]
    : null
}

async function getAuthUserById(supabaseUrl, serviceRoleKey, userId) {
  if (!userId) {
    return null
  }

  const response = await fetch(
    `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`
      }
    }
  )

  const data = await parseResponseBody(response)

  if (response.status === 404) {
    return null
  }

  if (!response.ok) {
    throw new RequestError(
      getResponseError(data, 'Unable to retrieve the Supabase Auth user.'),
      response.status
    )
  }

  return data?.user || data || null
}

async function deleteLoginUser(supabaseUrl, serviceRoleKey, email) {
  const deleteUrl = new URL(`${supabaseUrl}/rest/v1/login`)
  deleteUrl.searchParams.set('email', `eq.${email}`)

  const rows = await serviceRequest(
    deleteUrl.toString(),
    serviceRoleKey,
    {
      method: 'DELETE',
      headers: {
        Prefer: 'return=representation'
      }
    }
  )

  return Array.isArray(rows) && rows.length > 0
    ? rows[0]
    : null
}

async function restoreLoginUser(supabaseUrl, serviceRoleKey, user) {
  await serviceRequest(
    `${supabaseUrl}/rest/v1/login`,
    serviceRoleKey,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(user)
    }
  )
}

async function deleteAuthUser(supabaseUrl, serviceRoleKey, userId) {
  if (!userId) {
    return
  }

  await serviceRequest(
    `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
    serviceRoleKey,
    {
      method: 'DELETE'
    }
  )
}

export async function onRequestPost(context) {
  try {
    const admin = await requireAdmin(context)

    let requestBody

    try {
      requestBody = await context.request.json()
    } catch {
      throw new RequestError('The request body must contain valid JSON.', 400)
    }

    const userId = normalizeText(requestBody.userId)
    const email = normalizeEmail(requestBody.email)

    if (!email) {
      throw new RequestError('A valid user email is required.', 400)
    }

    if (
      email === admin.authenticatedEmail ||
      (userId && userId === admin.authenticatedUserId)
    ) {
      throw new RequestError('You cannot delete your own administrator account.', 400)
    }

    const loginUser = await getLoginUser(
      admin.supabaseUrl,
      admin.serviceRoleKey,
      email
    )

    if (!loginUser) {
      throw new RequestError('User not found in the login table.', 404)
    }

    const authUser = await getAuthUserById(
      admin.supabaseUrl,
      admin.serviceRoleKey,
      userId
    )

    if (authUser) {
      const authEmail = normalizeEmail(authUser.email)

      if (authEmail && authEmail !== email) {
        throw new RequestError(
          'The selected User ID does not match the selected email address.',
          409
        )
      }
    }

    const deletedLoginUser = await deleteLoginUser(
      admin.supabaseUrl,
      admin.serviceRoleKey,
      email
    )

    if (!deletedLoginUser) {
      throw new RequestError('User not found in the login table.', 404)
    }

    if (authUser && userId) {
      try {
        await deleteAuthUser(
          admin.supabaseUrl,
          admin.serviceRoleKey,
          userId
        )
      } catch (error) {
        try {
          await restoreLoginUser(
            admin.supabaseUrl,
            admin.serviceRoleKey,
            deletedLoginUser
          )
        } catch (rollbackError) {
          console.error('Unable to restore login user after auth deletion failed:', rollbackError)
        }

        throw error
      }
    }

    return jsonResponse({
      success: true,
      deletedUser: {
        user_id: userId,
        email
      }
    })
  } catch (error) {
    console.error('Delete-user function error:', error)

    return jsonResponse(
      {
        error: error.message || 'Unable to delete the user.'
      },
      Number.isInteger(error.status) ? error.status : 500
    )
  }
}
