function jsonResponse(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        'Content-Type':
          'application/json; charset=utf-8',

        'Cache-Control':
          'no-store'
      }
    }
  )
}

class RequestError extends Error {
  constructor(message, status = 500) {
    super(message)
    this.status = status
  }
}

function getBearerToken(request) {
  const authorization =
    request.headers.get(
      'Authorization'
    )

  if (
    !authorization ||
    !authorization.startsWith(
      'Bearer '
    )
  ) {
    return null
  }

  return authorization
    .slice('Bearer '.length)
    .trim()
}

function normalizeEmail(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase()
    : ''
}

function getRequiredEnvironment(
  context
) {
  const {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY
  } = context.env

  if (
    !SUPABASE_URL ||
    !SUPABASE_ANON_KEY ||
    !SUPABASE_SERVICE_ROLE_KEY
  ) {
    throw new RequestError(
      'Supabase environment variables are incomplete.',
      500
    )
  }

  return {
    supabaseUrl:
      SUPABASE_URL.endsWith('/')
        ? SUPABASE_URL.slice(0, -1)
        : SUPABASE_URL,

    anonKey:
      SUPABASE_ANON_KEY,

    serviceRoleKey:
      SUPABASE_SERVICE_ROLE_KEY
  }
}

async function parseResponse(
  response
) {
  const responseText =
    await response.text()

  if (!responseText) {
    return null
  }

  try {
    return JSON.parse(responseText)
  } catch {
    return responseText
  }
}

function getResponseError(
  data,
  fallback
) {
  if (
    data &&
    typeof data === 'object'
  ) {
    return (
      data.message ||
      data.error ||
      fallback
    )
  }

  if (
    typeof data === 'string' &&
    data.trim()
  ) {
    return data
  }

  return fallback
}

async function serviceRequest(
  url,
  serviceRoleKey,
  options = {}
) {
  const response =
    await fetch(
      url,
      {
        ...options,

        headers: {
          apikey:
            serviceRoleKey,

          Authorization:
            `Bearer ${serviceRoleKey}`,

          ...(options.headers || {})
        }
      }
    )

  const data =
    await parseResponse(response)

  if (!response.ok) {
    throw new RequestError(
      getResponseError(
        data,
        'Supabase request failed.'
      ),
      response.status
    )
  }

  return data
}

async function requireAdmin(
  context
) {
  const accessToken =
    getBearerToken(
      context.request
    )

  if (!accessToken) {
    throw new RequestError(
      'Authentication required.',
      401
    )
  }

  const {
    supabaseUrl,
    anonKey,
    serviceRoleKey
  } = getRequiredEnvironment(
    context
  )

  const userResponse =
    await fetch(
      `${supabaseUrl}/auth/v1/user`,
      {
        headers: {
          apikey:
            anonKey,

          Authorization:
            `Bearer ${accessToken}`
        }
      }
    )

  const authenticatedUser =
    await parseResponse(
      userResponse
    )

  if (!userResponse.ok) {
    throw new RequestError(
      'Your session is invalid or has expired.',
      401
    )
  }

  const authenticatedEmail =
    normalizeEmail(
      authenticatedUser?.email
    )

  if (!authenticatedEmail) {
    throw new RequestError(
      'The authenticated account has no email address.',
      401
    )
  }

  const permissionUrl =
    new URL(
      `${supabaseUrl}/rest/v1/login`
    )

  permissionUrl.searchParams.set(
    'select',
    'is_admin'
  )

  permissionUrl.searchParams.set(
    'email',
    `eq.${authenticatedEmail}`
  )

  permissionUrl.searchParams.set(
    'limit',
    '1'
  )

  const permissionRows =
    await serviceRequest(
      permissionUrl.toString(),
      serviceRoleKey
    )

  if (
    !Array.isArray(permissionRows) ||
    permissionRows[0]
      ?.is_admin !== true
  ) {
    throw new RequestError(
      'Administrator access required.',
      403
    )
  }

  return {
    supabaseUrl,
    serviceRoleKey
  }
}

async function getLoginUsers(
  supabaseUrl,
  serviceRoleKey
) {
  const usersUrl =
    new URL(
      `${supabaseUrl}/rest/v1/login`
    )

  usersUrl.searchParams.set(
    'select',
    'name,email,is_admin,can_edit_articles'
  )

  usersUrl.searchParams.set(
    'order',
    'name.asc.nullslast,email.asc'
  )

  const users =
    await serviceRequest(
      usersUrl.toString(),
      serviceRoleKey
    )

  return Array.isArray(users)
    ? users
    : []
}

async function getSystemOwnerEmail(
  supabaseUrl,
  serviceRoleKey
) {
  const ownerUrl = new URL(`${supabaseUrl}/rest/v1/profiles`)
  ownerUrl.searchParams.set('select', 'email')
  ownerUrl.searchParams.set('is_system_admin', 'eq.true')
  ownerUrl.searchParams.set('limit', '1')

  const owners = await serviceRequest(ownerUrl.toString(), serviceRoleKey)
  return normalizeEmail(Array.isArray(owners) ? owners[0]?.email : '')
}

