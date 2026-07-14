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

function getBearerToken(request) {
  const authorization = request.headers.get('Authorization')

  if (!authorization || !authorization.startsWith('Bearer ')) {
    return null
  }

  return authorization.slice('Bearer '.length).trim()
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

async function isProtectedSystemOwner(
  supabaseUrl,
  serviceRoleKey,
  email,
  userId = ''
) {
  const ownerUrl = new URL(`${supabaseUrl}/rest/v1/profiles`)
  ownerUrl.searchParams.set('select', 'user_id,email')
  ownerUrl.searchParams.set('is_system_admin', 'eq.true')
  ownerUrl.searchParams.set('limit', '1')

  const owners = await serviceRequest(ownerUrl.toString(), serviceRoleKey)
  const owner = Array.isArray(owners) ? owners[0] : null

  return Boolean(owner) && (
    normalizeEmail(owner.email) === normalizeEmail(email) ||
    (userId && owner.user_id === userId)
  )
}

async function loginEmailExists(supabaseUrl, serviceRoleKey, email) {
  const userUrl = new URL(`${supabaseUrl}/rest/v1/login`)
  userUrl.searchParams.set('select', 'email')
  userUrl.searchParams.set('email', `eq.${email}`)
  userUrl.searchParams.set('limit', '1')

  const rows = await serviceRequest(userUrl.toString(), serviceRoleKey)
  return Array.isArray(rows) && rows.length > 0
}

async function getAuthUserById(
  supabaseUrl,
  serviceRoleKey,
  userId
) {
  if (!userId) {
    return null
  }

  const result = await serviceRequest(
    `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
    serviceRoleKey
  )

  return result?.user || result || null
}

async function updateAuthEmail(
  supabaseUrl,
  serviceRoleKey,
  userId,
  email
) {
  if (!userId) {
    return null
  }

  return serviceRequest(
    `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
    serviceRoleKey,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email })
    }
  )
}

async function updateLoginUser(
  supabaseUrl,
  serviceRoleKey,
  originalEmail,
  updates
) {
  const updateUrl = new URL(`${supabaseUrl}/rest/v1/login`)
  updateUrl.searchParams.set('email', `eq.${originalEmail}`)

  const rows = await serviceRequest(
    updateUrl.toString(),
    serviceRoleKey,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: JSON.stringify(updates)
    }
  )

  return Array.isArray(rows) && rows.length > 0
    ? rows[0]
    : null
}

function formatUser(user) {
  return {
    name: normalizeText(user?.name),
    email: normalizeEmail(user?.email),
    is_admin: user?.is_admin === true,
    can_edit_articles: user?.can_edit_articles === true
  }
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

    const action = normalizeText(requestBody.action).toLowerCase()

    if (action !== 'get' && action !== 'update') {
      throw new RequestError('A valid settings action is required.', 400)
    }

    const originalEmail = normalizeEmail(
      requestBody.originalEmail || requestBody.email
    )
    const requestedUserId = normalizeText(requestBody.userId)

    if (!originalEmail) {
      throw new RequestError('A valid user email is required.', 400)
    }

    if (await isProtectedSystemOwner(
      admin.supabaseUrl,
      admin.serviceRoleKey,
      originalEmail,
      requestedUserId
    )) {
      throw new RequestError(
        'The protected system owner cannot be viewed or changed in User Management.',
        403
      )
    }

    const existingUser = await getLoginUser(
      admin.supabaseUrl,
      admin.serviceRoleKey,
      originalEmail
    )

    if (!existingUser) {
      throw new RequestError('User not found in the login table.', 404)
    }

    if (action === 'get') {
      return jsonResponse({
        success: true,
        user: formatUser(existingUser)
      })
    }

    const userId = requestedUserId
    const name = normalizeText(requestBody.name || existingUser.name)
    const email = normalizeEmail(requestBody.email || originalEmail)
    const isAdmin = requestBody.isAdmin
    const canEditArticles = requestBody.canEditArticles

    if (!name) {
      throw new RequestError('A valid user name is required.', 400)
    }

    if (!email) {
      throw new RequestError('A valid user email is required.', 400)
    }

    if (typeof isAdmin !== 'boolean' || typeof canEditArticles !== 'boolean') {
      throw new RequestError(
        'Administrator and editor settings must be true or false.',
        400
      )
    }

    const editingSelf =
      (userId && userId === admin.authenticatedUserId) ||
      originalEmail === admin.authenticatedEmail

    if (editingSelf && isAdmin !== true) {
      throw new RequestError(
        'You cannot remove administrator access from your own account.',
        400
      )
    }

    const emailChanged = email !== originalEmail
    let authUser = null

    if (userId) {
      authUser = await getAuthUserById(
        admin.supabaseUrl,
        admin.serviceRoleKey,
        userId
      )

      if (!authUser) {
        throw new RequestError('The Supabase Auth user was not found.', 404)
      }

      const authEmail = normalizeEmail(authUser.email)

      if (authEmail && authEmail !== originalEmail) {
        throw new RequestError(
          'The selected User ID does not match the selected email address.',
          409
        )
      }
    }

    if (emailChanged && !userId) {
      throw new RequestError(
        'This email cannot be changed because no Supabase Auth User ID is linked to the account.',
        400
      )
    }

    if (emailChanged && await loginEmailExists(
      admin.supabaseUrl,
      admin.serviceRoleKey,
      email
    )) {
      throw new RequestError(
        'Another user already uses that email address.',
        409
      )
    }

    let authEmailUpdated = false

    if (emailChanged) {
      await updateAuthEmail(
        admin.supabaseUrl,
        admin.serviceRoleKey,
        userId,
        email
      )
      authEmailUpdated = true
    }

    let updatedUser

    try {
      updatedUser = await updateLoginUser(
        admin.supabaseUrl,
        admin.serviceRoleKey,
        originalEmail,
        {
          name,
          email,
          is_admin: isAdmin,
          can_edit_articles: canEditArticles
        }
      )
    } catch (error) {
      if (authEmailUpdated) {
        try {
          await updateAuthEmail(
            admin.supabaseUrl,
            admin.serviceRoleKey,
            userId,
            originalEmail
          )
        } catch (rollbackError) {
          console.error('Unable to roll back auth email:', rollbackError)
        }
      }

      throw error
    }

    if (!updatedUser) {
      if (authEmailUpdated) {
        try {
          await updateAuthEmail(
            admin.supabaseUrl,
            admin.serviceRoleKey,
            userId,
            originalEmail
          )
        } catch (rollbackError) {
          console.error('Unable to roll back auth email:', rollbackError)
        }
      }

      throw new RequestError('User not found in the login table.', 404)
    }

    return jsonResponse({
      success: true,
      user: {
        user_id: userId,
        ...formatUser(updatedUser)
      }
    })
  } catch (error) {
    console.error('User-settings function error:', error)

    return jsonResponse(
      {
        error: error.message || 'Unable to update user settings.'
      },
      Number.isInteger(error.status) ? error.status : 500
    )
  }
}