async function getWorkforceProfiles(supabaseUrl, serviceRoleKey) {
  const url = new URL(`${supabaseUrl}/rest/v1/profiles`)
  url.searchParams.set('select', 'user_id,employee_id,email,base_role,account_deleted_at')
  url.searchParams.set('account_deleted_at', 'is.null')
  const rows = await serviceRequest(url.toString(), serviceRoleKey)
  return Array.isArray(rows) ? rows : []
}

async function getArticlePermissions(supabaseUrl, serviceRoleKey) {
  const url = new URL(`${supabaseUrl}/rest/v1/user_permissions`)
  url.searchParams.set('select', 'user_id,is_granted')
  url.searchParams.set('permission_key', 'eq.edit_articles')
  const rows = await serviceRequest(url.toString(), serviceRoleKey)
  return new Map((Array.isArray(rows) ? rows : []).map(row => [row.user_id, row.is_granted === true]))
}

async function getAuthUsers(
  supabaseUrl,
  serviceRoleKey
) {
  const allUsers = []
  const perPage = 1000
  let page = 1

  while (true) {
    const usersUrl =
      new URL(
        `${supabaseUrl}/auth/v1/admin/users`
      )

    usersUrl.searchParams.set(
      'page',
      String(page)
    )

    usersUrl.searchParams.set(
      'per_page',
      String(perPage)
    )

    const result =
      await serviceRequest(
        usersUrl.toString(),
        serviceRoleKey
      )

    const users =
      Array.isArray(result?.users)
        ? result.users
        : []

    allUsers.push(...users)

    if (users.length < perPage) {
      break
    }

    page += 1
  }

  return allUsers
}

function getDisplayName(
  loginUser,
  email
) {
  const storedName =
    typeof loginUser?.name ===
      'string'
      ? loginUser.name.trim()
      : ''

  if (storedName) {
    return storedName
  }

  return email.includes('@')
    ? email.split('@')[0]
    : email
}

export async function onRequestGet(
  context
) {
  try {
    const {
      supabaseUrl,
      serviceRoleKey
    } = await requireAdmin(
      context
    )

    const [
      loginUsers,
      authUsers,
      systemOwnerEmail,
      profiles,
      articlePermissions
    ] = await Promise.all([
      getLoginUsers(
        supabaseUrl,
        serviceRoleKey
      ),

      getAuthUsers(
        supabaseUrl,
        serviceRoleKey
      ),

      getSystemOwnerEmail(
        supabaseUrl,
        serviceRoleKey
      ),
      getWorkforceProfiles(supabaseUrl, serviceRoleKey),
      getArticlePermissions(supabaseUrl, serviceRoleKey)
    ])

    const authUsersByEmail =
      new Map()

    const profilesByEmail = new Map(
      profiles.map(profile => [normalizeEmail(profile.email), profile])
    )

    authUsers.forEach(authUser => {
      const email =
        normalizeEmail(
          authUser.email
        )

      if (email) {
        authUsersByEmail.set(
          email,
          authUser
        )
      }
    })

    const users =
      loginUsers
        .filter(loginUser => normalizeEmail(loginUser.email) !== systemOwnerEmail)
        .map(loginUser => {
        const email =
          normalizeEmail(
            loginUser.email
          )

        const authUser =
          authUsersByEmail.get(
            email
          )

        const profile = profilesByEmail.get(email)
        const canonicalAdmin = profile?.base_role === 'admin'
        const canonicalEditor = profile
          ? articlePermissions.get(profile.user_id) === true
          : false
        const parityIssues = []
        if (!profile) parityIssues.push('Missing profile')
        if (!authUser) parityIssues.push('Missing Auth')
        if (profile && loginUser.is_admin === true !== canonicalAdmin) parityIssues.push('Admin mismatch')
        if (profile && loginUser.can_edit_articles === true !== canonicalEditor) parityIssues.push('Editor mismatch')

        return {
          employee_id: profile?.employee_id || 'Missing profile',

          name:
            getDisplayName(
              loginUser,
              email
            ),

          email,

          is_admin:
            loginUser.is_admin ===
            true,

          can_edit_articles:
            loginUser
              .can_edit_articles ===
            true,

          parity_ok: parityIssues.length === 0,
          parity_issue: parityIssues.join(', ')
        }
      })

    return jsonResponse({
      success: true,
      users
    })
  } catch (error) {
    console.error(
      'List-users function error:',
      error
    )

    return jsonResponse(
      {
        error:
          error.message ||
          'Unable to load users.'
      },
      Number.isInteger(error.status)
        ? error.status
        : 500
    )
  }
}
